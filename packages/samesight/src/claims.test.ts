import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ClaimDialect, type ClaimRead, callsIn, claimReads, classify, wrapperRead } from "./claims.ts";
import { parseSyncConfig } from "./sync/config.ts";

/** The reads of one rule as [path, compared] pairs, for compact expectations. */
const reads = (sql: string, dialect: ClaimDialect, functions?: Map<string, string>) =>
  claimReads(sql, dialect, functions ? { functions } : {}).reads.map((r: ClaimRead) => ({
    path: r.path.join("."),
    compared: r.compared,
    ...(r.casts.length ? { casts: r.casts } : {}),
    ...(r.fallback !== undefined ? { fallback: r.fallback } : {}),
  }));

const lit = (values: unknown[], negated = false) => ({ kind: "literals", values, negated });
const col = (column: string, negated = false) => ({ kind: "column", column, negated });

// Policies as pg_policies prints them (captured from Postgres 17 for the same CREATE POLICY).
describe("claimReads on SQL it used to refuse or misread", () => {
  it("reads a policy with an array slice in it", () => {
    expect(reads("((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text) AND ((tags)[1:2] = ARRAY['a'::text]))", "postgres")).toEqual([
      { path: "app_metadata.role", compared: lit(["admin"]) },
    ]);
  });

  it("reads public.table.column as that table's column, and another schema's as no column of the run's", () => {
    expect(reads("(auth.uid() = public.lists.owner_id)", "postgres")).toEqual([{ path: "sub", compared: { ...col("owner_id"), qualifier: "lists" } }]);
    expect(reads("(auth.uid() = private.lists.owner_id)", "postgres")).toEqual([{ path: "sub", compared: { kind: "other", text: "private.lists.owner_id" } }]);
  });
});

