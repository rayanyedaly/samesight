import { describe, expect, it } from "vitest";
import { parseSyncConfig } from "./config.ts";
import { parseStreams } from "./streams.ts";
import { auditScope, outputTable, tablesNamed } from "./scope.ts";

const config = (streams: string[]) => ["config:", "  edition: 3", "streams:", ...streams, ""].join("\n");

describe("outputTable", () => {
  it("reads the table a query sends, alone or through joins", () => {
    expect(outputTable("SELECT * FROM lists WHERE owner_id = auth.user_id()")).toEqual({ table: "lists", deviceTable: "lists", reads: ["lists"], aliases: { lists: "lists" } });
    expect(outputTable("SELECT id, name FROM public.lists")).toEqual({ table: "lists", deviceTable: "lists", reads: ["lists"], aliases: { lists: "lists" } });
    expect(outputTable("SELECT todos.* FROM todos INNER JOIN lists ON todos.list_id = lists.id WHERE lists.owner_id = auth.user_id()")).toEqual({
      table: "todos",
      deviceTable: "todos",
      reads: ["todos", "lists"],
      aliases: { todos: "todos", lists: "lists" },
    });
    // A join's alias names its table.
    expect(outputTable("SELECT todos.* FROM todos JOIN lists l ON todos.list_id = l.id")).toEqual({
      table: "todos",
      deviceTable: "todos",
      reads: ["todos", "lists"],
      aliases: { todos: "todos", l: "lists" },
    });
    // A qualified column renamed with AS, as PowerSync's group chat demo writes it.
    expect(outputTable("SELECT profiles.id, profiles.id as profile_id FROM profiles JOIN messages ON messages.recipient_id = profiles.id")).toEqual({
      table: "profiles",
      deviceTable: "profiles",
      reads: ["profiles", "messages"],
      aliases: { profiles: "profiles", messages: "messages" },
    });
  });

  it("names the device table after the output table's alias, as PowerSync does", () => {
    expect(outputTable("SELECT * FROM documents d WHERE d.owner_id = auth.user_id()")).toEqual({ table: "documents", deviceTable: "d", reads: ["documents"], aliases: { d: "documents" } });
    expect(outputTable("SELECT * FROM public.lists AS mine")).toEqual({ table: "lists", deviceTable: "mine", reads: ["lists"], aliases: { mine: "lists" } });
    expect(outputTable("SELECT t.* FROM todos AS t JOIN lists l ON t.list_id = l.id")).toEqual({
      table: "todos",
      deviceTable: "t",
      reads: ["todos", "lists"],
      aliases: { t: "todos", l: "lists" },
    });
  });

  it("refuses what it cannot attribute to one table", () => {
    expect(() => outputTable("SELECT * FROM a JOIN b ON a.x = b.y")).toThrow(/across a join/);
    expect(() => outputTable("SELECT a.id, b.id FROM a JOIN b ON a.x = b.y")).toThrow(/more than one table/);
    expect(() => outputTable("SELECT x.* FROM a JOIN b ON a.x = b.y")).toThrow(/does not name/);
    expect(() => outputTable("SELECT * FROM a LEFT JOIN b ON a.x = b.y")).toThrow(/only \[INNER\] JOIN/);
    expect(() => outputTable("SELECT * FROM a JOIN b USING (x)")).toThrow(/without ON/);
    expect(() => outputTable("SELECT * FROM auth.users")).toThrow(/outside public/);
    expect(() => outputTable("SELECT * FROM postgres.public.lists")).toThrow(/names postgres\.public\.lists with its database; only tables named public\.t or t are read/);
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
    expect(s.deviceTables).toEqual({ lists: "lists", todos: "todos" });
    expect(s.findings).toEqual([expect.objectContaining({ status: "ok", detail: "1 stream, 2 queries, sending lists, todos" })]);
  });

  it("maps an aliased output table back to its source, and fails when one device name would hold two tables", () => {
    const aliased = auditScope(
      parseStreams(
        config([
          "  mine:",
          "    auto_subscribe: true",
          "    queries:",
          "      - SELECT * FROM lists l WHERE l.owner_id = auth.user_id()",
          "      - SELECT t.* FROM todos t JOIN lists ON t.list_id = lists.id",
          "      - SELECT * FROM lists WHERE archived = false",
        ]),
      ),
    );
    expect(aliased.synced).toEqual(["lists", "todos"]);
    expect(aliased.deviceTables).toEqual({ l: "lists", lists: "lists", t: "todos" });
    expect(aliased.findings.map((f) => f.status)).toEqual(["ok"]);

    const clash = auditScope(
      parseStreams(config(["  a:", "    auto_subscribe: true", "    queries:", "      - SELECT * FROM todos AS lists", "      - SELECT * FROM lists"])),
    );
    expect(clash.findings).toEqual([
      expect.objectContaining({
        status: "fail",
        detail: "a queries[1] sends lists rows as lists, a name devices already hold todos rows under; rows of the two could not be told apart: SELECT * FROM lists",
      }),
    ]);
    // The other order, across streams.
    const reverse = auditScope(
      parseStreams(config(["  a:", "    auto_subscribe: true", "    query: SELECT * FROM lists", "  b:", "    auto_subscribe: true", "    query: SELECT * FROM todos AS lists"])),
    );
    expect(reverse.findings).toEqual([expect.objectContaining({ status: "fail", detail: expect.stringMatching(/^b query sends todos rows as lists, a name devices already hold lists rows under/) })]);
  });

  it("maps an aliased data query of bucket definitions back to its source", () => {
    const s = auditScope(
      parseSyncConfig("bucket_definitions:\n  b:\n    parameters: SELECT request.user_id() AS user_id\n    data:\n      - SELECT t.* FROM todos t WHERE t.owner_id = bucket.user_id\n").streams,
      "bucket definitions",
    );
    expect([s.synced, s.deviceTables, s.findings.map((f) => f.status)]).toEqual([["todos"], { t: "todos" }, ["ok"]]);
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
