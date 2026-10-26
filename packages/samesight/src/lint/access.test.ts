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