describe("claimReads on Postgres policies", () => {
  it.each([
    ["(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)", [{ path: "app_metadata.role", compared: lit(["admin"]) }]],
    ["(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'editor'::text]))", [{ path: "app_metadata.role", compared: lit(["admin", "editor"]) }]],
    ["(org_id = (((auth.jwt() -> 'app_metadata'::text) ->> 'org_id'::text))::uuid)", [{ path: "app_metadata.org_id", compared: col("org_id"), casts: ["uuid"] }]],
    [
      "((( SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)) = 'editor'::text) AND (status = 'published'::text))",
      [{ path: "app_metadata.role", compared: lit(["editor"]) }],
    ],
    ["(owner_id = ( SELECT auth.uid() AS uid))", [{ path: "sub", compared: col("owner_id") }]],
    ["(((auth.jwt() ->> 'sub'::text))::uuid = owner_id)", [{ path: "sub", compared: col("owner_id"), casts: ["uuid"] }]],
    [
      "COALESCE((((auth.jwt() -> 'app_metadata'::text) ->> 'is_admin'::text))::boolean, false)",
      [{ path: "app_metadata.is_admin", compared: lit([true]), casts: ["boolean"], fallback: false }],
    ],
    ["((((current_setting('request.jwt.claims'::text, true))::json -> 'app_metadata'::text) ->> 'team'::text) = team)", [{ path: "app_metadata.team", compared: col("team") }]],
    // The ::jsonb is the whole token's; only the cast after the last key is the claim's.
    ["(((((current_setting('request.jwt.claims'::text, true))::jsonb -> 'app_metadata'::text) ->> 'level'::text))::integer <> 3)", [{ path: "app_metadata.level", compared: lit([3], true), casts: ["integer"] }]],
    [
      "((((auth.jwt() -> 'app_metadata'::text) -> 'level'::text) = '3'::jsonb) AND ((auth.jwt() ->> 'aal'::text) = 'aal2'::text))",
      [
        { path: "app_metadata.level", compared: lit([3]) },
        { path: "aal", compared: lit(["aal2"]) },
      ],
    ],
    ["(((auth.jwt() -> 'app_metadata'::text) ->> 'blocked'::text) IS NULL)", [{ path: "app_metadata.blocked", compared: lit([null]) }]],
    ["(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) <> ALL (ARRAY['a'::text, 'b'::text]))", [{ path: "app_metadata.role", compared: lit(["a", "b"], true) }]],
    ["(auth.role() = 'authenticated'::text)", [{ path: "role", compared: lit(["authenticated"]) }]],
    ["((auth.jwt() ->> 'tier'::text) = ('gold'::character varying)::text)", [{ path: "tier", compared: lit(["gold"]) }]],
    ["(owner_id = auth.uid())", [{ path: "sub", compared: col("owner_id") }]],
    ["(auth.uid() IN ( SELECT m.user_id FROM members m))", [{ path: "sub", compared: { kind: "other", text: "auth.uid() in (select m.user_id from members m)" } }]],
  ])("%s", (sql, expected) => {
    expect(reads(sql, "postgres")).toEqual(expected);
    expect(claimReads(sql, "postgres").unreadable).toEqual([]);
  });

  it.each([
    ["('admin'::text = ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text))", [{ path: "app_metadata.role", compared: lit(["admin"]) }]],
    ["(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) <> 'banned'::text)", [{ path: "app_metadata.role", compared: lit(["banned"], true) }]],
    ["(((auth.jwt() -> 'app_metadata'::text) ->> 'blocked'::text) IS NOT NULL)", [{ path: "app_metadata.blocked", compared: lit([null], true) }]],
    ["((((auth.jwt() -> 'app_metadata'::text) ->> 'staff'::text))::boolean IS FALSE)", [{ path: "app_metadata.staff", compared: lit([false]), casts: ["boolean"] }]],
    ["(((auth.jwt() -> 'app_metadata'::text) -> 'role'::text) = '\"admin\"'::jsonb)", [{ path: "app_metadata.role", compared: lit(["admin"]) }]],
    ["((((auth.jwt() -> 'app_metadata'::text) ->> 'level'::text))::integer = '3'::integer)", [{ path: "app_metadata.level", compared: lit([3]), casts: ["integer"] }]],
    ["(((auth.jwt() -> 'app_metadata'::text) ->> 'level'::text) = '-1'::text)", [{ path: "app_metadata.level", compared: lit(["-1"]) }]],
    ["(NOT (((auth.jwt() -> 'app_metadata'::text) ->> 'suspended'::text))::boolean)", [{ path: "app_metadata.suspended", compared: lit([true], true), casts: ["boolean"] }]],
    [
      "((owner_id = auth.uid()) OR (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text) OR (org_id = (((auth.jwt() -> 'app_metadata'::text) ->> 'org'::text))::uuid))",
      [
        { path: "sub", compared: col("owner_id") },
        { path: "app_metadata.role", compared: lit(["admin"]) },
        { path: "app_metadata.org", compared: col("org_id"), casts: ["uuid"] },
      ],
    ],
  ])("%s", (sql, expected) => {
    expect(reads(sql, "postgres")).toEqual(expected);
  });

  it("keeps what it cannot follow as other, and reports forms it does not read", () => {
    expect(reads("(lower((auth.jwt() ->> 'team'::text)) = team)", "postgres")).toEqual([
      { path: "team", compared: { kind: "other", text: "lower((auth.jwt() ->> 'team'::text)) = team" } },
    ]);
    expect(claimReads("((auth.jwt() #>> '{app_metadata,role}'::text[]) = 'admin'::text)", "postgres")).toMatchObject({
      reads: [],
      unreadable: [{ reason: "reads a #>> path" }],
    });
    expect(claimReads("(((auth.jwt() -> 'teams'::text) -> 0) = '\"a\"'::jsonb)", "postgres").unreadable).toMatchObject([{ reason: "reads an array element (-> n)" }]);
    expect(claimReads("(current_setting('request.jwt.claim.sub'::text, true) = owner_id::text)", "postgres").unreadable).toMatchObject([
      { reason: "reads the legacy request.jwt.claim.* setting" },
    ]);
  });

  it("reports a rule it cannot tokenize only when it reads the token", () => {
    expect(claimReads("(auth.jwt() ->> $$role$$) = 'a'", "postgres").unreadable).toEqual([{ text: "(auth.jwt() ->> $$role$$) = 'a'", reason: expect.stringMatching(/^cannot be read \(.+\)$/) }]);
    expect(claimReads("(status = $$x$$)", "postgres")).toEqual({ reads: [], unreadable: [] });
  });

  it("reads through a SQL wrapper function, one level, as Postgres calls it", () => {
    const functions = new Map([
      ["b3_role", " select nullif(auth.jwt() ->> 'app_role', '') "],
      ["samesight.app_role", "RETURN ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)"],
      ["is_staff", "BEGIN ATOMIC\n SELECT ((auth.jwt() ->> 'staff'::text))::boolean;\nEND"],
      ["visible", "begin return auth.jwt() ->> 'x' = 'y' and true; end"],
    ]);
    expect(reads("(b3_role() = 'ADMIN'::text)", "postgres", functions)).toEqual([{ path: "app_role", compared: lit(["ADMIN"]) }]);
    expect(reads("((( SELECT samesight.app_role() AS app_role) <> ALL (ARRAY['a'::text, 'b'::text])) AND (team ~~ 'x%'::text))", "postgres", functions)).toEqual([
      { path: "app_metadata.role", compared: lit(["a", "b"], true) },
    ]);
    expect(reads("is_staff()", "postgres", functions)).toEqual([{ path: "staff", compared: lit([true]), casts: ["boolean"] }]);
    expect(claimReads("visible()", "postgres", { functions }).unreadable).toEqual([{ text: "visible", reason: "calls visible, which reads the token in a way this cannot follow" }]);
    // Not listed: not followed, not reported.
    expect(claimReads("unknown_fn() = 'x'", "postgres", { functions })).toEqual({ reads: [], unreadable: [] });
  });

  it("reads a wrapper body only when it is one claim read", () => {
    expect(wrapperRead("select auth.jwt() ->> 'a';")).toEqual({ path: ["a"], casts: [] });
    expect(wrapperRead("select auth.jwt() ->> 'a' = 'b'")).toBeUndefined();
    expect(wrapperRead("select x from t")).toBeUndefined();
  });
});

