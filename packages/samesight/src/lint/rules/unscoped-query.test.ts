import { describe, expect, it } from "vitest";
import { corpusFindings, plantedExpecting } from "../../fixtures/corpus.ts";
import { lintSyncConfig } from "../lint.ts";
import { unscopedQuery } from "./unscoped-query.ts";

const lint = (yaml: string) => lintSyncConfig(yaml, "s.yaml", [unscopedQuery]).map((f) => [f.level, f.line, f.message]);
const stream = (body: string) => `config:\n  edition: 3\nstreams:\n${body}`;

describe("unscoped-query on sync streams", () => {
  it("fails a query that reads no token value, and warns when only fixed values filter it", () => {
    expect(lint(stream("  all:\n    auto_subscribe: true\n    query: SELECT * FROM customers\n"))).toEqual([
      ["error", 6, "stream all, query sends every customers row to every user: nothing in it reads the requesting user (auth.user_id()) or a token claim"],
    ]);
    expect(lint(stream("  pub:\n    query: SELECT * FROM posts WHERE status = 'published'\n"))).toEqual([
      ["warning", 5, "stream pub, query sends every user the same posts rows, filtered only by fixed values; fine if they are public by design"],
    ]);
  });

  it("accepts a query tied to the token, directly, through a join or through a CTE", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM lists WHERE owner_id = auth.user_id()\n"))).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT * FROM projects WHERE org_id = auth.parameter('org_id')\n"))).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT todos.* FROM todos JOIN lists ON todos.list_id = lists.id AND lists.owner_id = auth.user_id()\n"))).toEqual([]);
    expect(lint(stream("  s:\n    with:\n      mine: SELECT id FROM lists WHERE owner_id = auth.user_id()\n    query: SELECT * FROM todos WHERE list_id IN mine\n"))).toEqual([]);
  });

  it("counts a token value only where it limits the rows", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM lists WHERE owner_id = auth.user_id() OR true\n"))).toEqual([
      ["error", 5, "stream s, query reads the requesting user's token, but not in a way that limits its lists rows, so every user gets every row"],
    ]);
    expect(lint(stream("  s:\n    query: SELECT * FROM lists WHERE auth.user_id() IS NOT NULL\n")).map((f) => f[0])).toEqual(["error"]);
    expect(lint(stream("  s:\n    query: SELECT * FROM lists WHERE NOT owner_id = auth.user_id()\n")).map((f) => f[0])).toEqual(["error"]);
    expect(lint(stream("  s:\n    query: SELECT * FROM lists WHERE auth.user_id() IS NOT NULL AND status = 'open'\n"))).toEqual([
      ["warning", 5, "stream s, query reads the requesting user's token, but not in a way that limits its lists rows, so every user gets the same rows, filtered only by fixed values"],
    ]);
    // An outer join keeps every todo, whatever its ON says.
    expect(
      lint(stream("  s:\n    query: SELECT todos.* FROM todos LEFT JOIN lists ON todos.list_id = lists.id AND lists.owner_id = auth.user_id()\n")).map((f) => f[0]),
    ).toEqual(["error"]);
    expect(lint(stream("  s:\n    with:\n      mine: SELECT id FROM lists WHERE owner_id = auth.user_id() OR true\n    query: SELECT * FROM todos WHERE list_id IN mine\n")).map((f) => f[0])).toEqual([
      "error",
    ]);
    expect(lint(stream("  s:\n    query: SELECT * FROM todos WHERE list_id IN (SELECT id FROM lists WHERE owner_id = auth.user_id() OR true)\n")).map((f) => f[0])).toEqual([
      "error",
    ]);
  });

  it("accepts every OR branch tied to the user, a subquery that is, and a role gate", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM chats WHERE (a_id = auth.user_id() OR b_id = auth.user_id())\n"))).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT * FROM todos WHERE list_id IN (SELECT id FROM lists WHERE owner_id = auth.user_id())\n"))).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT * FROM customers WHERE auth.parameter('role') = 'admin'\n"))).toEqual([]);
  });

  it("leaves queries the client scopes, and words inside strings, to other rules", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM todos WHERE list_id = subscription.parameter('list_id')\n"))).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT * FROM notes WHERE body = 'auth.user_id()'\n")).map((f) => f[0])).toEqual(["warning"]);
  });
});

