import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Audience } from "../lint/audience.ts";
import { applyMigrations } from "../lint/migrations.ts";
import { parseSyncConfig } from "../sync/config.ts";
import { compareAudience, diffExposure, type ExposureDiff, sameAudience, type TableDiff } from "./diff.ts";
import { exposureJson } from "./format.ts";
import { type ExposureMap, exposureMap, type Schema } from "./map.ts";

const CORPUS = new URL("../../../../corpus/", import.meta.url);
const corpus = (name: string) => readFileSync(new URL(name, CORPUS), "utf8");

function schemaOf(...sql: string[]): Schema {
  const m = applyMigrations(sql.map((s, n) => ({ file: `${n}.sql`, sql: s })));
  return (table) => m.tables.get(table);
}

const map = (yaml: string, schema?: Schema) => exposureMap(parseSyncConfig(yaml), schema);

/** Sync streams, each with its queries, every one auto-subscribed unless named in `onDemand`. */
function streams(body: Record<string, string[]>, onDemand: string[] = []): string {
  const each = Object.entries(body).map(
    ([name, queries]) => `  ${name}:\n    auto_subscribe: ${!onDemand.includes(name)}\n    queries:\n${queries.map((q) => `      - ${q}`).join("\n")}`,
  );
  return `config:\n  edition: 3\nstreams:\n${each.join("\n")}\n`;
}

const TODO_SCHEMA = schemaOf(`
  create table public.lists (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    name text not null,
    owner_id uuid not null references auth.users (id)
  );
  create table public.todos (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    description text not null,
    completed boolean not null default false,
    created_by uuid references auth.users (id),
    completed_by uuid references auth.users (id),
    list_id uuid not null references public.lists (id) on delete cascade
  );`);

const APP = `
  create table lists (id uuid primary key, name text, owner_id uuid references auth.users, is_public boolean);
  create table members (id uuid primary key, org_id uuid not null, user_id uuid not null references auth.users, email text, role text);
  create table notes (id uuid primary key, owner_id uuid references auth.users, body text);`;
const APP_SCHEMA = schemaOf(APP);

const OWN_LISTS = "SELECT id, name FROM lists WHERE owner_id = auth.user_id()";
const OWN_NOTES = "SELECT id, body FROM notes WHERE owner_id = auth.user_id()";

const diff = (before: string, after: string, schema: Schema | undefined = APP_SCHEMA) => diffExposure(map(before, schema), map(after, schema));

const NOTHING: ExposureDiff = { changed: false, widened: false, tables: [], unread: { added: [], removed: [] } };

const owner: Audience = { kind: "owner", column: "owner_id" };
const ownerOfList: Audience = { kind: "owner", column: "list_id", parent: { table: "lists", column: "owner_id" } };
const group: Audience = { kind: "group", via: "with.my_orgs" };
const role: Audience = { kind: "role" };
const fixed: Audience = { kind: "fixed" };
const client: Audience = { kind: "client" };
const everyone: Audience = { kind: "everyone" };
const mixed: Audience = { kind: "everyone", mixed: true };

describe("diffExposure on the same map", () => {
  const files = ["real", "planted"].flatMap((dir) => readdirSync(new URL(`${dir}/`, CORPUS)).map((f) => `${dir}/${f}`));

  it.each(files)("finds nothing in %s, with or without a schema", (file) => {
    for (const schema of [undefined, TODO_SCHEMA]) {
      const m = map(corpus(file), schema);
      expect(diffExposure(m, m)).toEqual(NOTHING);
      expect(diffExposure(m, structuredClone(m))).toEqual(NOTHING);
    }
  });
});