// Each form below was checked against the PowerSync service (1.27.2) for what it reads.
describe("claimReads on sync streams", () => {
  it.each([
    ["SELECT * FROM lists WHERE owner_id = auth.user_id()", [{ path: "sub", compared: col("owner_id") }]],
    ["SELECT * FROM docs WHERE auth.parameter('app_metadata') ->> 'role' = 'admin'", [{ path: "app_metadata.role", compared: lit(["admin"]) }]],
    ["SELECT * FROM docs WHERE auth.parameter('$.app_metadata.role') = 'admin'", [{ path: "app_metadata.role", compared: lit(["admin"]) }]],
    // Not nested: PowerSync reads the top-level key "app_metadata.role".
    ["SELECT * FROM docs WHERE auth.parameter('app_metadata.role') = 'admin'", [{ path: "app_metadata.role", compared: lit(["admin"]) }]],
    ["SELECT * FROM docs WHERE auth.parameter('app_metadata') ->> '$.role' = 'admin'", [{ path: "app_metadata.role", compared: lit(["admin"]) }]],
    ["SELECT * FROM docs WHERE json_extract(auth.parameters(), '$.app_metadata.role') = 'admin'", [{ path: "app_metadata.role", compared: lit(["admin"]) }]],
    ["SELECT * FROM docs WHERE auth.parameter('app_metadata') ->> 'level' = 3", [{ path: "app_metadata.level", compared: lit([3]) }]],
    ["SELECT * FROM docs WHERE auth.parameter('app_metadata') ->> 'staff' = true", [{ path: "app_metadata.staff", compared: lit([true]) }]],
    ["SELECT * FROM docs WHERE org_id = auth.parameter('app_metadata') ->> 'org_id' AND status = 'published'", [{ path: "app_metadata.org_id", compared: col("org_id") }]],
    ["SELECT * FROM docs WHERE auth.parameter('user_metadata') ->> 'team_id' = team_id", [{ path: "user_metadata.team_id", compared: col("team_id") }]],
    ["SELECT * FROM docs WHERE 'admin' = auth.parameter('app_metadata') ->> 'role' OR owner_id = auth.user_id()", [
      { path: "app_metadata.role", compared: lit(["admin"]) },
      { path: "sub", compared: col("owner_id") },
    ]],
    ["SELECT * FROM docs WHERE docs.org_id = auth.parameter('app_metadata') ->> 'org_id' AND docs.status = 'published'", [{ path: "app_metadata.org_id", compared: { ...col("org_id"), qualifier: "docs" } }]],
  ])("%s", (sql, expected) => {
    expect(reads(sql, "streams")).toEqual(expected);
  });

  it("tells the dotted top-level key from the nested path", () => {
    const [dotted] = claimReads("SELECT * FROM d WHERE auth.parameter('app_metadata.role') = 'a'", "streams").reads;
    const [nested] = claimReads("SELECT * FROM d WHERE auth.parameter('$.app_metadata.role') = 'a'", "streams").reads;
    expect(dotted?.path).toEqual(["app_metadata.role"]);
    expect(nested?.path).toEqual(["app_metadata", "role"]);
    expect(claimReads("SELECT * FROM d WHERE auth.parameters() ->> 'app_metadata.role' = 'a'", "streams").reads[0]?.path).toEqual(["app_metadata.role"]);
  });
});

