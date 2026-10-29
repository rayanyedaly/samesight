import { describe, expect, it } from "vitest";
import { lineFinder } from "../lint/lint.ts";
import { applyMigrations } from "../lint/migrations.ts";
import { parseSyncConfig } from "../sync/config.ts";
import { exposureJson, formatExposure, MATCHED_BY, type MappedConfig } from "./format.ts";
import { exposureMap, type Schema } from "./map.ts";

/** A schema read from migrations, as the CLI builds it. */
function schemaOf(sql: string): Schema {
  const m = applyMigrations([{ file: "0.sql", sql }]);
  return (table) => m.tables.get(table);
}

/** One sync config mapped as the CLI maps it. */
const mapped = (yaml: string, schema?: Schema, file = "sync-config.yaml"): MappedConfig => ({ file, map: exposureMap(parseSyncConfig(yaml), schema), lineOf: lineFinder(yaml) });

const text = (yaml: string, schema?: Schema) => formatExposure([mapped(yaml, schema)], { migrations: schema !== undefined });

const ORG_SCHEMA = schemaOf(`
  create table members (id uuid primary key, org_id uuid not null, user_id uuid not null references auth.users, email text, full_name text, role text);
  create table notes (id uuid primary key, owner_id uuid references auth.users, body text);
  comment on column notes.body is 'What the patient said. samesight:personal=health';
`);

const ORG = `config:
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

describe("formatExposure", () => {
  it("prints a block per table, who receives it and which columns, then the personal columns others get", () => {
    expect(text(ORG, ORG_SCHEMA)).toBe(
      [
        "members",
        "  sent by  stream org_members, query  (sync-config.yaml:8)",
        "  to       members of the row's group, through with.my_orgs",
        "  columns  id, org_id, user_id, email [contact], full_name [identifier], role  (all columns, from the migrations)",
        "",
        "notes",
        "  sent by  stream my_notes, query  (sync-config.yaml:11)",
        "  to       only the row's owner (owner_id)",
        "  columns  id, body [health, marked in its comment]",
        "",
        "2 tables. 2 likely personal columns reach users other than the row's owner: members.email, members.full_name.",
        MATCHED_BY,
      ].join("\n"),
    );
  });

  it("gives each query that sends a table its own lines, and says when a stream reaches devices only on request", () => {
    const out = text(
      `config:
  edition: 3
streams:
  mine:
    auto_subscribe: true
    query: SELECT id, email FROM members WHERE user_id = auth.user_id()
  directory:
    query: SELECT id, full_name FROM members WHERE org_id = auth.parameter('org_id')
`,
      ORG_SCHEMA,
    );
    expect(out).toBe(
      [
        "members",
        "  sent by  stream mine, query  (sync-config.yaml:6)",
        "  to       only the row's owner (user_id)",
        "  columns  id, email [contact]",
        "  sent by  stream directory, query, when the app subscribes  (sync-config.yaml:8)",
        "  to       members of the row's group, through claim org_id",
        "  columns  id, full_name [identifier]",
        "",
        // The email goes to its owner alone, so only the name is counted.
        "1 table. 1 likely personal column reaches users other than the row's owner: members.full_name.",
        MATCHED_BY,
      ].join("\n"),
    );
  });

  it("shows a bucket's widest audience first, then who it reaches through each parameter query", () => {
    const schema = schemaOf(`create table workspace (id uuid primary key, "userId" uuid, visibility text, _internal text, owner_email text);`);
    const out = text(
      `bucket_definitions:
  by_workspace:
    parameters:
      - SELECT id AS workspace_id FROM workspace WHERE workspace."userId" = token_parameters.user_id
      - SELECT id AS workspace_id FROM workspace WHERE visibility = 'Public'
      - SELECT workspace_id FROM shares WHERE shares.user_id = token_parameters.user_id
    data:
      - SELECT * FROM workspace WHERE workspace.id = bucket.workspace_id
`,
      schema,
    );
    expect(out).toBe(
      [
        "workspace",
        "  sent by  bucket by_workspace, data[0]  (sync-config.yaml:8)",
        "  to       every user, for rows a fixed filter picks",
        "           through parameters[0]: only the row's owner (userId)",
        "           through parameters[1]: every user, for rows a fixed filter picks",
        // Named once, not "through parameters[2]: ..., through parameters[2]".
        "           through parameters[2]: members of the row's group",
        // Sync rules' * leaves _internal out.
        "  columns  id, userId, visibility, owner_email [contact]  (all columns not starting with _, from the migrations)",
        "",
        "1 table. 1 likely personal column reaches users other than the row's owner: workspace.owner_email.",
        MATCHED_BY,
      ].join("\n"),
    );
    // One parameter query, or none, is the audience itself.
    const one = text(`bucket_definitions:\n  everything:\n    data:\n      - SELECT id, email FROM members\n`, ORG_SCHEMA);
    expect(one).toContain("  to       every user\n  columns  id, email [contact]\n");
  });

  it("names the device's table when an alias renames it, and where a derived or renamed column comes from", () => {
    const out = text(
      `config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    query: SELECT m.id, lower(m.email) AS contact, m.full_name AS who, upper(role), 'member' AS kind, data ->> 'phone' AS reach FROM members m WHERE m.org_id = auth.parameter('org_id')