describe("the to-do list demo and its planted copy", () => {
  const published = map(corpus("real/powersync-js-todolist.yaml"), TODO_SCHEMA);
  const planted = map(corpus("planted/missing-owner-filter.yaml"), TODO_SCHEMA);

  it("finds that every todo now reaches every user, through the query that lost its owner filter", () => {
    const d = diffExposure(published, planted);
    expect(d.changed).toBe(true);
    expect(d.widened).toBe(true);
    expect(d.tables.map((t) => t.table)).toEqual(["todos"]);
    const todos = d.tables[0];
    expect(todos?.status).toBe("changed");
    expect(todos?.audience).toEqual({ before: ownerOfList, after: everyone, direction: "wider" });
    expect(todos?.queries.added).toEqual([]);
    expect(todos?.queries.removed).toEqual([]);
    expect(todos?.queries.changed).toEqual([
      {
        stream: "user_data",
        query: { before: "queries[1]", after: "queries[1]" },
        sql: {
          before: "SELECT todos.* FROM todos INNER JOIN lists ON todos.list_id = lists.id WHERE lists.owner_id = auth.user_id()",
          after: "SELECT todos.* FROM todos INNER JOIN lists ON todos.list_id = lists.id",
        },
        audience: { before: ownerOfList, after: everyone, direction: "wider" },
      },
    ]);
    // Every column the query sends now reaches every user; none was added or dropped.
    expect(todos?.columns.added).toEqual([]);
    expect(todos?.columns.removed).toEqual([]);
    expect(todos?.columns.audience.map((c) => [c.name, c.change.direction])).toEqual(
      ["id", "created_at", "completed_at", "description", "completed", "created_by", "completed_by", "list_id"].map((n) => [n, "wider"]),
    );
  });

  it("finds the fix narrower, and not widening", () => {
    const d = diffExposure(planted, published);
    expect(d.widened).toBe(false);
    expect(d.tables[0]?.audience.direction).toBe("narrower");
    expect(d.tables[0]?.queries.changed[0]?.audience?.direction).toBe("narrower");
  });
});