describe("claimReads on sync rules", () => {
  it.each([
    ["SELECT id AS list_id FROM lists WHERE request.jwt() ->> 'app_metadata.role' = 'admin'", [{ path: "app_metadata.role", compared: lit(["admin"]) }]],
    ["SELECT id AS list_id FROM lists WHERE request.jwt() -> 'app_metadata' ->> 'role' = 'admin'", [{ path: "app_metadata.role", compared: lit(["admin"]) }]],
    ["SELECT id AS list_id FROM lists WHERE request.jwt() ->> '$.app_metadata.role' = 'admin'", [{ path: "app_metadata.role", compared: lit(["admin"]) }]],
    ["SELECT * FROM boards WHERE owner_id = token_parameters.user_id", [{ path: "sub", compared: col("owner_id") }]],
    ["SELECT * FROM lists WHERE owner_id = request.user_id()", [{ path: "sub", compared: col("owner_id") }]],
    ["SELECT request.jwt() ->> 'org_id' AS org_id", [{ path: "org_id", compared: { kind: "other", text: "request.jwt() ->> 'org_id' as org_id" } }]],
    ["SELECT * FROM t WHERE token_parameters.team = team_id", [{ path: "parameters.team", compared: col("team_id") }]],
  ])("%s", (sql, expected) => {
    expect(reads(sql, "rules")).toEqual(expected);
  });
});

