import { describe, expect, it } from "vitest";
import { bucketAccess, parameterQuery, parameterSource } from "./access.ts";
import { lintSyncConfig } from "./lint.ts";
import { clientScoped } from "./rules/client-scoped.ts";
import { unscopedQuery } from "./rules/unscoped-query.ts";

const run = (rule: typeof unscopedQuery) => (yaml: string) => lintSyncConfig(yaml, "s.yaml", [rule]).map((f) => [f.level, f.line, f.message]);
const unscoped = run(unscopedQuery);
const client = run(clientScoped);
const stream = (body: string) => `config:\n  edition: 3\nstreams:\n${body}`;
const levels = (found: unknown[][]) => found.map((f) => f[0]);

describe("comparisons", () => {
  it("count IN with a token or client value", () => {
    expect(unscoped(stream("  s:\n    query: SELECT * FROM projects WHERE org_id IN auth.parameter('org_ids')\n"))).toEqual([]);
    expect(levels(client(stream("  s:\n    query: SELECT * FROM todos WHERE id IN subscription.parameter('ids')\n")))).toEqual(["error"]);
  });

  it("follow a CTE the token limits, which bounds a client value beside it", () => {
    expect(
      client(stream("  s:\n    with:\n      mine: SELECT id FROM lists WHERE owner_id = auth.user_id()\n    query: SELECT * FROM todos WHERE list_id IN mine AND id = subscription.parameter('id')\n")),
    ).toEqual([]);
  });

  it("name what a CTE reads when it does not limit the rows", () => {
    expect(unscoped(stream("  s:\n    with:\n      mine: SELECT id FROM lists WHERE owner_id = auth.user_id() OR true\n    query: SELECT * FROM todos WHERE list_id IN mine\n"))).toEqual([
      ["error", 7, "stream s, query reads the requesting user's token, but not in a way that limits which rows of todos it sends, so every user gets every row"],
    ]);
  });
});

describe("unreadable queries", () => {
  it("are left to unreadable-query, also when a subquery reads the CTE", () => {
    expect(unscoped(stream("  s:\n    with:\n      mine: SELECT org_id FROM m WHERE x = E'y'\n    query: SELECT * FROM p WHERE org_id IN (SELECT org_id FROM mine)\n"))).toEqual([]);
  });

  it("are left to unreadable-query, not reported as leaks", () => {
    expect(
      unscoped("bucket_definitions:\n  b:\n    parameters: SELECT request.user_id() AS user_id\n    data:\n      - SELECT * FROM lists WHERE owner_id = bucket.user_id\n      - SELECT * FROM notes WHERE x = E'y'\n"),
    ).toEqual([]);
    expect(unscoped(stream("  s:\n    with:\n      c: SELECT id FROM lists WHERE name = E'x'\n    query: SELECT * FROM todos WHERE list_id IN c\n"))).toEqual([]);
    expect(client(stream("  s:\n    with:\n      c: SELECT id FROM lists WHERE name = E'x'\n    query: SELECT * FROM todos WHERE list_id IN c AND id = subscription.parameter('id')\n"))).toEqual([]);
  });
});

describe("sync rules buckets", () => {
  it("fail every open data query unless each is filtered, and a fixed filter alone is no role", () => {
    expect(levels(unscoped("bucket_definitions:\n  g:\n    data:\n      - SELECT * FROM posts WHERE status = 'public'\n      - SELECT * FROM customers\n"))).toEqual(["error"]);
    expect(levels(unscoped("bucket_definitions:\n  b:\n    parameters: SELECT FROM settings WHERE sharing = 'on'\n    data: [SELECT * FROM customers]\n"))).toEqual(["error"]);
  });

  it("take a role claim written with IN or with the literal first", () => {
    for (const gate of ["SELECT WHERE request.jwt() ->> 'role' IN ('admin', 'owner')", "SELECT WHERE 'admin' = request.jwt() ->> 'role'"]) {
      expect(levels(unscoped(`bucket_definitions:\n  a:\n    parameters: ${gate}\n    data: [SELECT * FROM customers]\n`)), gate).toEqual(["warning"]);
    }
  });

  it("warn about a parameter query only fixed values filter, saying so", () => {
    expect(unscoped("bucket_definitions:\n  b:\n    parameters: SELECT id AS list_id FROM lists WHERE status = 'shared'\n    data: [SELECT * FROM todos WHERE list_id = bucket.list_id]\n")).toEqual([
      ["warning", 3, "bucket b, parameters[0] reads nothing from the requesting user's token (request.user_id(), token_parameters), so every user gets every bucket it lists that its fixed filters allow"],
    ]);
  });

  it("trace each bucket parameter to the token, the client or the rows", () => {
    const p = parameterQuery("SELECT request.user_id() AS user_id, request.parameters() ->> 'list' AS list_id, org_id FROM members WHERE user_id = request.user_id()");
    expect(p && ["user_id", "list_id", "org_id", "missing"].map((n) => parameterSource(p, n))).toEqual(["token", "client", "token", "nobody"]);
    expect(parameterQuery("SELECT * FROM members WHERE user_id = request.user_id()")).toBeNull();
    const access = bucketAccess(new Map([["parameters[0]", "SELECT request.parameters() ->> 'id' AS id"]]), [
      { label: "data[0]", sql: "SELECT * FROM lists WHERE id = bucket.id" },
      { label: "data[1]", sql: "SELECT * FROM tags" },
    ]);
    expect(access).toEqual({ loose: [{ label: "parameters[0]", sql: "SELECT request.parameters() ->> 'id' AS id", via: "client" }], open: [{ label: "data[1]", sql: "SELECT * FROM tags" }], roleGated: false });
  });
});

