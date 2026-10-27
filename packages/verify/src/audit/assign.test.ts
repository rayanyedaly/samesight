import { type ClaimValue, parseSyncConfig } from "samesight/compiler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimLabel } from "../differential/run.ts";
import type { TableModel } from "../differential/model.ts";
import { createUsers, signIn } from "../differential/users.ts";
import type { Stack } from "../stack.ts";
import { assignClaims, fitsType, metadataOf, otherValue, pickCombinations, show } from "./assign.ts";
import { claimFindings, planClaims, type RuleSql, syncRules } from "./claims.ts";

const policy = (where: string, sql: string): RuleSql => ({ where, sql, dialect: "postgres" });
const role = (where: string, value: string) => policy(where, `(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = '${value}'::text)`);
const claim = (key: string, compared: string) => `(((auth.jwt() -> 'app_metadata'::text) ->> '${key}'::text) ${compared})`;
let n = 0;
const fresh = () => `5a3e5a3e-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const keys = (users: Map<string, unknown>[]) => users.map((u) => Object.fromEntries(u));

describe("assignClaims", () => {
  it("leaves a run whose rules read no metadata as it was: four users holding nothing", () => {
    const a = assignClaims(planClaims([policy("owner", "(owner_id = auth.uid())")]), fresh);
    expect(a.paths).toEqual([]);
    expect(keys(a.users)).toEqual([{}, {}, {}, {}]);
    expect(a.findings).toEqual([]);
  });

  it("gives every value and every combination, then a copy of the first user and one with none", () => {
    const a = assignClaims(planClaims([role("a", "admin"), role("e", "editor"), policy("f", claim("beta", "= 'on'::text"))]), fresh);
    expect(a.paths.map((p) => [p.key, p.pool])).toEqual([
      ["app_metadata.beta", ["on", "samesight-other"]],
      ["app_metadata.role", ["admin", "editor", "samesight-other"]],
    ]);
    expect(a.users).toHaveLength(8);
    const combos = new Set(a.users.slice(0, 6).map((u) => JSON.stringify([...u])));
    expect(combos.size).toBe(6);
    expect(a.users[6]).toEqual(a.users[0]);
    expect(a.users[7]?.size).toBe(0);
    expect(a.findings).toEqual([]);
  });

  it("signs up at least four users, two of them sharing claims", () => {
    const a = assignClaims(planClaims([policy("flag", claim("on", "IS TRUE"))]), fresh);
    expect(a.paths.map((p) => p.pool)).toEqual([[true, false]]);
    expect(keys(a.users)).toEqual([{ "app_metadata.on": true }, { "app_metadata.on": false }, { "app_metadata.on": true }, {}]);
  });

  it("warns when the users cannot hold every combination, yet holds every value while each pool fits", () => {
    const rules = ["a", "b", "c"].map((k) => policy(k, claim(k, "= ANY (ARRAY['x'::text, 'y'::text])")));
    const a = assignClaims(planClaims(rules), fresh);
    expect(a.users).toHaveLength(8);
    for (const p of a.paths) for (const v of p.pool) expect(a.users.some((u) => u.get(p.key) === v), `${p.key}=${v}`).toBe(true);
    expect(a.findings).toEqual([expect.objectContaining({ status: "warn", detail: expect.stringMatching(/^27 combinations of claim values, and 8 users hold \d of them/) })]);
  });

  it("names the values no user holds when a pool is wider than the users", () => {
    const values = ["a", "b", "c", "d", "e", "f", "g"].map((v) => `'${v}'::text`).join(", ");
    const a = assignClaims(planClaims([policy("p", claim("tier", `= ANY (ARRAY[${values}])`))]), fresh);
    // One claim: no combination to miss, only values.
    expect(a.findings).toEqual([{ status: "warn", check: "claims", detail: "8 users cannot hold every value: no user holds app_metadata.tier=g, app_metadata.tier=samesight-other" }]);
  });

  it("gives the other value a type every cast takes, or none", () => {
    expect(otherValue(["5a3e5a3e-0000-4000-8000-000000000000"], ["uuid"], () => "fresh")).toBe("fresh");
    expect(otherValue([3, 7], ["integer"], fresh)).toBe(8);
    expect(otherValue([], ["integer"], fresh)).toBe(1);
    expect(otherValue([true, false], ["boolean"], fresh)).toBeUndefined();
    expect(otherValue(["2026-01-01"], ["timestamp with time zone"], fresh)).toBeUndefined();
    expect(otherValue(["x"], ["text"], fresh)).toBe("samesight-other");
    // The cast decides, not a literal of another type a stream compares; casts that disagree give none.
    expect(otherValue([1, true], ["boolean"], fresh)).toBe(false);
    expect(otherValue([1], ["boolean", "integer"], fresh)).toBeUndefined();
    const a = assignClaims(planClaims([policy("org", "((((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text))::uuid = '5a3e5a3e-0000-4000-8000-00000000000a'::uuid)")]), () => "fresh-uuid");
    expect(a.paths[0]?.pool).toEqual(["5a3e5a3e-0000-4000-8000-00000000000a", "fresh-uuid"]);
  });

  it("sets nothing at a path it cannot give a value, and says why", () => {
    const a = assignClaims(
      planClaims([
        policy("org", "(org_id = (((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text))::uuid)"),
        policy("lower", "(lower(((auth.jwt() -> 'app_metadata'::text) ->> 'team'::text)) = 'a'::text)"),
        policy("deep", "((((auth.jwt() -> 'app_metadata'::text) -> 'plan'::text) ->> 'tier'::text) = 'pro'::text)"),
        policy("flat", "(((auth.jwt() -> 'app_metadata'::text) ->> 'plan'::text) = 'basic'::text)"),
      ]),
      fresh,
    );
    expect(a.paths).toEqual([]);
    expect(Object.fromEntries(a.notSet)).toEqual({
      "app_metadata.org_id": "it is compared only with column org_id, and no generated row can hold its values: org_id (no generated table has it)",
      "app_metadata.team": expect.stringMatching(/^a rule uses it as lower\(/),
      "app_metadata.plan": "rules also read app_metadata.plan.tier, so audit cannot give users a value at both",
      "app_metadata.plan.tier": "rules also read app_metadata.plan, so audit cannot give users a value at both",
    });
    expect(keys(a.users)).toEqual([{}, {}, {}, {}]);
  });

  it("holds as many combinations and pairs as the users can when they cannot hold all", () => {
    const flags = pickCombinations([2, 2, 2], 6);
    expect(new Set(flags.map((c) => c.join())).size).toBe(6);
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      expect(new Set(flags.map((c) => `${c[p]}${c[q]}`)), `paths ${p} and ${q}`).toEqual(new Set(["00", "01", "10", "11"]));
    }
    expect(pickCombinations([2, 3], 6)).toHaveLength(6);
    expect(new Set(pickCombinations([3, 3, 3], 6).flatMap((c) => c.map((d, p) => `${p}:${d}`))).size).toBe(9);
  });

  it("does not take a null literal for a value when the other comparisons are with a column", () => {
    const a = assignClaims(planClaims([policy("n", claim("org", "IS NULL")), policy("c", "(org_id = (((auth.jwt() -> 'app_metadata'::text) ->> 'org'::text))::uuid)")]), fresh);
    expect(a.paths).toEqual([]);
    expect(a.notSet.get("app_metadata.org")).toMatch(/^it is compared only with column org_id, and no generated row can hold/);
  });

  it("keeps null out of the pool: the user with no claims shows it", () => {
    const a = assignClaims(planClaims([policy("b", claim("blocked", "IS NULL"))]), fresh);
    expect(a.paths[0]?.pool).toEqual(["samesight-other"]);
  });
});

describe("metadataOf", () => {
  it("nests each value at its path, and leaves out what a user does not hold", () => {
    const paths = [
      { path: ["app_metadata", "role"], key: "app_metadata.role", pool: [] },
      { path: ["app_metadata", "plan", "tier"], key: "app_metadata.plan.tier", pool: [] },
      { path: ["user_metadata", "team"], key: "user_metadata.team", pool: [] },
    ];
    expect(
      metadataOf(
        paths,
        new Map<string, ClaimValue>([
          ["app_metadata.role", "admin"],
          ["app_metadata.plan.tier", 2],
        ]),
      ),
    ).toEqual({ app_metadata: { role: "admin", plan: { tier: 2 } } });
    expect(metadataOf(paths, new Map())).toEqual({});
  });
});

describe("claimLabel", () => {
  it("labels a user by what its token carries, and bare when it carries nothing", () => {
    const paths = [
      ["app_metadata", "org_id"],
      ["app_metadata", "role"],
    ];
    expect(claimLabel("u1", { app_metadata: { role: "editor", org_id: null } }, paths)).toBe("u1 (app_metadata.role=editor)");
    expect(claimLabel("u2", { app_metadata: { role: 3, org_id: "x" } }, paths)).toBe("u2 (app_metadata.org_id=x, app_metadata.role=3)");
    expect(claimLabel("u3", { app_metadata: {} }, paths)).toBe("u3");
    expect(claimLabel("u0", {}, [])).toBe("u0");
    // 3 and '3' are both tried, and told apart.
    expect(claimLabel("u4", { app_metadata: { role: "3" } }, paths)).toBe('u4 (app_metadata.role="3")');
    expect(claimLabel("u5", { "app_metadata.role": "x" }, [["app_metadata.role"]])).toBe('u5 ("app_metadata.role"=x)');
    expect([show("editor"), show("3"), show(3), show("true"), show(null)]).toEqual(["editor", '"3"', "3", '"true"', "null"]);
  });
});

describe("the Claims section with users holding values", () => {
  const plan = planClaims([role("a", "admin"), role("e", "editor")]);
  const a = assignClaims(plan, fresh);
  const token = (r?: string) => (r ? { app_metadata: { role: r } } : { app_metadata: {} });

  it("says who holds each value, from the tokens", () => {
    const tokens = new Map([
      ["u0", token("admin")],
      ["u1", token("editor")],
      ["u2", token("samesight-other")],
      ["u3", token("admin")],
      ["u4", token()],
    ]);
    expect(claimFindings(plan, undefined, tokens, a)).toEqual([
      { status: "ok", check: "claims", detail: "app_metadata.role: read by 2 rules (a; e), compared with 'admin', 'editor'; held: admin u0 u3, editor u1, samesight-other u2, none u4" },
    ]);
  });

  it("warns when a token does not carry what audit gave its user", () => {
    const tokens = new Map([
      ["u0", token("admin")],
      ["u1", token("member")],
      ["u2", token("samesight-other")],
      ["u3", token("admin")],
      ["u4", token()],
    ]);
    const lines = claimFindings(plan, undefined, tokens, a).map((f) => `${f.status} ${f.detail}`);
    expect(lines).toEqual([
      "warn app_metadata.role: read by 2 rules (a; e), compared with 'admin', 'editor'; held: admin u0 u3, editor (nobody), samesight-other u2, member u1, none u4",
      expect.stringMatching(/^warn u1 was given app_metadata\.role="editor", but its token carries "member"/),
    ]);
  });

  it("warns that a comparison with a column is not steered when the path also has literals", () => {
    const mixed = planClaims([role("a", "admin"), policy("c", "(team = ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text))")]);
    const [line] = claimFindings(mixed, undefined, undefined, assignClaims(mixed, fresh));
    expect(line).toMatchObject({ status: "warn", detail: expect.stringMatching(/\(not run: --static\); not in team \(no generated table has it\)$/) });
  });

  it("says what a full run would give under --static", () => {
    expect(claimFindings(plan, undefined, undefined, a)[0]?.detail).toMatch(/; a full run gives users 'admin', 'editor', 'samesight-other', and one user none of them \(not run: --static\)$/);
  });
});

describe("Auth's rate limit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const stack = { api: "http://127.0.0.1:1", publishableKey: "p", secretKey: "s" } as Stack;

  it("names the config.toml setting to raise at sign-in, and keeps Auth's own words elsewhere", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"msg":"rate limited"}', { status: 429 }));
    await expect(signIn(stack, "u@x", "pw")).rejects.toThrow(/429 \{"msg":"rate limited"\}\. That is Supabase Auth's sign-in rate limit.*raise \[auth\.rate_limit\] sign_in_sign_ups in supabase\/config\.toml/);
    await expect(createUsers(stack, 1, "r")).rejects.toThrow(/^Auth POST \/admin\/users: 429 \{"msg":"rate limited"\}$/);
  });

  it("sends each user's metadata in the create body", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: `id${bodies.length}` }), { status: 200 });
    });
    await createUsers(stack, 2, "r", [{ app_metadata: { role: "admin" } }]);
    expect(bodies).toEqual([
      expect.objectContaining({ app_metadata: { role: "admin" }, email_confirm: true }),
      expect.not.objectContaining({ app_metadata: expect.anything() }),
    ]);
  });
});

describe("claims compared with columns", () => {
  const col = (name: string, type: string, more: object = {}) => ({ name, type, nullable: false, hasDefault: false, computed: false, hints: [], ...more });
  const model: TableModel[] = [
    { name: "orgs", primaryKey: ["id"], unique: ["id"], columns: [col("id", "uuid"), col("name", "text"), col("seats", "integer"), col("code", "character varying(3)")], foreignKeys: [] },
    {
      name: "documents",
      primaryKey: ["id"],
      unique: ["id"],
      columns: [col("id", "uuid"), col("org_id", "uuid"), col("owner_id", "uuid"), col("status", "text", { values: ["draft", "published", "archived"] }), col("team", "text")],
      foreignKeys: [
        { columns: ["org_id"], schema: "public", table: "orgs", references: ["id"] },
        { columns: ["owner_id"], schema: "auth", table: "users", references: ["id"] },
      ],
    },
  ];
  const on = (table: string, sql: string): RuleSql => ({ where: `policy on ${table}`, sql, dialect: "postgres", table });
  const read = (key: string, cast = "") => `((auth.jwt() -> 'app_metadata'::text) ->> '${key}'::text)${cast}`;

  it("gives an org claim two run uuids, which the referenced table's first rows take as keys", () => {
    const plan = planClaims([on("documents", `(org_id = (${read("org_id")})::uuid)`), on("orgs", `(id = (${read("org_id")})::uuid)`)]);
    const a = assignClaims(plan, fresh, model);
    const [org] = a.paths;
    expect(org).toMatchObject({ key: "app_metadata.org_id", columns: ["orgs.id"], skipped: [] });
    expect(org?.pool).toHaveLength(2);
    expect(org?.pool.every((v) => String(v).startsWith("5a3e5a3e-"))).toBe(true);
    // documents.id is not compared with the claim: only orgs' rules compare an id.
    expect(a.keyPools).toEqual(new Map([["orgs", { column: "id", values: org?.pool }]]));
    expect(a.claimValues).toEqual(new Map());
    expect(a.users).toHaveLength(4);
  });

  it("draws a plain column's values from its CHECK list, and leaves out keys to auth.users and other types", () => {
    const plan = planClaims([
      on("documents", `(status = ${read("stage")})`),
      on("documents", `(owner_id = (${read("delegate")})::uuid)`),
      on("documents", `(team = (${read("team_id")})::uuid)`),
    ]);
    const a = assignClaims(plan, fresh, model);
    expect(a.paths.map((p) => [p.key, p.pool, p.columns])).toEqual([["app_metadata.stage", ["draft", "published"], ["documents.status"]]]);
    expect(a.claimValues).toEqual(new Map([["documents", new Map([["status", ["draft", "published"]]])]]));
    expect(Object.fromEntries(a.notSet)).toEqual({
      "app_metadata.delegate": "it is compared only with column owner_id, and no generated row can hold its values: documents.owner_id (a key to auth.users: not given run user ids yet)",
      "app_metadata.team_id": "it is compared only with column team, and no generated row can hold its values: documents.team (text, which the rules do not cast the claim to)",
    });
  });

  it("puts a literal-compared claim's values in the columns it is also compared with", () => {
    const plan = planClaims([on("documents", `(${read("stage")} = 'published'::text)`), on("documents", `(status = ${read("stage")})`)]);
    const a = assignClaims(plan, fresh, model);
    expect(a.paths.map((p) => [p.pool, p.columns])).toEqual([[["published", "samesight-other"], ["documents.status"]]]);
    // samesight-other is not in status's CHECK list: rows could not hold it.
    expect(a.claimValues.get("documents")?.get("status")).toEqual(["published"]);
  });

  // As syncRules gives them: the output table, and every table the query names.
  const stream = (table: string, sql: string): RuleSql => ({ where: `${table} stream`, sql, dialect: "streams", table, tables: [...new Set([table, ...(/JOIN (\w+)/i.exec(sql)?.slice(1) ?? [])])] });

  it("takes a joined column's table from its qualifier", () => {
    const plan = planClaims([
      stream("documents", "SELECT documents.* FROM documents INNER JOIN orgs ON orgs.id = documents.org_id WHERE orgs.id = auth.parameter('app_metadata') ->> 'org_id'"),
    ]);
    expect(plan.uses.find((u) => u.key === "app_metadata.org_id")?.columnTables).toEqual({ id: ["orgs"] });
    expect(assignClaims(plan, fresh, model).keyPools.get("orgs")?.column).toBe("id");
  });

  it("gives an uncast claim's values only to columns of the first column's type", () => {
    const plan = planClaims([stream("orgs", "SELECT * FROM orgs WHERE seats = auth.parameter('app_metadata') ->> 'o'"), stream("documents", "SELECT * FROM documents WHERE org_id = auth.parameter('app_metadata') ->> 'o'")]);
    const [path] = assignClaims(plan, fresh, model).paths;
    expect(path).toMatchObject({ pool: [101, 102], columns: ["orgs.seats"], skipped: ["orgs.id (uuid, unlike orgs.seats)"] });
  });

  it("never keys every table's id when the rule's table is unknown, and keeps values within a column's length", () => {
    const sub = planClaims([{ where: "w", sql: `(EXISTS ( SELECT 1 FROM public.orgs o WHERE (o.id = (${read("org_id")})::uuid)))`, dialect: "postgres" }]);
    expect(assignClaims(sub, fresh, model).keyPools).toEqual(new Map());
    const short = planClaims([on("orgs", `(code = ${read("code")})`)]);
    expect(assignClaims(short, fresh, model).paths[0]).toMatchObject({ pool: ["ss-a", "ss-b"], columns: [], skipped: ["orgs.code (character varying(3) takes none of the values)"] });
    expect([fitsType("ss-a", "character varying(4)"), fitsType("ss-a", "character varying(3)"), fitsType(3, "uuid"), fitsType("3", "integer"), fitsType("x", "text")]).toEqual([true, false, false, true, true]);
  });

  it("keys rows only with the run's own uuids, never a rule's literal, so cleanup finds them", () => {
    const literal = "11111111-2222-4333-8444-555555555555";
    const plan = planClaims([on("documents", `(org_id = (${read("org_id")})::uuid)`), on("orgs", `((${read("org_id")})::uuid = '${literal}'::uuid)`)]);
    const a = assignClaims(plan, fresh, model);
    expect(a.paths[0]?.pool).toContain(literal);
    expect(a.keyPools.get("orgs")?.values).not.toContain(literal);
    expect(a.keyPools.get("orgs")?.values).toHaveLength(1);
  });

  it("reads an alias as the query's one table, and skips composite keys and types it has no values for", () => {
    const aliased = planClaims([
      { where: "s", sql: "SELECT * FROM documents d WHERE d.org_id = auth.parameter('app_metadata') ->> 'org_id'", dialect: "streams", tables: ["documents"] },
    ]);
    expect(aliased.uses.find((u) => u.key === "app_metadata.org_id")?.columnTables).toEqual({ org_id: ["documents"] });
    const wide: TableModel[] = [
      ...model,
      {
        name: "pins",
        primaryKey: ["id"],
        unique: ["id"],
        columns: [col("id", "uuid"), col("org_id", "uuid"), col("site", "uuid"), col("shape", "geometry")],
        foreignKeys: [{ columns: ["org_id", "site"], schema: "public", table: "sites", references: ["org_id", "id"] }],
      },
    ];
    const plan = planClaims([on("pins", `(site = (${read("site")})::uuid)`), on("pins", `(shape = ${read("shape")})`)]);
    const a = assignClaims(plan, fresh, wide);
    expect(Object.fromEntries(a.notSet)).toEqual({
      "app_metadata.shape": expect.stringContaining("pins.shape (geometry, which audit generates no claim values for)"),
      "app_metadata.site": expect.stringContaining("pins.site (part of a composite foreign key"),
    });
  });

  it("resolves a join's alias, names a rule's literal no key takes, and keeps values a column refuses out", () => {
    const joined = planClaims(
      syncRules(parseSyncConfig("config:\n  edition: 3\nstreams:\n  s:\n    auto_subscribe: true\n    queries:\n      - SELECT documents.* FROM documents INNER JOIN orgs o ON documents.org_id = o.id WHERE o.id = auth.parameter('app_metadata') ->> 'org'\n")),
    );
    expect(joined.uses.find((u) => u.key === "app_metadata.org")?.columnTables).toEqual({ id: ["orgs"] });
    const literal = "11111111-2222-4333-8444-555555555555";
    const plan = planClaims([on("documents", `(org_id = (${read("org_id")})::uuid)`), on("orgs", `((${read("org_id")})::uuid = '${literal}'::uuid)`)]);
    expect(assignClaims(plan, fresh, model).paths[0]?.skipped).toEqual([`orgs.id for ${literal} (a key takes only fresh run uuids, so cleanup finds its rows)`]);
    expect([fitsType(1.5, "integer"), fitsType(2, "integer"), fitsType(1.5, "numeric"), fitsType("ss-a", "jsonb")]).toEqual([false, true, true, false]);
  });
});