describe("claimReads on inputs a scan gets wrong without care", () => {
  const other = (sql: string, dialect: ClaimDialect) => claimReads(sql, dialect).reads.map((r) => r.compared.kind);

  it("does not take a comparison an operator beside the read belongs to", () => {
    expect(other("SELECT * FROM t WHERE 1 + auth.parameter('lvl') = 3", "streams")).toEqual(["other"]);
    expect(other("SELECT * FROM t WHERE 'x' || auth.parameter('r') = 'xa'", "streams")).toEqual(["other"]);
    expect(other("SELECT * FROM t WHERE org = auth.parameter('org') || '-x'", "streams")).toEqual(["other"]);
    expect(other("SELECT * FROM t WHERE lvl = auth.parameter('l') * 2", "streams")).toEqual(["other"]);
  });

  it("does not take a CASE result value for a condition", () => {
    expect(other("(org_id = CASE WHEN (status = 'x'::text) THEN ((auth.jwt() ->> 'org'::text))::uuid ELSE NULL::uuid END)", "postgres")).toEqual(["other"]);
    expect(other("(CASE status WHEN (auth.jwt() ->> 'r'::text) THEN true ELSE false END)", "postgres")).toEqual(["other"]);
    expect(reads("(CASE WHEN ((auth.jwt() ->> 'r'::text) = 'admin'::text) THEN true ELSE false END)", "postgres")).toEqual([{ path: "r", compared: lit(["admin"]) }]);
  });

  it("reports array elements and quoted keys in a path instead of reading a wrong key", () => {
    for (const sql of ["SELECT * FROM t WHERE auth.parameter('$.roles[0]') = 'a'", "SELECT * FROM t WHERE json_extract(auth.parameters(), '$.roles[0]') = 'a'", "SELECT * FROM t WHERE auth.parameter('x') ->> '$.roles[0]' = 'a'"]) {
      expect(claimReads(sql, "streams"), sql).toMatchObject({ reads: [], unreadable: [{ reason: "reads an array element or quoted key in a JSON path" }] });
    }
    expect(claimReads("((auth.jwt())['app_metadata'::text] = '1'::jsonb)", "postgres").unreadable).toMatchObject([{ reason: "reads a [ ] subscript" }]);
    // Postgres reads '$.a.b' as one key.
    expect(reads("((auth.jwt() ->> '$.a.b'::text) = 'x'::text)", "postgres")).toEqual([{ path: "$.a.b", compared: lit(["x"]) }]);
  });

  it("reports every call of a listed function that reads the token, through other listed functions too", () => {
    const functions = new Map([
      ["has_role", "select auth.jwt() ->> 'role'"],
      ["app_role", "select auth.jwt() ->> 'app_role'"],
      ["outer_fn", "select app_role() = 'admin'"],
      ["visible", "select true"],
    ]);
    expect(claimReads("(has_role('x'::text) = 'admin'::text)", "postgres", { functions }).unreadable).toEqual([
      { text: "has_role", reason: "calls has_role, which reads the token in a way this cannot follow" },
    ]);
    expect(claimReads("outer_fn()", "postgres", { functions }).unreadable).toEqual([{ text: "outer_fn", reason: "calls outer_fn, which reads the token in a way this cannot follow" }]);
    expect(claimReads("(visible = true) AND visible()", "postgres", { functions })).toEqual({ reads: [], unreadable: [] });
    // A quoted function name with regex characters is matched as text, never compiled.
    const odd = new Map([
      ["f(", "select auth.jwt() ->> 'x'"],
      ["g", 'select "f("()'],
    ]);
    expect(() => claimReads("(g() = 1)", "postgres", { functions: odd })).not.toThrow();
  });

  it("reads a helper with arguments that reads only the user id as the user id, not as something it cannot follow", () => {
    const functions = new Map([
      ["public.is_member", "SELECT EXISTS (SELECT 1 FROM public.members m WHERE m.org_id = o AND m.user_id = auth.uid())"],
      ["public.role_in", "select auth.jwt() ->> 'role' = r"],
    ]);
    expect(claimReads("public.is_member(org_id)", "postgres", { functions })).toMatchObject({
      reads: [{ path: ["sub"], compared: { kind: "other", text: "public.is_member(org_id)" } }],
      unreadable: [],
    });
    expect(claimReads("public.role_in('a'::text)", "postgres", { functions }).unreadable).toHaveLength(1);
    // A claim read behind a quoted call still counts: "getOrg"() is a call of getOrg.
    const quoted = new Map([
      ["h", "select auth.uid() = u and \"getOrg\"() = o"],
      ["getOrg", "select auth.jwt() ->> 'org'"],
    ]);
    expect(claimReads("h(owner_id, org_id)", "postgres", { functions: quoted }).unreadable).toHaveLength(1);
  });

  it("reads a BEGIN ATOMIC wrapper as Postgres prints it, with its column alias", () => {
    expect(wrapperRead("BEGIN ATOMIC\n SELECT ((auth.jwt() ->> 'staff'::text))::boolean AS bool;\nEND")).toEqual({ path: ["staff"], casts: ["boolean"] });
    expect(wrapperRead(" SELECT auth.uid() AS uid;")).toEqual({ path: ["sub"], casts: [] });
  });

  it("marks a column compared inside a subquery as that subquery's", () => {
    const [read] = claimReads("(EXISTS ( SELECT 1 FROM members m WHERE ((m.user_id = auth.uid()) AND (m.list_id = lists.id))))", "postgres").reads;
    expect(read).toMatchObject({ path: ["sub"], compared: col("user_id"), inSubquery: true });
    expect(claimReads("(owner_id = auth.uid())", "postgres").reads[0]?.inSubquery).toBe(false);
  });

  it("keeps only single JSON values as values, follows NOT, CAST and nullif(read, '') only", () => {
    expect(other("((auth.jwt() -> 'app_metadata'::text) = '{\"role\":\"admin\"}'::jsonb)", "postgres")).toEqual(["other"]);
    expect(reads("(NOT (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'a'::text))", "postgres")).toEqual([{ path: "app_metadata.role", compared: lit(["a"], true) }]);
    expect(reads("SELECT * FROM t WHERE NOT auth.parameter('a') = 'x'", "streams")).toEqual([{ path: "a", compared: lit(["x"], true) }]);
    expect(reads("(CAST((auth.jwt() ->> 'org'::text) AS uuid) = org_id)", "postgres")).toEqual([{ path: "org", compared: col("org_id"), casts: ["uuid"] }]);
    expect(other("(nullif((auth.jwt() ->> 'org'::text), 'none'::text) = org)", "postgres")).toEqual(["other"]);
  });
});

