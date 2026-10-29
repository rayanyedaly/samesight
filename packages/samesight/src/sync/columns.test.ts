import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sentColumns } from "./columns.ts";
import { parseSyncConfig } from "./config.ts";
import { outputTable } from "./scope.ts";

/** A sent column, bare unless `derived` says otherwise. */
const col = (name: string, from: string[], derived = false, jsonKeys: string[] = []) => ({ name, from, derived, jsonKeys });
const columns = (sql: string) => sentColumns(sql).columns;
/** What a call does: "sent", or the message it throws. */
function outcome(f: () => unknown): string {
  try {
    f();
    return "sent";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("sentColumns", () => {
  it("reads SELECT * as every column of the table, aliased or not", () => {
    expect(sentColumns("SELECT * FROM lists WHERE owner_id = auth.user_id()")).toEqual({ table: "lists", deviceTable: "lists", star: true, columns: [] });
    expect(sentColumns("SELECT * FROM public.documents d WHERE d.owner_id = auth.user_id()")).toEqual({ table: "documents", deviceTable: "d", star: true, columns: [] });
    // Listed columns come as well; PowerSync lets them win over the star's.
    expect(sentColumns("SELECT *, lower(email) AS email FROM users")).toEqual({ table: "users", deviceTable: "users", star: true, columns: [col("email", ["email"], true)] });
  });

  it("reads t.* of the output table in a join, and that table's columns beside it", () => {
    expect(sentColumns("SELECT t.* FROM todos AS t JOIN lists l ON t.list_id = l.id WHERE l.owner_id = auth.user_id()")).toEqual({
      table: "todos",
      deviceTable: "t",
      star: true,
      columns: [],
    });
    expect(sentColumns("SELECT todos.*, todos.title AS label, CAST(todos.due AS text) AS due FROM todos INNER JOIN lists ON todos.list_id = lists.id")).toEqual({
      table: "todos",
      deviceTable: "todos",
      star: true,
      columns: [col("label", ["title"]), col("due", ["due"])],
    });
  });

  it("lists explicit columns in order, by their own name or their AS name, without their qualifier", () => {
    expect(sentColumns("SELECT id, name, owner_id AS owner FROM lists")).toEqual({
      table: "lists",
      deviceTable: "lists",
      star: false,
      columns: [col("id", ["id"]), col("name", ["name"]), col("owner", ["owner_id"])],
    });
    expect(columns("SELECT d.id, d.title AS heading, (d.body) FROM documents d")).toEqual([col("id", ["id"]), col("heading", ["title"]), col("body", ["body"])]);
  });

  it("reads an implicit alias, a name right after the expression, as Postgres does", () => {
    expect(columns("SELECT id, lower(email) e, name n, 'x' kind, CASE WHEN archived THEN NULL ELSE email END contact, x::text t FROM users")).toEqual([
      col("id", ["id"]),
      col("e", ["email"], true),
      col("n", ["name"]),
      col("kind", [], true),
      col("contact", ["archived", "email"], true),
      col("t", ["x"]),
    ]);
    // A keyword or the last word of a type ends the expression; it is no alias.
    expect(columns("SELECT email IS NULL, CASE WHEN a THEN b END, x::double precision, y::timestamp with time zone FROM users")).toEqual([
      col("email is null", ["email"], true),
      col("case when a then b end", ["a", "b"], true),
      col("x::double precision", ["x"]),
      col("y::timestamp with time zone", ["y"]),
    ]);
  });

  it("keeps a quoted name's case and lowercases the rest, as Postgres folds them", () => {
    expect(columns('SELECT "createdAt", t."updatedAt" AS "Updated", Title, lower("Email") FROM items t')).toEqual([
      col("createdAt", ["createdAt"]),
      col("Updated", ["updatedAt"]),
      col("title", ["title"]),
      col('lower("Email")', ["Email"], true),
    ]);
  });

  it("reads a cast column, either way, as the column itself", () => {
    expect(columns("SELECT id::text AS id, CAST(created_at AS text) AS created, (score)::integer AS score, CAST(code AS varchar(10)) c, CAST(x::text AS real) AS x FROM items")).toEqual([
      col("id", ["id"]),
      col("created", ["created_at"]),
      col("score", ["score"]),
      col("c", ["code"]),
      col("x", ["x"]),
    ]);
    // A cast of anything else is derived.
    expect(columns("SELECT lower(email)::text AS e, 'x'::text AS k, CAST(a || b AS text) AS ab FROM users")).toEqual([
      col("e", ["email"], true),
      col("k", [], true),
      col("ab", ["a", "b"], true),
    ]);
  });

  it("reads the columns an expression reads, leaving out function and type names, keywords and literals", () => {
    expect(
      columns(
        "SELECT lower(email) AS email_lower, a || ' ' || b AS full_name, 'x' AS kind, 1 AS one, coalesce(nickname, name) AS shown, substring(updated_at FROM 1 FOR 10) AS day, base64(update_data) AS b64 FROM users",
      ),
    ).toEqual([
      col("email_lower", ["email"], true),
      col("full_name", ["a", "b"], true),
      col("kind", [], true),
      col("one", [], true),
      col("shown", ["nickname", "name"], true),
      col("day", ["updated_at"], true),
      col("b64", ["update_data"], true),
    ]);
    // Each column once, in the order it is first read.
    expect(columns("SELECT CASE WHEN b IS NULL THEN a ELSE b || a END AS x FROM t")).toEqual([col("x", ["b", "a"], true)]);
  });

  it("reads the JSON keys -> and ->> pick out, in order", () => {
    expect(columns("SELECT data ->> 'phone' AS phone, data -> 'a' ->> 'b', (meta -> 0 ->> 'x') AS first, data AS whole, data ->> k AS picked FROM users")).toEqual([
      col("phone", ["data"], true, ["phone"]),
      col("data -> 'a' ->> 'b'", ["data"], true, ["a", "b"]),
      col("first", ["meta"], true, ["x"]),
      col("whole", ["data"]),
      col("picked", ["data", "k"], true),
    ]);
  });

  it("names an expression without an alias after its text, as PowerSync's streams compiler does", () => {
    expect(columns("SELECT lower(email), email::text, (name), 1, a||b, NULL FROM users").map((c) => c.name)).toEqual(["lower(email)", "email::text", "name", "1", "a || b", "null"]);
  });

  it("skips DISTINCT, DISTINCT ON (...) and ALL", () => {
    expect(columns("SELECT DISTINCT id, name FROM lists")).toEqual([col("id", ["id"]), col("name", ["name"])]);
    expect(columns("SELECT DISTINCT ON (owner_id, lower(name)) id FROM lists")).toEqual([col("id", ["id"])]);
    expect(columns("SELECT ALL id FROM lists")).toEqual([col("id", ["id"])]);
    expect(columns("SELECT count(DISTINCT owner_id) AS owners FROM lists")).toEqual([col("owners", ["owner_id"], true)]);
  });

  it("reads only the SELECT list: not a subquery in WHERE, nor comments", () => {
    expect(sentColumns("SELECT id, title FROM todos WHERE list_id IN (SELECT id FROM lists WHERE owner_id = auth.user_id() AND secret = 'x')")).toEqual({
      table: "todos",
      deviceTable: "todos",
      star: false,
      columns: [col("id", ["id"]), col("title", ["title"])],
    });
    expect(sentColumns("SELECT id, -- the key, then *\n  name -- not secret, as such\nFROM lists")).toEqual({
      table: "lists",
      deviceTable: "lists",
      star: false,
      columns: [col("id", ["id"]), col("name", ["name"])],
    });
  });

  it("does not take another table's names, or a star inside an expression, for the output table's", () => {
    // A subquery's names are its own tables' columns (PowerSync allows subqueries only in WHERE).
    expect(columns("SELECT id, (SELECT name FROM users) AS owner FROM lists")).toEqual([col("id", ["id"]), col("owner", [], true)]);
    // count(*) sends a count, not every column; a keyword after a dot is a column.
    expect(sentColumns("SELECT count(*) AS n, t.end FROM events t")).toEqual({ table: "events", deviceTable: "t", star: false, columns: [col("n", [], true), col("end", ["end"])] });
    expect(sentColumns("SELECT FROM lists")).toEqual({ table: "lists", deviceTable: "lists", star: false, columns: [] });
  });

  it("throws exactly when outputTable does, with its message", () => {
    for (const sql of [
      "SELECT * FROM a JOIN b ON a.x = b.y",
      "SELECT a.id, b.id FROM a JOIN b ON a.x = b.y",
      "SELECT x.* FROM a JOIN b ON a.x = b.y",
      "SELECT * FROM a LEFT JOIN b ON a.x = b.y",
      "SELECT * FROM auth.users",
      "SELECT todos.id, name FROM todos JOIN lists ON todos.list_id = lists.id",
      "SELECT t.id, t.email::text FROM todos t JOIN lists l ON t.list_id = l.id",
      "SELECT lists.id FROM lists l",
      "SELECT auth.user_id() AS me, * FROM lists",
      "SELECT request.user_id() AS user_id",
      "SELECT id /* note */ FROM lists",
      "SELECT 'unclosed FROM lists",
      "",
    ]) {
      const expected = outcome(() => outputTable(sql));
      expect(expected, sql).not.toBe("sent");
      expect(outcome(() => sentColumns(sql)), sql).toBe(expected);
    }
  });
});

// Real sync configs from PowerSync's demos, and copies with a planted leak: see corpus/SOURCES.md.
const corpus = fileURLToPath(new URL("../../../../corpus/", import.meta.url));
const configs = ["real", "planted"].flatMap((dir) =>
  readdirSync(join(corpus, dir))
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => `${dir}/${f}`),
);
/** Every query of a config: the data queries, and the CTEs or parameter queries that pick rows. */
const queries = (file: string) => parseSyncConfig(readFileSync(join(corpus, file), "utf8")).streams.flatMap((s) => [...s.ctes.values(), ...s.queries.map((q) => q.sql)]);

describe("sentColumns on the corpus", () => {
  it("throws on a query exactly when outputTable does, with its message", () => {
    const outcomes = configs.flatMap(queries).map((sql) => {
      const expected = outcome(() => outputTable(sql));
      expect(outcome(() => sentColumns(sql)), sql).toBe(expected);
      return expected;
    });
    // Both sides are exercised: data queries are read, parameter queries without FROM are not.
    expect(outcomes).toContain("sent");
    expect(outcomes.filter((o) => o !== "sent")).not.toEqual([]);
  });

  it("reads the to-do list demo", () => {
    expect(queries("real/powersync-js-todolist.yaml").map((sql) => sentColumns(sql))).toMatchInlineSnapshot(`
      [
        {
          "columns": [],
          "deviceTable": "lists",
          "star": true,
          "table": "lists",
        },
        {
          "columns": [],
          "deviceTable": "todos",
          "star": true,
          "table": "todos",
        },
      ]
    `);
  });

  it("reads the text collab demo's base64 column as derived from update_data", () => {
    expect(queries("real/powersync-js-text-collab.yaml").map((sql) => sentColumns(sql))).toEqual([
      { table: "documents", deviceTable: "documents", star: true, columns: [] },
      {
        table: "document_updates",
        deviceTable: "document_updates",
        star: false,
        columns: [col("id", ["id"]), col("document_id", ["document_id"]), col("update_b64", ["update_data"], true)],
      },
    ]);
  });
});