`,
      ORG_SCHEMA,
    );
    expect(out.split("\n").slice(0, 4)).toEqual([
      "members",
      "  sent by  stream s, query, as m on devices  (sync-config.yaml:6)",
      "  to       members of the row's group, through claim org_id",
      // An unnamed expression is named after its text, which already shows its column; a literal reads none.
      "  columns  id, contact (from email) [contact], who (from full_name) [identifier], upper(role), kind, reach (from data) [contact]",
    ]);
    // A quoted name keeps its case and spaces, and is matched whole.
    const quoted = text(
      `config:\n  edition: 3\nstreams:\n  s:\n    auto_subscribe: true\n    query: SELECT "Home Address", lower("Home Address"), "Home Address" AS "Where" FROM "People"\n`,
      schemaOf(`create table "People" (id uuid primary key, "Home Address" text);`),
    );
    expect(quoted).toContain('  columns  Home Address [location], lower("Home Address") [location], Where (from Home Address) [location]\n');
  });

  it("says when the columns a * sends are not known, and claims no more than it read", () => {
    const yaml = `config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    query: SELECT *, lower(email) AS contact FROM members WHERE org_id = auth.parameter('org_id')
`;
    expect(text(yaml)).toBe(
      [
        "members",
        "  sent by  stream s, query  (sync-config.yaml:6)",
        "  to       members of the row's group, through claim org_id",
        "  columns  all columns (no migrations read, so not known), plus contact (from email) [contact]",
        "",
        "1 table. 1 likely personal column reaches users other than the row's owner: members.email as contact. Not every column sent from members is known.",
        MATCHED_BY,
      ].join("\n"),
    );
    // Migrations that do not define the table are not "no migrations".
    const other = formatExposure([mapped(yaml.replace("*, lower(email) AS contact", "*"), schemaOf("create table other (id uuid primary key);"))], { migrations: true });
    expect(other).toContain("  columns  all columns (the migrations do not define it, so not known)\n\n");
    expect(other).toContain("1 table. No column known here that looks personal reaches users other than the row's owner. Not every column sent from members is known.\n");
  });

  it("says when the migrations define a table only in part", () => {
    const schema = schemaOf(`create table base (id uuid primary key, email text); create table copy (like base); create table extra (like base, phone text);`);
    const out = text(
      `config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    queries:
      - SELECT * FROM copy
      - SELECT * FROM extra
`,
      schema,
    );
    expect(out).toContain("copy\n  sent by  stream s, queries[0]  (sync-config.yaml:7)\n  to       every user\n  columns  all columns (the migrations define it in part, so not known)\n");
    expect(out).toContain("  columns  phone [contact], and maybe more (the migrations define it in part)\n");
    expect(out).toContain("2 tables. 1 likely personal column reaches users other than the row's owner: extra.phone. Not every column sent from copy, extra is known.\n");
  });

  it("says when no column that looks personal reaches anyone but the row's owner", () => {
    const yaml = `config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    queries:
      - SELECT * FROM notes WHERE owner_id = auth.user_id()
      - SELECT id, role FROM members
`;
    expect(text(yaml, ORG_SCHEMA).split("\n").slice(-2)).toEqual(["2 tables. No column that looks personal reaches users other than the row's owner.", MATCHED_BY]);
    // The owner's own * is not known, but only the owner gets it: the claim still holds.
    expect(text(yaml).split("\n").slice(-2)).toEqual(["2 tables. No column that looks personal reaches users other than the row's owner.", MATCHED_BY]);
    // A not-personal marker settles a column.
    const marked = schemaOf("create table members (id uuid primary key, email text); comment on column members.email is 'A shared inbox. samesight:not-personal';");
    expect(text(yaml.replace("id, role", "id, email"), marked)).toContain("  columns  id, email\n");
  });

  it("lists the queries it could not read after the tables, and claims nothing about them", () => {
    const out = text(`config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    queries:
      - SELECT id FROM notes WHERE owner_id = auth.user_id()
      - SELECT * FROM a JOIN b ON a.id = b.a_id WHERE b.owner_id = auth.user_id()
      - |
        SELECT * FROM a WHERE owner_id = auth.user_id()
        UNION SELECT * FROM a