describe("classify", () => {
  it.each([
    [["sub"], "identity"],
    [["role"], "shared"],
    [["aud"], "shared"],
    [["aal"], "auth-state"],
    [["is_anonymous"], "auth-state"],
    [["app_metadata", "provider"], "auth-state"],
    [["user_metadata", "email_verified"], "auth-state"],
    [["app_metadata", "role"], "app_metadata"],
    [["app_metadata", "org", "id"], "app_metadata"],
    [["user_metadata", "team_id"], "user_metadata"],
    [["app_role"], "hook"],
    [["parameters", "team"], "hook"],
    [["app_metadata.role"], "hook"],
    [[], "object"],
    [["app_metadata"], "object"],
  ])("%j is %s", (path, expected) => {
    expect(classify(path)).toBe(expected);
  });
});

describe("claimReads on the corpus", () => {
  const dir = fileURLToPath(new URL("../../../corpus/", import.meta.url));
  const rules = (file: string) => {
    const config = parseSyncConfig(readFileSync(file, "utf8"));
    const dialect: ClaimDialect = config.kind === "streams" ? "streams" : "rules";
    return config.streams.flatMap((s) => [...s.ctes.values(), ...s.queries.map((q) => q.sql)].map((sql) => claimReads(sql, dialect)));
  };

  it("finds only the user id in the real configs, and reads them all", () => {
    for (const file of readdirSync(`${dir}real`).filter((f) => f.endsWith(".yaml"))) {
      for (const r of rules(`${dir}real/${file}`)) {
        expect(r.unreadable, file).toEqual([]);
        for (const read of r.reads) expect(read.path, file).toEqual(["sub"]);
      }
    }
  });

  it("finds the planted user_metadata scope compared with its column", () => {
    const found = rules(`${dir}planted/user-metadata-scope.yaml`).flatMap((r) => r.reads);
    expect(found).toContainEqual(expect.objectContaining({ path: ["user_metadata", "team_id"], compared: col("team_id") }));
  });
});

describe("negations around a comparison, as Postgres prints them", () => {
  const role = "((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)";
  it.each([
    [`((${role} = 'admin'::text) = false)`, true],
    [`((${role} = 'admin'::text) IS NOT TRUE)`, true],
    [`(NOT ((${role} = 'admin'::text) IS FALSE))`, false],
    [`((${role} <> 'admin'::text) <> true)`, false],
    [`((${role} = 'admin'::text) = true)`, false],
    [`((${role} = 'admin'::text) IS FALSE)`, true],
    [`((${role} = 'admin'::text) IS NOT FALSE)`, false],
    [`(((${role} = 'admin'::text) = false) = false)`, false],
    [`(NOT (${role} = 'admin'::text))`, true],
  ])("%s", (sql, negated) => {
    expect(reads(sql, "postgres")).toEqual([{ path: "app_metadata.role", compared: lit(["admin"], negated) }]);
  });

  it("does not take a comparison of something else with a boolean for one of the condition", () => {
    // = false here compares is_admin, not the role condition.
    expect(reads(`((${role} = 'admin'::text) AND (is_admin = false))`, "postgres")).toEqual([{ path: "app_metadata.role", compared: lit(["admin"]) }]);
  });

  it("reads IN over a varchar cast, as Postgres prints it, as its literals", () => {
    const sql = `(((${role})::character varying)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))`;
    expect(reads(sql, "postgres")).toEqual([{ path: "app_metadata.role", compared: lit(["a", "b"]), casts: ["character varying", "text"] }]);
  });
});