describe("compareAudience", () => {
  it("says wider only where the change surely reaches more users", () => {
    const cases: [Audience, Audience, string][] = [
      [owner, everyone, "wider"],
      [ownerOfList, everyone, "wider"],
      [group, everyone, "wider"],
      [role, everyone, "wider"],
      [fixed, everyone, "wider"],
      // Any client can already ask for any row, and "some rows or all" may be all.
      [client, everyone, "changed"],
      [mixed, everyone, "changed"],
      // A group need not hold the row's owner.
      [owner, group, "changed"],
      // Neither surely holds the other.
      [owner, role, "changed"],
      [owner, fixed, "changed"],
      [owner, mixed, "changed"],
      [group, role, "changed"],
      [role, fixed, "changed"],
      [fixed, client, "changed"],
      [owner, { kind: "owner", column: "created_by" }, "changed"],
      [group, { kind: "group", via: "claim org_id" }, "changed"],
    ];
    for (const [before, after, direction] of cases) {
      expect(compareAudience(before, after), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`).toBe(direction);
      const back = direction === "wider" ? "narrower" : direction;
      expect(compareAudience(after, before), `${JSON.stringify(after)} -> ${JSON.stringify(before)}`).toBe(back);
    }
  });

  it("knows the same audience by its kind and what it names", () => {
    expect(sameAudience(owner, { kind: "owner", column: "owner_id" })).toBe(true);
    expect(sameAudience(owner, ownerOfList)).toBe(false);
    expect(sameAudience(ownerOfList, { kind: "owner", column: "list_id", parent: { table: "lists", column: "created_by" } })).toBe(false);
    expect(sameAudience(group, { kind: "group", via: "with.my_orgs" })).toBe(true);
    expect(sameAudience(group, { kind: "group", via: "claim org_id" })).toBe(false);
    expect(sameAudience(everyone, mixed)).toBe(false);
    expect(sameAudience(mixed, { kind: "everyone", mixed: true })).toBe(true);
    expect(sameAudience(role, fixed)).toBe(false);
  });
});

describe("tables", () => {
  const lists = streams({ mine: [OWN_LISTS] });
  const listsAndNotes = streams({ mine: [OWN_LISTS], notes: [OWN_NOTES] });

  it("a table newly sent is added, with its columns and who receives them", () => {
    const d = diff(lists, listsAndNotes);
    expect(d.widened).toBe(true);
    expect(d.tables).toEqual([
      {
        table: "notes",
        status: "added",
        audience: { after: owner },
        columns: {
          added: [
            { name: "id", audience: owner },
            { name: "body", audience: owner },
          ],
          removed: [],
          audience: [],
          personal: [],
          known: { before: true, after: true },
        },
        queries: { added: [{ stream: "notes", query: "queries[0]", sql: OWN_NOTES, audience: owner, autoSubscribe: true }], removed: [], changed: [] },
      },
    ]);
  });

  it("a table no longer sent is removed, which widens nothing", () => {
    const d = diff(listsAndNotes, lists);
    expect(d.widened).toBe(false);
    expect(d.changed).toBe(true);
    expect(d.tables.map((t) => [t.table, t.status, t.audience, t.columns.removed.map((c) => c.name)])).toEqual([["notes", "removed", { before: owner }, ["id", "body"]]]);
  });
});

describe("queries", () => {
  it("a query that only moved, so its label changed, is no change", () => {
    const d = diff(streams({ s: [OWN_LISTS] }), streams({ s: [OWN_NOTES, OWN_LISTS] }));
    expect(d.tables.map((t) => t.table)).toEqual(["notes"]);
  });

  it("spacing, comments and the case of words are no change", () => {
    const d = diff(streams({ s: [OWN_LISTS] }), streams({ s: ["select id,   name from LISTS where owner_id = auth.user_id()"] }));
    expect(d).toEqual(NOTHING);
  });

  it("another query sending the same columns to the same users is listed, and widens nothing", () => {
    const d = diff(streams({ s: [OWN_LISTS] }), streams({ s: [OWN_LISTS], t: ["SELECT id FROM lists WHERE owner_id = auth.user_id()"] }));
    expect(d.changed).toBe(true);
    expect(d.widened).toBe(false);
    expect(d.tables[0]?.queries.added.map((q) => `${q.stream} ${q.query}`)).toEqual(["t queries[0]"]);
    expect(d.tables[0]?.audience.direction).toBeUndefined();
  });

  it("another query to other users widens the table, since its rows go to both", () => {
    // Owner to fixed alone cannot be ranked; owner and fixed together surely reach more users than owner alone.
    const d = diff(streams({ s: [OWN_LISTS] }), streams({ s: [OWN_LISTS], public: ["SELECT id, name FROM lists WHERE is_public"] }));
    expect(d.tables[0]?.audience).toEqual({ before: owner, after: fixed, direction: "wider" });
    expect(d.widened).toBe(true);
  });

  it("a query edited to another audience it cannot rank is changed, not wider", () => {
    const d = diff(streams({ s: [OWN_LISTS] }), streams({ s: ["SELECT id, name FROM lists WHERE is_public"] }));
    expect(d.tables[0]?.audience).toEqual({ before: owner, after: fixed, direction: "changed" });
    expect(d.tables[0]?.queries.changed[0]?.audience?.direction).toBe("changed");
    expect(d.widened).toBe(false);
    expect(d.changed).toBe(true);
  });

  it("a stream turned automatic is listed and does not count as widening", () => {
    const d = diff(streams({ s: [OWN_LISTS] }, ["s"]), streams({ s: [OWN_LISTS] }));
    expect(d.tables[0]?.queries.changed).toEqual([{ stream: "s", query: { before: "queries[0]", after: "queries[0]" }, autoSubscribe: { before: false, after: true } }]);
    expect(d.widened).toBe(false);
  });
});

describe("columns", () => {
  it("a column added to a query's list is added, with who receives it", () => {
    const d = diff(streams({ s: ["SELECT id FROM lists WHERE owner_id = auth.user_id()"] }), streams({ s: [OWN_LISTS] }));
    expect(d.tables[0]?.columns.added).toEqual([{ name: "name", audience: owner }]);
    expect(d.tables[0]?.queries.changed[0]?.columns).toEqual({ added: ["name"], removed: [] });
    expect(d.widened).toBe(true);
  });

  it("a likely personal column added says so", () => {
    const d = diff(
      streams({ s: ["SELECT id FROM members WHERE user_id = auth.user_id()"] }),
      streams({ s: ["SELECT id, email FROM members WHERE user_id = auth.user_id()"] }),
    );
    expect(d.tables[0]?.columns.added).toEqual([{ name: "email", audience: { kind: "owner", column: "user_id" }, personal: { category: "contact", matched: "email", source: "name" } }]);
  });

  it("a column moved to a query with a wider audience reaches more users, though the table's audience stays", () => {
    const d = diff(
      streams({ own: ["SELECT id, email FROM members WHERE user_id = auth.user_id()"], all: ["SELECT id FROM members"] }),
      streams({ own: ["SELECT id FROM members WHERE user_id = auth.user_id()"], all: ["SELECT id, email FROM members"] }),
    );
    const members = d.tables[0];
    expect(members?.audience.direction).toBeUndefined();
    expect(members?.columns.audience).toEqual([
      {
        name: "email",
        personal: { category: "contact", matched: "email", source: "name" },
        change: { before: { kind: "owner", column: "user_id" }, after: everyone, direction: "wider" },
      },
    ]);
    expect(d.widened).toBe(true);
  });

  it("a comment marker added in a migration is a personal change, not a widening", () => {
    const yaml = streams({ s: [OWN_NOTES] });
    const d = diffExposure(map(yaml, APP_SCHEMA), map(yaml, schemaOf(APP, "comment on column notes.body is 'samesight:personal=health';")));
    expect(d.tables[0]?.columns.personal).toEqual([{ name: "body", after: { category: "health", matched: "samesight:personal=health", source: "comment" } }]);
    expect(d.widened).toBe(false);
  });

  it("a * with no schema leaves the columns unknown: no column is called new or gone, and losing them counts", () => {
    const yaml = corpus("real/powersync-js-todolist.yaml");
    const lost = diffExposure(map(yaml, TODO_SCHEMA), map(yaml));
    expect(lost.tables.map((t) => [t.table, t.columns.known, t.columns.removed])).toEqual([
      ["lists", { before: true, after: false }, []],
      ["todos", { before: true, after: false }, []],
    ]);
    expect(lost.widened).toBe(true);

    const found = diffExposure(map(yaml), map(yaml, TODO_SCHEMA));
    expect(found.tables.map((t) => [t.table, t.columns.known, t.columns.added])).toEqual([
      ["lists", { before: false, after: true }, []],
      ["todos", { before: false, after: true }, []],
    ]);
    expect(found.widened).toBe(false);
  });
});

describe("queries that cannot be read", () => {
  const unreadable = "SELECT * FROM lists WHERE owner_id = auth.user_id() UNION SELECT * FROM lists";

  it("one newly unreadable counts as widening: what it sends cannot be shown", () => {
    const d = diff(streams({ s: [OWN_LISTS] }), streams({ s: [OWN_LISTS, unreadable] }));
    expect(d.unread.added.map((u) => [u.stream, u.query, u.reason])).toEqual([["s", "queries[1]", "who receives its rows cannot be read"]]);
    expect(d.tables).toEqual([]);
    expect(d.widened).toBe(true);
  });

  it("one that can be read now is listed as removed", () => {
    const d = diff(streams({ s: [OWN_LISTS, unreadable] }), streams({ s: [OWN_LISTS] }));
    expect(d.unread.removed.map((u) => u.query)).toEqual(["queries[1]"]);
    expect(d.widened).toBe(false);
    expect(d.changed).toBe(true);
  });
});

describe("sync rules and streams", () => {
  it("says the kind changed, and compares who receives each table", () => {
    const rules = `
bucket_definitions:
  user_lists:
    parameters: SELECT id AS list_id FROM lists WHERE owner_id = request.user_id()
    data:
      - SELECT * FROM lists WHERE id = bucket.list_id
      - SELECT * FROM todos WHERE list_id = bucket.list_id
`;
    const d = diffExposure(map(rules, TODO_SCHEMA), map(corpus("real/powersync-js-todolist.yaml"), TODO_SCHEMA));
    expect(d.kind).toEqual({ before: "bucket definitions", after: "streams" });
    expect(d.changed).toBe(true);
    expect(d.widened).toBe(false);
    // The same users get the same columns of each table, through other buckets and streams.
    for (const t of d.tables) {
      expect(t.audience.direction, t.table).toBeUndefined();
      expect(t.columns.added, t.table).toEqual([]);
      expect(t.columns.removed, t.table).toEqual([]);
    }
  });
});

describe("maps read back from samesight exposure --format json", () => {
  it("diff as the maps they were printed from", () => {
    const printed = (m: ExposureMap) =>
      JSON.parse(JSON.stringify(exposureJson([{ file: "sync-config.yaml", map: m, lineOf: () => undefined }], { files: ["sync-config.yaml"], migrations: null, unreadable: [] }))).maps[0];
    const before = map(streams({ s: ["SELECT id FROM members WHERE user_id = auth.user_id()", "SELECT id FROM lists WHERE owner_id = auth.user_id() UNION SELECT id FROM lists"] }));
    const after = map(
      `bucket_definitions:\n  b:\n    parameters: SELECT org_id FROM members WHERE user_id = request.user_id()\n    data:\n      - SELECT id, email FROM members WHERE org_id = bucket.org_id\n`,
      APP_SCHEMA,
    );
    const direct = diffExposure(before, after);
    expect(direct.tables[0]?.columns.added.map((c) => c.personal?.category)).toEqual(["contact"]);
    expect(direct.kind).toBeDefined();
    expect(direct.unread.removed).toHaveLength(1);
    expect(diffExposure(printed(before), printed(after))).toEqual(direct);
  });
});

describe("what decides a group", () => {
  const notes = "SELECT id, body FROM notes WHERE owner_id IN my_people";

  it("an edited stream CTE is a change of the query, though the query reads the same", () => {
    const at = (who: string) => `config:\n  edition: 3\nstreams:\n  s:\n    auto_subscribe: true\n    with:\n      my_people: SELECT user_id FROM ${who} WHERE org_id = auth.parameter('org_id')\n    query: ${notes}\n`;
    const d = diff(at("admins"), at("members"));
    expect(d.changed).toBe(true);
    expect(d.tables[0]?.queries.changed).toEqual([
      {
        stream: "s",
        query: { before: "query", after: "query" },
        decidedBy: [
          {
            name: "with.my_people",
            before: "SELECT user_id FROM admins WHERE org_id = auth.parameter('org_id')",
            after: "SELECT user_id FROM members WHERE org_id = auth.parameter('org_id')",
          },
        ],
      },
    ]);
    // Who the group holds now cannot be ranked against who it held.
    expect(d.widened).toBe(false);
  });

  it("an edited bucket parameter query is a change of each data query it decides", () => {
    const at = (who: string) => `bucket_definitions:\n  b:\n    parameters: SELECT org_id FROM ${who} WHERE user_id = request.user_id()\n    data:\n      - SELECT id, body FROM notes WHERE org_id = bucket.org_id\n`;
    const d = diff(at("admins"), at("members"));
    expect(d.tables[0]?.queries.changed[0]?.decidedBy?.map((x) => x.name)).toEqual(["parameters[0]"]);
  });

  it("a map printed before queries carried what decides them compares as unchanged there", () => {
    const m = map(streams({ s: [OWN_LISTS] }), APP_SCHEMA);
    const old = structuredClone(m);
    for (const t of old.tables) for (const q of t.queries) delete (q as Partial<typeof q>).decidedBy;
    expect(diffExposure(old, m)).toEqual(NOTHING);
  });
});

describe("a * the schema does not know", () => {
  // notes is not in this schema; lists is.
  const schema = schemaOf("create table lists (id uuid primary key, name text, owner_id uuid references auth.users);");
  const star = "SELECT * FROM notes WHERE owner_id = auth.user_id()";

  it("a column it may have sent, now surely sent to more users, is added and widens", () => {
    const d = diff(streams({ s: [star, "SELECT id FROM notes"] }), streams({ s: [star, "SELECT id, memo FROM notes"] }), schema);
    expect(d.tables[0]?.columns.added).toEqual([{ name: "memo", audience: everyone, before: owner }]);
    expect(d.widened).toBe(true);
  });

  it("a column it may still send is not called narrower, nor removed from a query", () => {
    const d = diff(
      streams({ s: ["SELECT id FROM notes", "SELECT id, secret FROM notes WHERE owner_id = auth.user_id()"] }),
      streams({ s: ["SELECT * FROM notes", "SELECT id, secret FROM notes WHERE owner_id = auth.user_id()"] }),
      schema,
    );
    const notes = d.tables[0];
    expect(notes?.columns.audience).toEqual([]);
    expect(notes?.columns.removed).toEqual([]);
    expect(notes?.queries.changed.map((q) => q.columns)).toEqual([undefined]);
    expect(notes?.columns.known).toEqual({ before: true, after: false });
  });

  it("a column it already sends to every user is not called wider through another query", () => {
    const d = diff(
      streams({ s: ["SELECT * FROM notes", "SELECT id, secret FROM notes WHERE owner_id = auth.user_id()"] }),
      streams({ s: ["SELECT * FROM notes", "SELECT id, secret FROM notes WHERE org_id = auth.parameter('org_id')"] }),
      schema,
    );
    expect(d.tables[0]?.columns.audience).toEqual([]);
    expect(d.tables[0]?.columns.added).toEqual([]);
  });

  it("a * over a table the schema knows only in part counts as unknown", () => {
    const partial = schemaOf("create table base (id uuid primary key, email text); create table notes (like base);");
    const d = diff(streams({ s: ["SELECT id FROM notes WHERE owner_id = auth.user_id()"] }), streams({ s: ["SELECT * FROM notes WHERE owner_id = auth.user_id()"] }), partial);
    expect(d.tables[0]?.columns.known).toEqual({ before: true, after: false });
    expect(d.widened).toBe(true);
  });
});

describe("matching queries", () => {
  it("does not pair queries by label once one was dropped: labels then name other queries", () => {
    const d = diff(streams({ s: [OWN_NOTES, "SELECT id, body, status FROM notes"] }), streams({ s: ["SELECT id, body FROM notes"] }));
    const notes = d.tables[0];
    expect(notes?.queries.changed).toEqual([]);
    expect(notes?.queries.removed.map((q) => q.sql)).toEqual([OWN_NOTES, "SELECT id, body, status FROM notes"]);
    expect(notes?.queries.added.map((q) => q.sql)).toEqual(["SELECT id, body FROM notes"]);
    expect(notes?.audience.direction).toBeUndefined();
    expect(d.widened).toBe(false);
  });

  it("pairs the one query left in a stream on each side, whatever its label", () => {
    const d = diff(streams({ s: [OWN_LISTS, OWN_NOTES] }), streams({ s: ["SELECT id, body FROM notes"] }));
    const notes = d.tables.find((t) => t.table === "notes");
    expect(notes?.queries.changed.map((q) => [q.query, q.audience?.direction])).toEqual([[{ before: "queries[1]", after: "queries[0]" }, "wider"]]);
  });

  it("does not pair the same SQL across streams", () => {
    const d = diff(streams({ s: [OWN_LISTS] }), streams({ t: [OWN_LISTS] }));
    expect(d.tables[0]?.queries.added.map((q) => q.stream)).toEqual(["t"]);
    expect(d.tables[0]?.queries.removed.map((q) => q.stream)).toEqual(["s"]);
    expect(d.widened).toBe(false);
  });

  it("lists changed queries in the after map's order", () => {
    const d = diff(streams({ a: ["SELECT id FROM lists WHERE owner_id = auth.user_id()"], b: [OWN_LISTS] }), streams({ b: ["SELECT id FROM lists"], a: ["SELECT id FROM lists WHERE is_public"] }));
    expect(d.tables[0]?.queries.changed.map((q) => q.stream)).toEqual(["b", "a"]);
  });

  it("a query whose own audience widens counts, though another query already sends the table to every user", () => {
    const d = diff(streams({ s: ["SELECT id FROM lists WHERE owner_id = auth.user_id()"], t: ["SELECT id FROM lists"] }), streams({ s: ["SELECT id FROM lists"], t: ["SELECT id FROM lists"] }));
    expect(d.tables[0]?.audience.direction).toBeUndefined();
    expect(d.tables[0]?.columns.audience).toEqual([]);
    expect(d.tables[0]?.queries.changed[0]?.audience?.direction).toBe("wider");
    expect(d.widened).toBe(true);
  });

  it("an unreadable query compares as written: the same one twice is no change", () => {
    const broken = "SELECT id FROM lists WHERE name = 'open";
    expect(diff(streams({ s: [OWN_LISTS, broken] }), streams({ s: [OWN_LISTS, broken] }))).toEqual(NOTHING);
  });
});

describe("a table's queries together", () => {
  const publicLists = "SELECT id, name FROM lists WHERE is_public";

  it("dropping a query to other users narrows the table", () => {
    const d = diff(streams({ s: [OWN_LISTS], public: [publicLists] }), streams({ s: [OWN_LISTS] }));
    expect(d.tables[0]?.audience).toEqual({ before: fixed, after: owner, direction: "narrower" });
    expect(d.widened).toBe(false);
  });

  it("adding a query while another changes in a way that cannot be ranked stays changed", () => {
    const d = diff(streams({ s: [OWN_LISTS] }), streams({ s: ["SELECT id, name FROM lists WHERE org_id = auth.parameter('org_id')"], public: [publicLists] }));
    expect(d.tables[0]?.audience.direction).toBe("changed");
  });

  it("adding a query that sent nothing readable before is not taken as wider", () => {
    const unreadable = "SELECT id, name FROM lists WHERE is_public UNION SELECT id, name FROM lists";
    const d = diff(streams({ s: [OWN_LISTS], public: [unreadable] }), streams({ s: [OWN_LISTS], public: [publicLists] }));
    expect(d.unread.removed).toHaveLength(1);
    expect(d.tables[0]?.audience.direction).toBe("changed");
  });

  it("adding a second owner column reaches both owners: wider", () => {
    const d = diff(streams({ s: [OWN_LISTS] }), streams({ s: [OWN_LISTS], shared: ["SELECT id, name FROM lists WHERE editor_id = auth.user_id()"] }));
    expect(d.tables[0]?.audience).toEqual({ before: owner, after: { kind: "group", via: "owner_id or editor_id" }, direction: "wider" });
  });

  it("what is wider one way is narrower the other, over every pair of these configs", () => {
    const configs = [
      streams({ s: [OWN_LISTS] }),
      streams({ s: [OWN_LISTS], public: [publicLists] }),
      streams({ s: [publicLists] }),
      streams({ s: ["SELECT id, name FROM lists"] }),
      streams({ s: [OWN_LISTS], all: ["SELECT id FROM lists"] }),
      streams({ s: ["SELECT id, name FROM lists WHERE org_id = auth.parameter('org_id')"] }),
      streams({ s: ["SELECT id, name, owner_id FROM lists WHERE owner_id = auth.user_id()"], t: ["SELECT id FROM lists WHERE auth.parameter('app_metadata') ->> 'role' = 'admin'"] }),
    ].map((y) => map(y, APP_SCHEMA));
    const back = { wider: "narrower", narrower: "wider", changed: "changed" } as const;
    let ranked = 0;
    for (const a of configs) {
      for (const b of configs) {
        const there = diffExposure(a, b);
        const home = diffExposure(b, a);
        expect(home.tables.map((t) => t.table)).toEqual(there.tables.map((t) => t.table));
        there.tables.forEach((t, n) => {
          const d = t.audience.direction;
          if (d === "wider" || d === "narrower") ranked++;
          expect(home.tables[n]?.audience.direction, t.table).toBe(d ? back[d] : undefined);
          const cols = (x: TableDiff | undefined) => Object.fromEntries((x?.columns.audience ?? []).map((c) => [c.name, c.change.direction]));
          expect(cols(home.tables[n])).toEqual(Object.fromEntries(Object.entries(cols(t)).map(([k, v]) => [k, v ? back[v] : v])));
        });
        expect(home.changed).toBe(there.changed);
      }
    }
    // The pairs rank many changes, so the check is not empty.
    expect(ranked).toBeGreaterThan(10);
  });
});

describe("personal columns", () => {
  const yaml = streams({ s: [OWN_NOTES] });

  it("a category changed in a comment marker is listed", () => {
    const d = diffExposure(
      map(yaml, schemaOf(APP, "comment on column notes.body is 'samesight:personal=health';")),
      map(yaml, schemaOf(APP, "comment on column notes.body is 'samesight:personal=financial';")),
    );
    expect(d.tables[0]?.columns.personal.map((c) => [c.before?.category, c.after?.category])).toEqual([["health", "financial"]]);
  });

  it("a marker removed is listed with only its before", () => {
    const d = diffExposure(map(yaml, schemaOf(APP, "comment on column notes.body is 'samesight:personal=health';")), map(yaml, APP_SCHEMA));
    expect(d.tables[0]?.columns.personal).toEqual([{ name: "body", before: { category: "health", matched: "samesight:personal=health", source: "comment" } }]);
  });
});

describe("sameAudience", () => {
  it("compares an owner's parent table", () => {
    expect(sameAudience(ownerOfList, { kind: "owner", column: "list_id", parent: { table: "boards", column: "owner_id" } })).toBe(false);
  });
});
