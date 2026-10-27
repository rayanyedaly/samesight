import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { accessTokenHook, at, claimFindings, planClaims, remoteHook, type RuleSql } from "./claims.ts";

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

  it("gives the generator every column compared with the user id, in any spelling", () => {
    expect(plan.identityColumns).toEqual(["author", "owner_id"]);
  });

  it("keeps what it cannot follow, by rule", () => {
    expect(plan.unreadable).toEqual([{ where: 'policy "path" on docs (USING)', text: expect.stringContaining("#>>"), reason: "reads a #>> path" }]);
  });

  it("reads through a policy's SQL wrapper function", () => {
    const wrapped = planClaims([policy('policy "w" on docs (USING)', "(app_role() = 'ADMIN'::text)")], new Map([["app_role", "select nullif(auth.jwt() ->> 'app_role', '')"]]));
    expect(wrapped.uses.map((u) => u.key)).toEqual(["app_role"]);
  });
});

describe("claimFindings", () => {
  const plan = planClaims(RULES);
  const details = (f: ReturnType<typeof claimFindings>) => f.map((x) => `${x.status} ${x.detail}`);

  it("says what each claim means for the run, and warns on every read it cannot give or follow", () => {
    const lines = details(claimFindings(plan, undefined));
    expect(lines).toEqual([
      expect.stringMatching(/^warn aal: read by policy "mfa" on docs \(USING\), compared with 'aal2'; every run user is a password user at aal1/),
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
      /added by the access token hook pg-functions:\/\/postgres\/public\/custom_access_token_hook; users signed in before any rows were generated, so every token carries the same value \(u0: null, u1: null\)\. Rules that read it are tested for that value only; steering hook claims is planned \(B3b\)$/,
    );
    const none = details(claimFindings(plan, undefined, same)).find((l) => l.includes("app_role"));
    expect(none).toMatch(/no run user's token carries it \(and supabase\/config\.toml enables no access token hook\), so every user reads it as null$/);
    const differ = details(claimFindings(plan, hook, new Map([["u0", { app_role: "ADMIN" }], ["u1", { app_role: "VIEWER" }]]))).find((l) => l.includes("app_role"));
    expect(differ).toMatch(/\(u0: "ADMIN", u1: "VIEWER"\); audit does not choose these values/);
  });

  it("warns about a hook that runs off this machine", () => {
    expect(details(claimFindings(plan, { uri: "https://hooks.example.com/claims" }))[0]).toMatch(/^warn the access token hook https:\/\/hooks\.example\.com\/claims is not on this machine/);
    expect(remoteHook("http://127.0.0.1:3000/hook")).toBe(false);
    expect(remoteHook("pg-functions://postgres/public/hook")).toBe(false);
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