describe("callsIn", () => {
  it("reads db.schema.fn(...) as schema.fn, tokenized or scanned", () => {
    expect(callsIn("select postgres.app.helper(1)")).toEqual(["app.helper"]);
    expect(callsIn("begin v := postgres.app.helper(1); end")).toEqual(["app.helper"]);
  });

  it("names each call as Postgres resolves it: unquoted names folded, quoted ones kept, schemas kept", () => {
    expect(callsIn('select public.Get_Org(x) and "getOrg"() and auth.jwt() ->> \'a\'').sort()).toEqual(["auth.jwt", "getOrg", "public.get_org"]);
  });

  it("takes no keyword before a parenthesis for a call: LATERAL (...), EXISTS (...)", () => {
    expect(callsIn("select 1 from a, lateral (select 2) x where exists (select 3)")).toEqual([]);
  });

  it("scans a plpgsql body it cannot tokenize, ignoring calls in comments and strings", () => {
    const body = "begin\n  -- skip_me(1)\n  v := Lookup(1); /* gone(2) */ raise notice 'not_a_call(3)';\n  return \"Keep\"();\nend";
    expect(callsIn(body).sort()).toEqual(["Keep", "lookup"]);
  });

  it("never matches a function by case-insensitive or quote-less spelling of another", () => {
    const functions = new Map([
      ["org", "select auth.jwt() ->> 'org'"],
      ["h", 'select "Org"() = 1'],
    ]);
    expect(claimReads("h(x)", "postgres", { functions }).unreadable).toEqual([]);
    expect(claimReads("h(x)", "postgres", { functions: new Map([...functions, ["Org", "select 1"]]) }).unreadable).toEqual([]);
  });
});

describe("overloads and wrappers two levels deep", () => {
  const jwtRole = "SELECT ((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)";
  it("reads a call by the overload its argument count runs", () => {
    const functions = new Map([
      ["f", `${jwtRole}\n;\nSELECT 1 FROM members WHERE id = $1`],
      ["f/0-0", jwtRole],
      ["f/1-1", "SELECT 1 FROM members WHERE id = $1"],
    ]);
    expect(reads("(f() = 'admin'::text)", "postgres", functions)).toEqual([{ path: "app_metadata.role", compared: lit(["admin"]) }]);
    expect(claimReads("f(org_id)", "postgres", { functions })).toEqual({ reads: [], unreadable: [] });
  });

  it("reports a call several overloads could run when any reads the token, never picking one", () => {
    const functions = new Map([
      ["g", `select 1\n;\n${jwtRole}`],
      ["g/1-1", "select 1"],
      ["g/1-2", jwtRole],
    ]);
    expect(claimReads("g(x)", "postgres", { functions }).unreadable).toEqual([{ text: "g", reason: "calls g, one of whose overloads reads the token" }]);
    // Two arguments: only g/1-2 takes them.
    expect(claimReads("g(x, y)", "postgres", { functions }).unreadable).toEqual([{ text: "g", reason: "calls g, which reads the token in a way this cannot follow" }]);
  });

  it("takes a listed name without counts for any arity, as before", () => {
    expect(reads("(h() = 'x'::text)", "postgres", new Map([["h", jwtRole]]))).toEqual([{ path: "app_metadata.role", compared: lit(["x"]) }]);
  });

  it("reads a wrapper of a wrapper, and reports one three deep", () => {
    const functions = new Map([
      ["outer", "SELECT public.inner()"],
      ["public.inner", jwtRole],
      ["top", "SELECT outer()"],
    ]);
    expect(reads("(outer() = 'admin'::text)", "postgres", functions)).toEqual([{ path: "app_metadata.role", compared: lit(["admin"]) }]);
    expect(claimReads("(top() = 'admin'::text)", "postgres", { functions })).toEqual({
      reads: [],
      unreadable: [{ text: "top", reason: "calls top, which reads the token in a way this cannot follow" }],
    });
  });
});

