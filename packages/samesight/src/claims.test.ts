import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ClaimDialect, type ClaimRead, claimReads, classify, wrapperRead } from "./claims.ts";
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
    ["((((current_setting('request.jwt.claims'::text, true))::json -> 'app_metadata'::text) ->> 'team'::text) = team)", [{ path: "app_metadata.team", compared: col("team"), casts: ["json"] }]],
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
    ["(auth.uid() IN ( SELECT m.user_id FROM members m))", [{ path: "sub", compared: { kind: "other", text: "in (select m.user_id from members m)" } }]],
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
    expect(claimReads("(auth.jwt() ->> $$role$$) = 'a'", "postgres").unreadable).toHaveLength(1);
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
    ["SELECT * FROM docs WHERE docs.org_id = auth.parameter('app_metadata') ->> 'org_id' AND docs.status = 'published'", [{ path: "app_metadata.org_id", compared: col("org_id") }]],
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
