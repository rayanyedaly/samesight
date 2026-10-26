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
      ["error", 5, "bucket b: its data queries read no bucket parameter, so every user it reaches receives every row of boards, cards"],
    ]);
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