describe("review fixes to negation, cast lists, calls and overloads", () => {
  const role = "((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)";
  it.each([
    [`(false = (${role} = 'admin'::text))`, true],
    [`(true <> (${role} = 'admin'::text))`, true],
    [`(NOT ((${role} = 'admin'::text) IS DISTINCT FROM false))`, true],
    [`((${role} = 'admin'::text) IS DISTINCT FROM true)`, true],
    [`((${role} = 'admin'::text) IS NOT DISTINCT FROM true)`, false],
  ])("%s", (sql, negated) => {
    expect(reads(sql, "postgres")).toEqual([{ path: "app_metadata.role", compared: lit(["admin"], negated) }]);
  });

  it("reads = ALL and <> ANY over several values as neither IN nor NOT IN", () => {
    expect(reads(`(${role} = ALL (ARRAY['a'::text, 'b'::text]))`, "postgres")[0]?.compared).toMatchObject({ kind: "other" });
    expect(reads(`(${role} <> ANY (ARRAY['a'::text, 'b'::text]))`, "postgres")[0]?.compared).toMatchObject({ kind: "other" });
    expect(reads(`(${role} <> ALL (ARRAY['a'::text, 'b'::text]))`, "postgres")[0]?.compared).toEqual(lit(["a", "b"], true));
  });

  it("never lets a quote or comment marker inside a plpgsql string hide a call", () => {
    expect(callsIn("begin v := 'a--b'; perform f(); end")).toEqual(["f"]);
    expect(callsIn("begin v := '/*'; perform f(); v := '*/'; end")).toEqual(["f"]);
    expect(callsIn("begin raise notice $m$don't$m$; perform g(); v := 'a'; end")).toEqual(["g"]);
    expect(callsIn("begin v := E'don\\'t'; perform h(); v := 'x'; end")).toEqual(["h"]);
    expect(callsIn("select exists (select 1) and x in (1) and coalesce(a, b)")).toEqual([]);
  });

  it("resolves a bare call to any schema's function of that name", () => {
    const functions = new Map([
      ["app.k", "select auth.jwt() ->> 'x'"],
      ["public.k", "select 1"],
      ["k", "select 1"],
      ["h", "begin return k(); end"],
    ]);
    expect(claimReads("h(x)", "postgres", { functions }).unreadable).toHaveLength(1);
  });

  it("keeps a call of overloads that read only the user id a user id read", () => {
    const functions = new Map([
      ["m", "select auth.uid() = $1\n;\nselect auth.uid() = $1"],
      ["m/1-1", "select auth.uid() = $1"],
      ["m/1-2", "select auth.uid() = $1"],
    ]);
    expect(claimReads("m(owner_id)", "postgres", { functions })).toMatchObject({ reads: [{ path: ["sub"] }], unreadable: [] });
  });
});

describe("callsIn's plpgsql scan, second review", () => {
  it("reads E'' strings with doubled and escaped quotes, and skips quoted names whole", () => {
    expect(callsIn("begin x := E'a''b\\'c'; perform secret(); end")).toEqual(["secret"]);
    expect(callsIn('begin x := "it\'s"; perform f(); end')).toEqual(["f"]);
    expect(callsIn('begin x := "a--b"; perform f(); end')).toEqual(["f"]);
    expect(callsIn('begin v := "if"(2); if (v) then perform g(); end if; end').sort()).toEqual(["g", "if"]);
  });

  it("does not take x IS false = (cond) for a negation of the condition", () => {
    const role = "((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text)";
    expect(reads(`(x IS false = (${role} = 'a'::text))`, "postgres")[0]?.compared).toEqual(lit(["a"]));
  });
});