describe("gates and bucket parameters, one guard at a time", () => {
  const rules = (parameters: string, data: string[]) => `bucket_definitions:\n  b:\n    parameters: ${parameters}\n    data:\n${data.map((d) => `      - ${d}\n`).join("")}`;

  it("count a bucket parameter only where a row is compared with it", () => {
    expect(levels(unscoped(rules("SELECT request.user_id() AS uid", ["SELECT * FROM todos WHERE bucket.uid = bucket.uid"])))).toEqual(["error"]);
  });

  it("take no parameter query that gives bucket parameters for a role gate", () => {
    expect(levels(unscoped(rules("SELECT org_id FROM members WHERE user_id = request.user_id() AND accepted = true", ["SELECT * FROM invoices"])))).toEqual(["error"]);
  });

  it("take no role gate in a bucket whose other data queries use bucket parameters", () => {
    expect(levels(unscoped(rules("SELECT FROM users WHERE id = request.user_id() AND is_admin", ["SELECT * FROM a WHERE org = bucket.org_id", "SELECT * FROM b"])))).toContain("error");
  });

  it("take a bare flag column, but not a claim every user passes, for a gate on the user's row", () => {
    expect(levels(unscoped(rules("SELECT FROM users WHERE id = request.user_id() AND is_admin", ["SELECT * FROM payroll"])))).toEqual(["warning"]);
    expect(levels(unscoped(rules("SELECT FROM users WHERE id = request.user_id() AND request.jwt() ->> 'role' = 'authenticated'", ["SELECT * FROM payroll"])))).toEqual(["error"]);
    expect(levels(unscoped(rules("SELECT id AS org_id FROM orgs WHERE request.jwt() ->> 'is_anonymous' = 0", ["SELECT * FROM t WHERE org = bucket.org_id"])))).toEqual(["error"]);
    // A JSON column of the row, not the token: a role kept in the table.
    expect(levels(unscoped(rules("SELECT FROM users WHERE id = request.user_id() AND users.meta ->> 'role' = 'authenticated'", ["SELECT * FROM payroll"])))).toEqual(["warning"]);
  });

  it("count open data queries in the message", () => {
    expect(unscoped(rules("SELECT request.user_id() AS uid", ["SELECT * FROM t WHERE owner = bucket.uid", "SELECT * FROM a", "SELECT * FROM b"])).map((f) => f[2])).toEqual([
      expect.stringMatching(/^bucket b: 2 of its data queries are not limited/),
    ]);
  });
});

describe("claims every user passes", () => {
  const every = /checks a claim every signed-in Supabase user passes/;

  it("are read as a JSON path, and named in the message wherever they sit", () => {
    for (const where of [
      "json_extract(auth.parameters(), '$.role') = 'authenticated'",
      "owner_id = auth.user_id() OR (auth.parameter('role') = 'authenticated' AND 1 = 1)",
    ]) {
      expect(unscoped(stream(`  s:\n    query: SELECT * FROM docs WHERE ${where}\n`)).map((f) => f[2]), where).toEqual([expect.stringMatching(every)]);
    }
    expect(unscoped(stream("  s:\n    with:\n      c: SELECT id FROM lists WHERE auth.parameter('role') = 'authenticated'\n    query: SELECT * FROM todos WHERE list_id IN c\n")).map((f) => f[2])).toEqual([
      expect.stringMatching(every),
    ]);
  });
});
