import { describe, expect, it } from "vitest";
import { corpusFindings, plantedExpecting } from "../../fixtures/corpus.ts";
import { lintSyncConfig } from "../lint.ts";
import { clientScoped } from "./client-scoped.ts";

const lint = (yaml: string) => lintSyncConfig(yaml, "s.yaml", [clientScoped]).map((f) => [f.level, f.line, f.message]);
const stream = (body: string) => `config:\n  edition: 3\nstreams:\n${body}`;

describe("client-scoped on sync streams", () => {
  it("fails rows picked by a subscription or connection parameter alone", () => {
    expect(lint(stream("  list:\n    query: SELECT * FROM todos WHERE list_id = subscription.parameter('list_id')\n"))).toEqual([
      ["error", 5, "stream list, query picks which rows of todos it sends by a parameter the client sends, and nothing limits them to the requesting user, so any client can ask for any of them"],
    ]);
    expect(lint(stream("  doc:\n    with:\n      d: SELECT id FROM documents WHERE id = connection.parameter('doc')\n    query: SELECT * FROM documents WHERE id IN d\n")).map((f) => f[0])).toEqual(["error"]);
  });

  it("fails a client parameter beside a claim every token passes, and warns beside a role", () => {
    expect(
      lint(stream("  s:\n    query: SELECT * FROM docs WHERE id = subscription.parameter('id') AND auth.parameter('role') = 'authenticated'\n")).map((f) => f[0]),
    ).toEqual(["error"]);
    expect(lint(stream("  s:\n    query: SELECT * FROM docs WHERE id = subscription.parameter('id') AND auth.parameter('app_metadata') ->> 'role' = 'admin'\n"))).toEqual([
      [
        "warning",
        5,
        "stream s, query picks which rows of docs it sends by a parameter the client sends; only users who pass its check on who is asking (a role claim, or a list such as admins) can ask, and they can ask for any of them; fine if that is meant",
      ],
    ]);
  });

  it("is not bounded by the token compared with another client value, or by a cast claim", () => {
    expect(
      lint(stream("  s:\n    query: SELECT * FROM docs WHERE id = subscription.parameter('id') AND auth.user_id() = subscription.parameter('uid')\n")).map((f) => f[0]),
    ).toEqual(["error"]);
    expect(lint(stream("  s:\n    query: SELECT * FROM docs WHERE id = subscription.parameter('id') AND auth.parameter('role') = 'authenticated'::text\n")).map((f) => f[0])).toEqual([
      "error",
    ]);
    expect(lint(stream("  s:\n    query: SELECT * FROM docs WHERE id = subscription.parameter('id') AND auth.parameter('app_metadata') ->> 'role' = 'admin'::text\n")).map((f) => f[0])).toEqual([
      "warning",
    ]);
    expect(
      lint("bucket_definitions:\n  b:\n    parameters: SELECT id AS org_id FROM orgs WHERE id = request.parameters() ->> 'org' AND request.user_id() = request.parameters() ->> 'uid'\n    data: [SELECT * FROM t WHERE org_id = bucket.org_id]\n").map(
        (f) => f[0],
      ),
    ).toEqual(["error"]);
  });

  it("fails a client parameter in an OR branch beside the token check", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM todos WHERE list_id = subscription.parameter('list') OR owner_id = auth.user_id()\n")).map((f) => f[0])).toEqual(["error"]);
  });

  it("accepts a client parameter bounded by a token check, and a query with neither", () => {
    expect(
      lint(stream("  list:\n    query: SELECT * FROM todos WHERE list_id = subscription.parameter('list_id') AND owner_id = auth.user_id()\n")),
    ).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT * FROM todos\n"))).toEqual([]);
    // Words in a string are not a parameter read.
    expect(lint(stream("  s:\n    query: SELECT * FROM notes WHERE body = 'subscription.parameter(x)'\n"))).toEqual([]);
  });
});

describe("client-scoped on sync rules", () => {
  it("fails a parameter query that reads request.parameters() or user_parameters and no token value", () => {
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.parameters() ->> 'id' AS id\n    data: [SELECT * FROM lists WHERE id = bucket.id]\n")).toEqual([
      ["error", 3, "bucket b, parameters[0] takes its bucket parameters from what the client sends, and nothing limits them to the requesting user, so any client can ask for any bucket"],
    ]);
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT user_parameters.id AS id\n    data: [SELECT * FROM lists WHERE id = bucket.id]\n").map((f) => f[0])).toEqual(["error"]);
  });

  it("fails a parameter query whose token check sits in an OR branch", () => {
    expect(
      lint("bucket_definitions:\n  b:\n    parameters: SELECT id FROM lists WHERE id = request.parameters() ->> 'id' OR owner_id = request.user_id()\n    data: [SELECT * FROM lists WHERE id = bucket.id]\n").map(
        (f) => f[0],
      ),
    ).toEqual(["error"]);
  });

  it("accepts a parameter query that checks the token too", () => {
    expect(
      lint("bucket_definitions:\n  b:\n    parameters: SELECT id FROM lists WHERE id = request.parameters() ->> 'id' AND owner_id = request.user_id()\n    data: [SELECT * FROM lists WHERE id = bucket.id]\n"),
    ).toEqual([]);
  });
});

describe("client-scoped on the corpus", () => {
  it("catches every planted leak that expects it", () => {
    const planted = plantedExpecting("client-scoped");
    expect(planted.map((p) => p.file)).toEqual(["client-parameter-scope.yaml"]);
    for (const p of planted) expect(lintSyncConfig(p.text, p.file, [clientScoped]).map((f) => f.level), p.file).toContain(p.level);
  });

  it("finds exactly these in the real configs", () => {
    expect(corpusFindings("real", [clientScoped])).toEqual([
      "powersync-js-text-collab-legacy.yaml:8 error",
      "powersync-js-text-collab.yaml:10 error",
      "powersync-js-text-collab.yaml:11 error",
      "powersync-js-time-based.yaml:7 error",
    ]);
  });
});
