import { describe, expect, it } from "vitest";
import { corpusFindings } from "../../fixtures/corpus.ts";
import { lintSyncConfig } from "../lint.ts";
import { unreadableQuery } from "./unreadable-query.ts";

const lint = (yaml: string) => lintSyncConfig(yaml, "s.yaml", [unreadableQuery]).map((f) => [f.level, f.line, f.message]);
const stream = (body: string) => `config:\n  edition: 3\nstreams:\n${body}`;

describe("unreadable-query", () => {
  it("warns about a query audit cannot attribute to one table, with audit's reason", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM todos JOIN lists ON todos.list_id = lists.id\n"))).toEqual([
      ["warning", 5, "stream s, query cannot be checked by audit: it selects * across a join; name the table, as in t.*"],
    ]);
    expect(lint(stream("  s:\n    query: SELECT todos.* FROM todos LEFT JOIN lists ON todos.list_id = lists.id\n")).map((f) => f[2])).toEqual([
      expect.stringMatching(/only \[INNER\] JOIN/),
    ]);
  });

  it("warns about a CTE or parameter query the tokenizer cannot read", () => {
    expect(lint(stream("  s:\n    with:\n      c: SELECT id FROM lists WHERE name = E'x'\n    query: SELECT * FROM todos WHERE list_id IN c\n")).map((f) => f[2])).toEqual([
      expect.stringMatching(/^stream s, with.c cannot be checked by audit: it has a prefixed literal/),
    ]);
  });

  it("accepts the shapes audit reads", () => {
    expect(lint(stream("  s:\n    query: SELECT todos.* FROM todos JOIN lists ON todos.list_id = lists.id WHERE lists.owner_id = auth.user_id()\n"))).toEqual([]);
    // An alias renames the table on the device; audit maps it back.
    expect(lint(stream("  s:\n    query: SELECT * FROM lists AS mine\n"))).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT t.* FROM todos t JOIN lists l ON t.list_id = l.id\n"))).toEqual([]);
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.user_id() AS user_id\n    data: [SELECT * FROM lists WHERE owner_id = bucket.user_id]\n")).toEqual([]);
  });

  it("finds nothing in the corpus: audit reads every config in it", () => {
    expect([...corpusFindings("real", [unreadableQuery]), ...corpusFindings("planted", [unreadableQuery])]).toEqual([]);
  });
});