`);
    expect(out).toBe(
      [
        "notes",
        "  sent by  stream s, queries[0]  (sync-config.yaml:7)",
        "  to       only the row's owner (owner_id)",
        "  columns  id",
        "",
        "could not read: stream s, queries[1] (sync-config.yaml:8): selects * across a join; name the table, as in t.*",
        "could not read: stream s, queries[2] (sync-config.yaml:10): who receives its rows cannot be read",
        "",
        "1 table, and 2 queries that could not be read. No column known here that looks personal reaches users other than the row's owner.",
        MATCHED_BY,
      ].join("\n"),
    );
    // A query it cannot place in the file is named by its file alone.
    const config = mapped("config:\n  edition: 3\nstreams:\n  s:\n    auto_subscribe: true\n    query: SELECT 1\n");
    expect(formatExposure([{ ...config, lineOf: () => undefined }], { migrations: false })).toBe(
      ["could not read: stream s, query (sync-config.yaml): has no FROM", "", "0 tables, and 1 query that could not be read. No column known here that looks personal reaches users other than the row's owner.", MATCHED_BY].join(
        "\n",
      ),
    );
  });

  it("gives each of several configs a header and a summary, and ends once", () => {
    const a = mapped(ORG, ORG_SCHEMA, "a.yaml");
    const b = mapped(`bucket_definitions:\n  mine:\n    parameters: SELECT request.user_id() AS user_id\n    data:\n      - SELECT id, body FROM notes WHERE owner_id = bucket.user_id\n`, ORG_SCHEMA, "powersync/b.yaml");
    const out = formatExposure([a, b], { migrations: true });
    expect(out.split("\n").filter((l) => /^(==|\d+ tables?\.|Columns)/.test(l))).toEqual([
      "== a.yaml ==",
      "2 tables. 2 likely personal columns reach users other than the row's owner: members.email, members.full_name.",
      "== powersync/b.yaml ==",
      "1 table. No column that looks personal reaches users other than the row's owner.",
      MATCHED_BY,
    ]);
    expect(out).toContain("== a.yaml ==\n\nmembers\n  sent by  stream org_members, query  (a.yaml:8)\n");
    expect(out).toContain("\n\n== powersync/b.yaml ==\n\nnotes\n  sent by  bucket mine, data[0]  (powersync/b.yaml:5)\n  to       only the row's owner (owner_id)\n");
    // One config has no header, and none has no blocks.
    expect(formatExposure([a], { migrations: true })).not.toContain("==");
    expect(formatExposure([], { migrations: true })).toBe(MATCHED_BY);
  });
});

describe("exposureJson", () => {
  it("is the map's own objects, each query given its line, with the run's files and migrations", () => {
    const config = mapped(`config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    queries:
      - SELECT id, email FROM members WHERE user_id = auth.user_id()
      - SELECT * FROM a JOIN b ON a.id = b.a_id WHERE b.owner_id = auth.user_id()
`);
    const report = exposureJson([config], { files: ["sync-config.yaml", "gone.yaml"], migrations: null, unreadable: [{ file: "gone.yaml", error: "ENOENT" }] });
    const [query] = config.map.tables[0]?.queries ?? [];
    expect(report).toEqual({
      version: 1,
      files: ["sync-config.yaml", "gone.yaml"],
      migrations: null,
      maps: [
        {
          file: "sync-config.yaml",
          kind: "streams",
          tables: [{ table: "members", queries: [{ ...query, line: 7 }] }],
          unread: [{ stream: "s", query: "queries[1]", sql: "SELECT * FROM a JOIN b ON a.id = b.a_id WHERE b.owner_id = auth.user_id()", reason: "selects * across a join; name the table, as in t.*", line: 8 }],
        },
      ],
      unreadable: [{ file: "gone.yaml", error: "ENOENT" }],
    });
    // A query it cannot place has no line.
    const unplaced = exposureJson([{ ...config, lineOf: () => undefined }], { files: ["sync-config.yaml"], migrations: "supabase/migrations", unreadable: [] });
    expect(unplaced.maps[0]?.tables[0]?.queries[0]).not.toHaveProperty("line");
    expect(unplaced.migrations).toBe("supabase/migrations");
  });
});

describe("the summary's names", () => {
  it("names a renamed column by the table's column it sends, not its name on the device", () => {
    const schema = schemaOf("create table profiles (id uuid primary key, org_id uuid, phone text, email text);");
    const out = text(
      `config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    query: SELECT id, phone AS email FROM profiles WHERE org_id = auth.parameter('org_id')
`,
      schema,
    );
    expect(out).toContain("reaches users other than the row's owner: profiles.phone as email.");
  });

  it("counts each column sent once, by the column it matched on, else by what it reads and its name", () => {
    const schema = schemaOf("create table profiles (id uuid primary key, org_id uuid, title text, first_name text, data jsonb, email text);");
    const out = text(
      `config:
  edition: 3
streams:
  s:
    auto_subscribe: true
    query: SELECT id, concat(title, ' ', first_name) AS label, upper(title) AS email, data ->> 'phone' AS reach, email FROM profiles WHERE org_id = auth.parameter('org_id')
`,
      schema,
    );
    expect(out).toContain(
      "4 likely personal columns reach users other than the row's owner: profiles.first_name as label, profiles.title as email, profiles.data as reach, profiles.email.",
    );
  });
});
