import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../lint/migrations.ts";
import { parseSyncConfig } from "../sync/config.ts";
import { type ExposureMap, exposureMap, type Schema } from "./map.ts";

const corpus = (name: string) => readFileSync(new URL(`../../../../corpus/${name}`, import.meta.url), "utf8");

/** A schema read from migrations, as the CLI builds it. */
function schemaOf(...sql: string[]): Schema {
  const m = applyMigrations(sql.map((s, n) => ({ file: `${n}.sql`, sql: s })));
  return (table) => m.tables.get(table);
}

const map = (yaml: string, schema?: Schema) => exposureMap(parseSyncConfig(yaml), schema);

/** table -> query -> [audience kind, columns with their personal category] */
function brief(m: ExposureMap) {
  return Object.fromEntries(
    m.tables.map((t) => [
      t.table,
      t.queries.map((q) => ({
        query: `${q.stream} ${q.query}`,
        audience: q.audience.kind,
        source: q.columns.source,
        columns: q.columns.items.map((c) => (c.personal ? `${c.name} [${c.personal.category}]` : c.name)),
      })),
    ]),
  );
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

describe("the to-do list demo", () => {
  it("sends each user their own lists and todos, with no personal column, as streams and as sync rules", () => {
    expect(brief(map(corpus("real/powersync-js-todolist.yaml"), TODO_SCHEMA))).toEqual({
      lists: [{ query: "user_data queries[0]", audience: "owner", source: "schema", columns: ["id", "created_at", "name", "owner_id"] }],
      todos: [
        {
          query: "user_data queries[1]",
          audience: "owner",
          source: "schema",
          columns: ["id", "created_at", "completed_at", "description", "completed", "created_by", "completed_by", "list_id"],
        },
      ],
    });
    const rules = `
bucket_definitions:
  user_lists:
    parameters: SELECT id AS list_id FROM lists WHERE owner_id = request.user_id()
    data:
      - SELECT * FROM lists WHERE id = bucket.list_id
      - SELECT * FROM todos WHERE list_id = bucket.list_id
`;
    const m = map(rules, TODO_SCHEMA);
    expect(m.tables.map((t) => [t.table, t.queries.map((q) => q.audience)])).toEqual([
      ["lists", [{ kind: "owner", column: "owner_id" }]],
      ["todos", [{ kind: "owner", column: "list_id", parent: { table: "lists", column: "owner_id" } }]],
    ]);
  });

  it("without a schema, a * is unknown and only listed columns are read", () => {
    const m = map(corpus("real/powersync-js-todolist.yaml"));
    expect(m.tables.map((t) => t.queries.map((q) => q.columns))).toEqual([
      [{ source: "unknown", complete: false, items: [] }],
      [{ source: "unknown", complete: false, items: [] }],
    ]);
  });

  it("the planted copy, whose todos query lost its owner filter, sends every todo to every user", () => {
    const m = map(corpus("planted/missing-owner-filter.yaml"), TODO_SCHEMA);
    expect(m.tables.map((t) => [t.table, t.queries.map((q) => q.audience.kind)])).toEqual([
      ["lists", ["owner"]],
      ["todos", ["everyone"]],
    ]);
  });
});

const ORG_SCHEMA = schemaOf(`
  create table members (id uuid primary key, org_id uuid not null, user_id uuid not null references auth.users, email text, full_name text, role text);
  create table notes (id uuid primary key, owner_id uuid references auth.users, body text);
  comment on column notes.body is 'What the patient said. samesight:personal=health';
`);

describe("an organisation's members", () => {
  const yaml = `
config:
  edition: 3
streams:
  org_members:
    auto_subscribe: true
    with:
      my_orgs: SELECT org_id FROM members WHERE user_id = auth.user_id()
    query: SELECT * FROM members WHERE org_id IN my_orgs
  my_notes:
    auto_subscribe: true
    query: SELECT id, body FROM notes WHERE owner_id = auth.user_id()
`;

  it("sends each member's email and name to the rest of the group, and marks them", () => {
    expect(brief(map(yaml, ORG_SCHEMA))).toEqual({
      members: [{ query: "org_members query", audience: "group", source: "schema", columns: ["id", "org_id", "user_id", "email [contact]", "full_name [identifier]", "role"] }],
      notes: [{ query: "my_notes query", audience: "owner", source: "list", columns: ["id", "body [health]"] }],
    });
    expect(map(yaml, ORG_SCHEMA).tables[0]?.queries[0]?.audience).toEqual({ kind: "group", via: "with.my_orgs" });
  });

  it("reads personal data through expressions, renames and JSON keys, and not from literals", () => {
    const m = map(
      `
config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    query: SELECT id, lower(email) AS contact, data ->> 'phone' AS reach, 'member' AS kind, full_name AS who FROM members WHERE org_id = auth.parameter('org_id')
`,
      ORG_SCHEMA,
    );
    expect(m.tables[0]?.queries[0]?.columns.items.map((c) => [c.name, c.personal?.category ?? null])).toEqual([
      ["id", null],
      ["contact", "contact"],
      ["reach", "contact"],
      ["kind", null],
      ["who", "identifier"],
    ]);
  });

  it("lets a not-personal marker settle a column, whatever it is renamed to", () => {
    const schema = schemaOf(`create table members (id uuid primary key, email text); comment on column members.email is 'A shared inbox. samesight:not-personal';`);
    const m = map(
      `
config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    query: SELECT id, email AS email FROM members
`,
      schema,
    );
    expect(m.tables[0]?.queries[0]?.columns.items.every((c) => c.personal === undefined)).toBe(true);
  });

  it("does not let one column marked not personal hide another read beside it", () => {
    const schema = schemaOf(`create table members (id uuid primary key, shared text, email text); comment on column members.shared is 'samesight:not-personal';`);
    const m = map(
      `
config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    query: SELECT id, concat(shared, email) AS x, shared AS email_copy FROM members
`,
      schema,
    );
    expect(m.tables[0]?.queries[0]?.columns.items.map((c) => [c.name, c.personal?.matched ?? null])).toEqual([
      ["id", null],
      ["x", "email"],
      ["email_copy", null],
    ]);
  });

  it("records the JSON key a match was made on", () => {
    const m = map(
      `
config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    query: SELECT id, data ->> 'phone' AS reach FROM members
`,
      ORG_SCHEMA,
    );
    expect(m.tables[0]?.queries[0]?.columns.items[1]).toMatchObject({ name: "reach", jsonKey: "phone", personal: { category: "contact" } });
  });
});

describe("sync rules", () => {
  it("give each path its own audience and the widest overall, and * leaves out columns starting with _", () => {
    const schema = schemaOf(`create table workspace (id uuid primary key, "userId" uuid, visibility text, _internal text, owner_email text);`);
    const m = map(
      `
bucket_definitions:
  by_workspace:
    parameters:
      - SELECT id AS workspace_id FROM workspace WHERE workspace."userId" = token_parameters.user_id
      - SELECT id AS workspace_id FROM workspace WHERE visibility = 'Public'
    data:
      - SELECT * FROM workspace WHERE workspace.id = bucket.workspace_id
`,
      schema,
    );
    const q = m.tables[0]?.queries[0];
    expect(q?.paths.map((p) => [p.via, p.audience.kind])).toEqual([
      ["parameters[0]", "owner"],
      ["parameters[1]", "fixed"],
    ]);
    expect(q?.audience.kind).toBe("fixed");
    expect(q?.columns.items.map((c) => c.name)).toEqual(["id", "userId", "visibility", "owner_email"]);
    expect(q?.columns.items.find((c) => c.name === "owner_email")?.personal?.category).toBe("contact");
  });

  it("the Trello demo sends every user's email to everyone; its name, in a table not named for people, is not counted", () => {
    const schema = schemaOf(`create table trellouser (id text primary key, name text, email text);`);
    const users = map(corpus("real/powersync-dart-trello-legacy.yaml"), schema).tables.find((t) => t.table === "trellouser");
    expect(users?.queries.map((q) => [q.audience.kind, q.columns.items.filter((c) => c.personal).map((c) => c.name)])).toEqual([["everyone", ["email"]]]);
  });
});

describe("what it cannot read", () => {
  it("lists queries whose table or audience cannot be read, with why", () => {
    const m = map(`
config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    queries:
      - SELECT * FROM a JOIN b ON a.id = b.a_id WHERE b.owner_id = auth.user_id()
      - SELECT * FROM a WHERE owner_id = auth.user_id() UNION SELECT * FROM a
`);
    expect(m.tables).toEqual([]);
    expect(m.unread.map((u) => [u.query, u.reason])).toEqual([
      ["queries[0]", "selects * across a join; name the table, as in t.*"],
      ["queries[1]", "who receives its rows cannot be read"],
    ]);
  });

  it("a * on a table known only in part says so", () => {
    const schema = schemaOf(`create table base (id uuid primary key, email text); create table copy (like base);`);
    const m = map(
      `
config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    query: SELECT * FROM copy
`,
      schema,
    );
    expect(m.tables[0]?.queries[0]?.columns).toMatchObject({ source: "schema", complete: false });
  });
});

describe("order", () => {
  it("sorts tables by name and keeps each table's queries in config order", () => {
    const m = map(`
config:
  edition: 3
streams:
  b:
    auto_subscribe: true
    queries:
      - SELECT id FROM zebra
      - SELECT id FROM apple WHERE owner_id = auth.user_id()
  a:
    query: SELECT id FROM apple
`);
    expect(m.tables.map((t) => [t.table, t.queries.map((q) => `${q.stream} ${q.query} ${q.autoSubscribe}`)])).toEqual([
      ["apple", ["b queries[1] true", "a query false"]],
      ["zebra", ["b queries[0] true"]],
    ]);
  });
});
