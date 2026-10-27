import { describe, expect, it } from "vitest";
import { parseStreams } from "./streams.ts";
import { auditScope, outputTable, tablesNamed } from "./scope.ts";

const config = (streams: string[]) => ["config:", "  edition: 3", "streams:", ...streams, ""].join("\n");

describe("outputTable", () => {
  it("reads the table a query sends, alone or through joins", () => {
    expect(outputTable("SELECT * FROM lists WHERE owner_id = auth.user_id()")).toMatchObject({ table: "lists", reads: ["lists"] });
    expect(outputTable("SELECT id, name FROM public.lists")).toMatchObject({ table: "lists", reads: ["lists"] });
    expect(outputTable("SELECT todos.* FROM todos INNER JOIN lists ON todos.list_id = lists.id WHERE lists.owner_id = auth.user_id()")).toMatchObject({
      table: "todos",
      reads: ["todos", "lists"],
    });
    // A join's alias names its table.
    expect(outputTable("SELECT todos.* FROM todos JOIN lists l ON todos.list_id = l.id")).toEqual({ table: "todos", reads: ["todos", "lists"], aliases: { todos: "todos", l: "lists" } });
    // A qualified column renamed with AS, as PowerSync's group chat demo writes it.
    expect(outputTable("SELECT profiles.id, profiles.id as profile_id FROM profiles JOIN messages ON messages.recipient_id = profiles.id")).toMatchObject({
      table: "profiles",
      reads: ["profiles", "messages"],
    });
  });

  it("refuses what it cannot attribute to one table", () => {
    expect(() => outputTable("SELECT * FROM a JOIN b ON a.x = b.y")).toThrow(/across a join/);
    expect(() => outputTable("SELECT a.id, b.id FROM a JOIN b ON a.x = b.y")).toThrow(/more than one table/);
    expect(() => outputTable("SELECT x.* FROM a JOIN b ON a.x = b.y")).toThrow(/does not name/);
    expect(() => outputTable("SELECT * FROM lists AS mine")).toThrow(/calls lists mine/);
    expect(() => outputTable("SELECT t.* FROM todos AS t JOIN lists l ON t.list_id = l.id")).toThrow(/calls todos t/);
    expect(() => outputTable("SELECT * FROM a LEFT JOIN b ON a.x = b.y")).toThrow(/only \[INNER\] JOIN/);
    expect(() => outputTable("SELECT * FROM a JOIN b USING (x)")).toThrow(/without ON/);
    expect(() => outputTable("SELECT * FROM auth.users")).toThrow(/outside public/);
  });

  it("refuses an unqualified column in a join: it could be another table's, sent with these rows", () => {
    expect(() => outputTable("SELECT todos.id, name FROM todos JOIN lists ON todos.list_id = lists.id")).toThrow(/selects name without its table/);
    expect(() => outputTable("SELECT todos.*, name AS list_name FROM todos JOIN lists ON todos.list_id = lists.id")).toThrow(/selects name without its table/);
  });

  it("refuses an outer join after the first join, not only in first place", () => {
    expect(() => outputTable("SELECT todos.* FROM todos JOIN lists ON todos.list_id = lists.id LEFT JOIN shares ON shares.list_id = lists.id")).toThrow(
      /only \[INNER\] JOIN/,
    );
    expect(() => outputTable("SELECT todos.* FROM todos JOIN lists ON true FULL JOIN x ON true")).toThrow(/only \[INNER\] JOIN/);
  });
});

describe("tablesNamed", () => {
  it("finds tables in subqueries, not just the top FROM", () => {
    expect(tablesNamed("SELECT * FROM todos WHERE list_id IN (SELECT list_id FROM public.list_shares WHERE user_id = auth.user_id())")).toEqual([
      "todos",
      "list_shares",
    ]);
  });
});

describe("auditScope", () => {
  it("collects the synced tables of auto-subscribed streams", () => {
    const s = auditScope(
      parseStreams(
        config([
          "  user_data:",
          "    auto_subscribe: true",
          "    queries:",
          "      - SELECT * FROM lists WHERE owner_id = auth.user_id()",
          "      - SELECT todos.* FROM todos JOIN lists ON todos.list_id = lists.id",
        ]),
      ),
    );
    expect(s.synced).toEqual(["lists", "todos"]);
    expect(s.findings).toEqual([expect.objectContaining({ status: "ok", detail: "1 stream, 2 queries, sending lists, todos" })]);
  });

  it("adds the tables CTEs and subqueries read, so their branches get rows", () => {
    const s = auditScope(
      parseStreams(
        config([
          "  shared:",
          "    auto_subscribe: true",
          "    with:",
          "      mine: SELECT list_id FROM list_shares WHERE user_id = auth.user_id()",
          "    queries:",
          "      - SELECT * FROM todos WHERE list_id IN mine",
          "      - SELECT * FROM lists WHERE id IN (SELECT list_id FROM list_members)",
        ]),
      ),
    );
    expect(s.synced).toEqual(["lists", "todos"]);
    expect(s.reads).toEqual(["list_members", "list_shares", "lists", "todos"]);
  });

  it("warns that a stream devices must subscribe to is not compared, and fails when nothing is", () => {
    const s = auditScope(parseStreams(config(["  one_list:", "    query: SELECT * FROM lists WHERE id = subscription.parameter('id')"])));
    expect(s.synced).toEqual([]);
    expect(s.findings.map((f) => f.status)).toEqual(["warn", "fail"]);
    expect(s.findings[0]?.detail).toMatch(/one_list is not auto_subscribe/);
  });

  it("fails on a query it cannot read", () => {
    const s = auditScope(parseStreams(config(["  all:", "    auto_subscribe: true", "    query: SELECT * FROM a JOIN b ON a.x = b.y"])));
    expect(s.findings).toEqual([expect.objectContaining({ status: "fail", check: "streams" })]);
  });
});
