import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { accessTokenHook, at, claimFindings, holders, planClaims, remoteHook, type RuleSql } from "./claims.ts";

const policy = (where: string, sql: string): RuleSql => ({ where, sql, dialect: "postgres" });
const stream = (where: string, sql: string): RuleSql => ({ where, sql, dialect: "streams" });

const RULES: RuleSql[] = [
  policy('policy "admins" on docs (USING)', "(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)"),
  policy('policy "editors" on docs (USING)', "(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['editor'::text, 'admin'::text]))"),
  policy('policy "org" on docs (USING)', "(org_id = (((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text))::uuid)"),
  policy('policy "owner" on docs (USING)', "(((auth.jwt() ->> 'sub'::text))::uuid = author)"),
  policy('policy "mfa" on docs (USING)', "((auth.jwt() ->> 'aal'::text) = 'aal2'::text)"),
  policy('policy "auth" on docs (USING)', "(auth.role() = 'authenticated'::text)"),
  policy('policy "hooked" on docs (USING)', "((auth.jwt() ->> 'app_role'::text) = 'ADMIN'::text)"),
  policy('policy "path" on docs (USING)', "((auth.jwt() #>> '{app_metadata,role}'::text[]) = 'x'::text)"),
  stream("docs.query", "SELECT * FROM docs WHERE auth.parameter('$.app_metadata.role') = 'admin' OR owner_id = auth.user_id()"),
];

describe("planClaims", () => {
  const plan = planClaims(RULES);

  it("groups reads by path, with the rules, values and columns of each, in a stable order", () => {
    expect(plan.uses.map((u) => [u.key, u.cls])).toEqual([
      ["aal", "auth-state"],
      ["app_metadata.org_id", "app_metadata"],
      ["app_metadata.role", "app_metadata"],
      ["app_role", "hook"],
      ["role", "shared"],
      ["sub", "identity"],
    ]);
    const role = plan.uses.find((u) => u.key === "app_metadata.role");
    expect(role?.values).toEqual(["admin", "editor"]);
    expect(role?.rules).toEqual(['policy "admins" on docs (USING)', 'policy "editors" on docs (USING)', "docs.query"]);
    expect(plan.uses.find((u) => u.key === "app_metadata.org_id")).toMatchObject({ columns: ["org_id"], casts: ["uuid"], values: [] });
  });

  it("gives the generator every column compared with the user id, in any spelling, subqueries included", () => {
    expect(plan.identityColumns).toEqual(["author", "owner_id"]);
    const member = planClaims([policy("m", "(EXISTS ( SELECT 1 FROM public.members m WHERE (m.user_id = ((auth.jwt() ->> 'sub'::text))::uuid)))")]);
    expect(member.identityColumns).toEqual(["user_id"]);
  });

  it("keeps what it cannot follow, by rule", () => {
    expect(plan.unreadable).toEqual([{ where: 'policy "path" on docs (USING)', text: expect.stringContaining("#>>"), reason: "reads a #>> path" }]);
  });

  it("keeps a top-level key with a dot apart from the nested path it spells", () => {
    const split = planClaims([
      stream("s.queries[0]", "SELECT * FROM docs WHERE auth.parameter('app_metadata.role') = 'admin'"),
      policy('policy "p" on docs (USING)', "(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)"),
    ]);
    expect(split.uses.map((u) => [u.key, u.cls, u.rules])).toEqual([
      ['"app_metadata.role"', "hook", ["s.queries[0]"]],
      ["app_metadata.role", "app_metadata", ['policy "p" on docs (USING)']],
    ]);
  });

  it("reads through a policy's SQL wrapper function", () => {
    const wrapped = planClaims([policy('policy "w" on docs (USING)', "(app_role() = 'ADMIN'::text)")], new Map([["app_role", "select nullif(auth.jwt() ->> 'app_role', '')"]]));
    expect(wrapped.uses.map((u) => u.key)).toEqual(["app_role"]);
  });

  it("takes a claim Supabase Auth leaves out of a password user's token as the hook's when the project enables one", () => {
    const rules = [policy("p", "(org_id = ((auth.jwt() ->> 'client_id'::text))::uuid)"), policy("q", "((auth.jwt() ->> 'aal'::text) = 'aal2'::text)")];
    expect(planClaims(rules).uses.map((u) => [u.key, u.cls])).toEqual([["aal", "auth-state"], ["client_id", "auth-state"]]);
    expect(planClaims(rules, new Map(), { hook: true }).uses.map((u) => [u.key, u.cls])).toEqual([["aal", "auth-state"], ["client_id", "hook"]]);
    // A user made by signing up carries user_metadata.email: not only a hook could add it.
    const email = [policy("e", "((auth.jwt() -> 'user_metadata'::text) ->> 'email'::text) = email")];
    expect(planClaims(email, new Map(), { hook: true }).uses.map((u) => u.cls)).toEqual(["auth-state"]);
  });
});