describe("unscoped-query on sync rules", () => {
  it("fails a bucket with no parameter query, and a parameter query that reads no token value", () => {
    expect(lint("bucket_definitions:\n  global:\n    data:\n      - SELECT * FROM announcements\n")).toEqual([
      ["error", 4, "bucket global has no parameter query, so every user receives every row of announcements"],
    ]);
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT id AS list_id FROM lists\n    data:\n      - SELECT * FROM todos WHERE list_id = bucket.list_id\n")).toEqual([
      ["error", 3, "bucket b, parameters[0] reads nothing from the requesting user's token (request.user_id(), token_parameters), so every user gets every bucket it lists"],
    ]);
  });

  it("fails data queries that read no bucket parameter, even under a parameter query tied to the user", () => {
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT FROM users WHERE users.id = token_parameters.user_id\n    data:\n      - SELECT * FROM boards\n      - SELECT * FROM cards\n")).toEqual([
      ["error", 5, "bucket b: its data queries are not limited by a bucket parameter, so every user it reaches receives every row of boards, cards"],
    ]);
  });

  it("counts a token parameter only where the data queries are limited by it", () => {
    // uid comes from the token, but the data queries use list_id, which every user gets.
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.user_id() AS uid, id AS list_id FROM lists\n    data: [SELECT * FROM todos WHERE list_id = bucket.list_id]\n")).toEqual([
      ["error", 3, "bucket b, parameters[0] reads the requesting user's token, but not in a way that limits which buckets it gives, so every user gets every bucket it lists"],
    ]);
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.user_id() AS user_id\n    data: [SELECT * FROM lists WHERE owner_id = bucket.user_id OR true]\n")).toEqual([
      ["error", 4, "bucket b: its data queries are not limited by a bucket parameter, so every user it reaches receives every row of lists"],
    ]);
  });

  it("warns, not fails, on open data in a bucket only a role reaches", () => {
    expect(lint("bucket_definitions:\n  admin:\n    parameters: SELECT FROM users WHERE id = request.user_id() AND is_admin = true\n    data: [SELECT * FROM customers]\n")).toEqual([
      [
        "warning",
        4,
        "bucket admin: its data queries are not limited by a bucket parameter, so every user its parameter queries admit receives every row of customers; fine if they admit only a role (such as admins) meant to see it all",
      ],
    ]);
    expect(lint("bucket_definitions:\n  admin:\n    parameters: SELECT WHERE request.jwt() ->> 'role' = 'admin'\n    data: [SELECT * FROM customers]\n").map((f) => f[0])).toEqual(["warning"]);
  });

  it("accepts a bucket tied to the token, and leaves client parameters to client-scoped", () => {
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.user_id() AS user_id\n    data: [SELECT * FROM lists WHERE owner_id = bucket.user_id]\n")).toEqual([]);
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.parameters() ->> 'id' AS id\n    data: [SELECT * FROM lists WHERE id = bucket.id]\n")).toEqual([]);
  });
});

describe("unscoped-query on the corpus", () => {
  it("catches every planted leak that expects it", () => {
    const planted = plantedExpecting("unscoped-query");
    expect(planted.map((p) => p.file)).toEqual(["missing-owner-filter.yaml", "unbound-parameter-query.yaml"]);
    for (const p of planted) expect(lintSyncConfig(p.text, p.file, [unscopedQuery]).map((f) => f.level), p.file).toContain(p.level);
  });

  it("finds exactly these in the real configs", () => {
    expect(corpusFindings("real", [unscopedQuery])).toEqual([
      "powersync-dart-trello-global-legacy.yaml:8 error",
      "powersync-dart-trello-legacy.yaml:5 error",
      "powersync-dart-trello-legacy.yaml:14 warning",
      "powersync-js-nextjs.yaml:11 error",
    ]);
  });
});