describe("claimFindings", () => {
  const plan = planClaims(RULES);
  const details = (f: ReturnType<typeof claimFindings>) => f.map((x) => `${x.status} ${x.detail}`);

  it("says what each claim means for the run, and warns on every read it cannot give or follow", () => {
    const lines = details(claimFindings(plan, undefined));
    expect(lines).toEqual([
      expect.stringMatching(/^warn aal: read by policy "mfa" on docs \(USING\), compared with 'aal2'; every run user's token carries the same aal \(aal1: a password sign-in, no second factor\)/),
      expect.stringMatching(/^warn app_metadata\.org_id: read by policy "org" on docs \(USING\), compared with column org_id; run users do not carry app_metadata\.org_id, so every user reads it as null$/),
      expect.stringMatching(/^warn app_metadata\.role: read by 3 rules \(.*\), compared with 'admin', 'editor'; run users do not carry/),
      expect.stringMatching(/^warn app_role: .*no Supabase token carries it unless an access token hook adds it, and supabase\/config\.toml enables none$/),
      expect.stringMatching(/^ok role: read by policy "auth" on docs \(USING\), compared with 'authenticated'; every run user is authenticated/),
      expect.stringMatching(/^warn policy "path" on docs \(USING\) reads a #>> path: .*; audit cannot tell which claim or value it needs$/),
    ]);
  });

  it("describes a hook claim from the tokens once users have signed in", () => {
    const hook = { uri: "pg-functions://postgres/public/custom_access_token_hook" };
    const same = new Map([
      ["u0", { app_role: null }],
      ["u1", {}],
    ]);
    expect(details(claimFindings(plan, hook, same)).find((l) => l.includes("app_role"))).toMatch(
      /added by the access token hook pg-functions:\/\/postgres\/public\/custom_access_token_hook; every token carries the same value \(u0: null, u1: null\)\. Rules that read it are tested for that value only$/,
    );
    const none = details(claimFindings(plan, undefined, same)).find((l) => l.includes("app_role"));
    expect(none).toMatch(/no run user's token carries it \(and supabase\/config\.toml enables no access token hook\), so every user reads it as null$/);
    const differ = details(claimFindings(plan, hook, new Map([["u0", { app_role: "ADMIN" }], ["u1", { app_role: "VIEWER" }]]))).find((l) => l.includes("app_role"));
    expect(differ).toMatch(/\(u0: "ADMIN", u1: "VIEWER"\); audit does not choose these values/);
  });

  it("never calls a negated shared claim one that holds for every user", () => {
    const lines = details(claimFindings(planClaims([policy("p", "(auth.role() <> 'authenticated'::text)")]), undefined));
    expect(lines).toEqual([expect.stringMatching(/^warn role: .*compared with 'authenticated'; every run user carries the same role/)]);
  });

  it("words metadata from the tokens when they carry it, and per-user sign-in claims as such", () => {
    const meta = details(claimFindings(plan, undefined, new Map([["u0", { app_metadata: { role: "member" } }], ["u1", {}]]))).find((l) => l.includes("app_metadata.role"));
    expect(meta).toMatch(/; the run users' tokens carry it, though audit did not set it \(u0: "member", u1: null\)$/);
    const email = details(claimFindings(planClaims([policy("e", "(auth.email() = owner_email)")]), undefined));
    expect(email).toEqual([expect.stringMatching(/^warn email: .*compared with column owner_email; each run user has its own email \(an address at verify\.samesight\.test\), which audit does not choose or put in generated rows/)]);
  });

  it("says why audit cannot steer a hook claim, and what the tokens carry, with the hook's own warnings first", () => {
    const hook = { uri: "pg-functions://postgres/public/custom_access_token_hook" };
    const hookPlan = { uri: hook.uri, tables: [], cannot: "its body reads no public table", findings: [{ status: "warn" as const, check: "access token hook", detail: "the hook warns" }] };
    const tokens = new Map([
      ["u0", { app_role: "ADMIN" }],
      ["u1", { app_role: "ADMIN" }],
      ["u2", {}],
    ]);
    const lines = details(claimFindings(plan, hook, tokens, undefined, hookPlan));
    expect(lines[0]).toBe("warn the hook warns");
    expect(lines.find((l) => l.includes("app_role"))).toMatch(
      /; added by the access token hook pg-functions:\/\/postgres\/public\/custom_access_token_hook, which audit cannot give rows to \(its body reads no public table\); held: ADMIN u0 u1, none u2\. Rules that read it are tested for these values only$/,
    );
    expect(details(claimFindings(plan, hook, undefined, undefined, hookPlan)).find((l) => l.includes("app_role"))).toMatch(
      /which audit cannot give rows to \(its body reads no public table\)\. Rules that read it are tested only for the values run users' tokens carry$/,
    );
  });

  it("says who holds a claim the hook adds from rows audit gave, ok only when every value compared and another are held", () => {
    const hook = { uri: "pg-functions://postgres/public/custom_access_token_hook" };
    const hookPlan = { uri: hook.uri, tables: ["memberships"], findings: [], steer: { perUser: ["memberships"], summary: "the access token hook reads memberships: rows" } };
    const line = (tokens?: Map<string, Record<string, unknown>>) => claimFindings(plan, hook, tokens, undefined, hookPlan).find((f) => f.detail.startsWith("app_role"));
    expect(line()).toMatchObject({ status: "ok", detail: expect.stringMatching(/which reads memberships; a full run gives run users rows there before they sign in \(not run: --static\)$/) });
    const held = line(new Map([["u0", { app_role: "ADMIN" }], ["u1", { app_role: "VIEWER" }], ["u2", {}]]));
    expect(held).toMatchObject({ status: "ok", detail: expect.stringMatching(/from rows audit gives each run user in memberships before signing in; held: ADMIN u0, VIEWER u1, none u2$/) });
    const missing = line(new Map([["u0", { app_role: "VIEWER" }], ["u1", {}]]));
    expect(missing).toMatchObject({ status: "warn", detail: expect.stringMatching(/held: VIEWER u0, none u1; no token carries 'ADMIN'$/) });
    // The summary first, then a warning when rows differ and tokens do not.
    const all = details(claimFindings(plan, hook, new Map([["u0", {}], ["u1", {}]]), undefined, hookPlan));
    expect(all[0]).toBe("ok the access token hook reads memberships: rows");
    expect(all[1]).toMatch(/^warn every run user's token carries the same app_role, although audit gave them different memberships rows; the hook may not read them$/);
  });

  it("never prints an HTTP hook's user, password, path or query, in any Claims line", () => {
    const uri = "https://u:pw@hooks.example.com/hook/secret-path?key=k1";
    const hookPlan = { uri, tables: [], cannot: "it is an HTTP hook, which runs off this database", findings: [] };
    const text = details(claimFindings(plan, { uri }, new Map([["u0", { app_role: "ADMIN" }]]), undefined, hookPlan)).join("\n");
    expect(text).toContain("https://hooks.example.com/...");
    for (const secret of ["pw", "secret-path", "k1"]) expect(text).not.toContain(secret);
    // A hook claim with no plan and no tokens: added by the hook, values not chosen.
    expect(details(claimFindings(plan, { uri })).find((l) => l.includes("app_role"))).toMatch(/added by the access token hook https:\/\/hooks\.example\.com\/\.\.\., whose values audit does not choose$/);
  });

  it("warns about a hook that runs off this machine, printed without its secrets", () => {
    expect(details(claimFindings(plan, { uri: "https://hooks.example.com/claims" }))[0]).toMatch(/^warn the access token hook https:\/\/hooks\.example\.com\/\.\.\. is not on this machine/);
    expect(details(claimFindings(plan, { uri: "https://u:pw@hooks.example.com/claims?key=k" }))[0]).toMatch(/^warn the access token hook https:\/\/hooks\.example\.com\/\.\.\. is not/);
    expect(remoteHook("http://127.0.0.1:3000/hook")).toBe(false);
    expect(remoteHook("http://[::1]:3000/hook")).toBe(false);
    expect(remoteHook("https://[2001:db8::1]/hook")).toBe(true);
    expect(remoteHook("pg-functions://postgres/public/hook")).toBe(false);
  });

  it("tells token values apart as numbers only when the rules read the claim as one", () => {
    const tokens = new Map<string, Record<string, unknown>>([["u0", { level: 1 }], ["u1", { level: "1" }], ["u2", { level: "01" }], ["u3", {}]]);
    expect(holders(tokens, ["level"], undefined, true)).toBe("1 u0 u1 u2, none u3");
    expect(holders(tokens, ["level"])).toBe(`1 u0, "1" u1, "01" u2, none u3`);
  });

  it("says plainly when no rule reads a claim other than the user id", () => {
    expect(claimFindings(planClaims([policy("p", "(owner_id = auth.uid())")]), undefined)).toEqual([
      { status: "ok", check: "claims", detail: "no rule reads a token claim other than the user id" },
    ]);
  });
});

describe("accessTokenHook", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const project = (toml: string) => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-hook-"));
    dirs.push(dir);
    mkdirSync(join(dir, "supabase"));
    writeFileSync(join(dir, "supabase", "config.toml"), toml);
    return dir;
  };

  it("reads an enabled hook's uri, and nothing when it is off or absent", () => {
    expect(accessTokenHook(project('[auth.hook.custom_access_token]\nenabled = true\nuri = "pg-functions://postgres/public/hook"\n'))).toEqual({
      uri: "pg-functions://postgres/public/hook",
    });
    expect(accessTokenHook(project('[auth.hook.custom_access_token]\nenabled = false\nuri = "pg-functions://postgres/public/hook"\n'))).toBeUndefined();
    expect(accessTokenHook(project("[auth]\nenabled = true\n"))).toBeUndefined();
    expect(accessTokenHook(join(tmpdir(), "no-such-project"))).toBeUndefined();
  });
});

describe("at", () => {
  it("reads a path in decoded claims", () => {
    expect(at({ app_metadata: { role: "admin" } }, ["app_metadata", "role"])).toBe("admin");
    expect(at({ app_metadata: null }, ["app_metadata", "role"])).toBeUndefined();
    expect(at({}, ["x"])).toBeUndefined();
  });
});
