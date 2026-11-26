import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lineFinder } from "../lint/lint.ts";
import { applyMigrations } from "../lint/migrations.ts";
import { parseSyncConfig } from "../sync/config.ts";
import { diffExposure } from "./diff.ts";
import { type DiffedConfig, exposureDiffJson, formatExposureDiff } from "./diff-format.ts";
import { MATCHED_BY } from "./format.ts";
import { exposureMap, type Schema } from "./map.ts";

const corpus = (name: string) => readFileSync(new URL(`../../../../corpus/${name}`, import.meta.url), "utf8");

function schemaOf(...sql: string[]): Schema {
  const m = applyMigrations(sql.map((s, n) => ({ file: `${n}.sql`, sql: s })));
  return (table) => m.tables.get(table);
}

const APP = `
  create table lists (id uuid primary key, name text, owner_id uuid references auth.users, is_public boolean);
  create table members (id uuid primary key, org_id uuid not null, user_id uuid not null references auth.users, email text, role text);
  create table notes (id uuid primary key, owner_id uuid references auth.users, body text);`;
const SCHEMA = schemaOf(APP);

const TODO_SCHEMA = schemaOf(`
  create table lists (id uuid primary key, created_at timestamptz, name text not null, owner_id uuid not null references auth.users (id));
  create table todos (id uuid primary key, description text not null, created_by uuid references auth.users (id), list_id uuid not null references lists (id));`);

/** Sync streams, each with its queries, every one auto-subscribed unless named in `onDemand`. */
function streams(body: Record<string, string[]>, onDemand: string[] = [], extra = ""): string {
  const each = Object.entries(body).map(
    ([name, queries]) => `  ${name}:\n    auto_subscribe: ${!onDemand.includes(name)}\n${extra}    queries:\n${queries.map((q) => `      - ${q}`).join("\n")}`,
  );
  return `config:\n  edition: 3\nstreams:\n${each.join("\n")}\n`;
}

/** One config compared: the text before and after, as the CLI would map them. */
function diffed(before: string, after: string, schema: Schema = SCHEMA, file = "sync-config.yaml", schemaAfter = schema): DiffedConfig {
  const was = exposureMap(parseSyncConfig(before), schema);
  const now = exposureMap(parseSyncConfig(after), schemaAfter);
  return { file, diff: diffExposure(was, now), after: now, lineOf: lineFinder(after), inCommit: true };
}

const text = (configs: DiffedConfig[], ref = "main") => formatExposureDiff(configs, ref);
const OWN_LISTS = "SELECT id, name FROM lists WHERE owner_id = auth.user_id()";
const OWN_NOTES = "SELECT id, body FROM notes WHERE owner_id = auth.user_id()";

describe("formatExposureDiff", () => {
  it("names the file and the ref as given, and says when nothing changed", () => {
    const yaml = streams({ s: [OWN_LISTS] });
    expect(text([diffed(yaml, yaml)])).toBe(["== sync-config.yaml, against main ==", "No change.", "No change in who receives which tables and columns since main.", MATCHED_BY].join("\n\n"));
  });

  it("the planted to-do leak: todos reach every user, through the query that lost its owner filter", () => {
    const out = text([diffed(corpus("real/powersync-js-todolist.yaml"), corpus("planted/missing-owner-filter.yaml"), TODO_SCHEMA)], "origin/main");
    expect(out).toBe(
      [
        "== sync-config.yaml, against origin/main ==",
        [
          "todos: reaches more users",
          "  was to            only the owner of its lists row (lists.owner_id)",
          "  now to            every user",
          "  columns wider     id, description, created_by, list_id",
          "  query edited      user_data, queries[1]  (sync-config.yaml:14)",
          "                    was  SELECT todos.* FROM todos INNER JOIN lists ON todos.list_id = lists.id WHERE lists.owner_id = auth.user_id()",
          "                    now  SELECT todos.* FROM todos INNER JOIN lists ON todos.list_id = lists.id",
          "                    was to only the owner of its lists row (lists.owner_id); now to every user",
        ].join("\n"),
        "1 table reaches more users, or more columns, than in origin/main: todos.",
        MATCHED_BY,
      ].join("\n\n"),
    );
  });

  it("a table newly sent, and one no longer sent", () => {
    const out = text([diffed(streams({ n: [OWN_NOTES] }), streams({ l: [OWN_LISTS] }))]);
    expect(out).toContain(["lists: newly sent", "  to                only the row's owner (owner_id)", "  columns added     id, name: to only the row's owner (owner_id)"].join("\n"));
    expect(out).toContain(["notes: no longer sent", "  was to            only the row's owner (owner_id)"].join("\n"));
    expect(out).not.toContain("columns dropped");
    expect(out).toContain("1 table reaches more users, or more columns, than in main: lists.");
  });

  it("tags a likely personal column added, and says what it reaches", () => {
    const out = text([diffed(streams({ s: ["SELECT id FROM members WHERE user_id = auth.user_id()"] }), streams({ s: ["SELECT id, email FROM members WHERE user_id = auth.user_id()"] }))]);
    expect(out).toContain("  columns added     email [contact]: to only the row's owner (user_id)");
    expect(out).toContain("                    sends now: email");
    expect(out).toContain("members: sends more");
  });

  it("a column dropped, and a column whose audience moved other than the table's", () => {
    const out = text([
      diffed(
        streams({ own: ["SELECT id, email FROM members WHERE user_id = auth.user_id()"], all: ["SELECT id, role FROM members"] }),
        streams({ own: ["SELECT id FROM members WHERE user_id = auth.user_id()"], all: ["SELECT id, email FROM members"] }),
      ),
    ]);
    expect(out).toContain("  columns dropped   role");
    expect(out).toContain("  columns wider     email [contact]: was to only the row's owner (user_id), now to every user");
  });

  it("an audience it cannot rank is 'reaches other users', never wider or narrower", () => {
    const out = text([diffed(streams({ s: [OWN_LISTS] }), streams({ s: ["SELECT id, name FROM lists WHERE is_public"] }))]);
    expect(out).toContain("lists: reaches other users");
    expect(out).toContain("Nothing reaches more users than in main, as far as the files show; 1 table changed otherwise.");
  });

  it("a narrower table says fewer, and never that the change is safe", () => {
    const out = text([diffed(streams({ s: ["SELECT id, name FROM lists"] }), streams({ s: [OWN_LISTS] }))]);
    expect(out).toContain("lists: reaches fewer users");
    expect(out).toContain("  columns narrower  id, name");
    expect(out.toLowerCase()).not.toMatch(/\bsafe\b/);
  });

  it("queries added and dropped, an on-demand stream turned automatic, and a personal marker", () => {
    const out = text([
      diffed(
        streams({ s: [OWN_NOTES], gone: ["SELECT id FROM notes WHERE owner_id = auth.user_id()"] }, ["s"]),
        streams({ s: [OWN_NOTES], more: ["SELECT id FROM notes WHERE owner_id = auth.user_id() AND body IS NOT NULL"] }),
        SCHEMA,
        "sync-config.yaml",
        schemaOf(APP, "comment on column notes.body is 'samesight:personal=health';"),
      ),
    ]);
    expect(out).toContain("  query added       more, queries[0]  (sync-config.yaml:");
    expect(out).toContain("  query dropped     gone, queries[0]: was to only the row's owner (owner_id)");
    expect(out).toContain("now sent to every device without the app asking");
    expect(out).toContain("  personal          body: was not personal, now health, marked in its comment");
  });

  it("an edited CTE shows its SQL before and after", () => {
    const at = (who: string) => streams({ s: ["SELECT id, name FROM lists WHERE org_id IN mine"] }, [], `    with:\n      mine: SELECT org_id FROM ${who} WHERE user_id = auth.user_id()\n`);
    const out = text([diffed(at("admins"), at("members"))]);
    expect(out).toContain("with.mine was  SELECT org_id FROM admins WHERE user_id = auth.user_id()");
    expect(out).toContain("with.mine now  SELECT org_id FROM members WHERE user_id = auth.user_id()");
    expect(out).toContain("Nothing reaches more users than in main");
  });

  it("queries that cannot be read: new ones may send anything, and ones read again are said", () => {
    const unreadable = "SELECT * FROM lists UNION SELECT * FROM lists";
    const added = text([diffed(streams({ s: [OWN_LISTS] }), streams({ s: [OWN_LISTS], t: [unreadable] }))]);
    expect(added).toContain("could not read: t, queries[0]  (sync-config.yaml:");
    expect(added).toMatch(/1 query that cannot be read is new since main, and may send anything\.$/m);
    const removed = text([diffed(streams({ s: [OWN_LISTS], t: [unreadable] }), streams({ s: [OWN_LISTS] }))]);
    expect(removed).toContain("read now, could not before: t, queries[0]");
  });

  it("says when sync rules became streams", () => {
    const rules = "bucket_definitions:\n  b:\n    parameters: SELECT request.user_id() AS user_id\n    data:\n      - SELECT id, name FROM lists WHERE owner_id = bucket.user_id\n";
    expect(text([diffed(rules, streams({ s: [OWN_LISTS] }))])).toContain("Was sync rules, now sync streams.");
  });

  it("names the file of each table that widened when there are several", () => {
    const one = diffed(streams({ s: [OWN_LISTS] }), streams({ s: ["SELECT id, name FROM lists"] }), SCHEMA, "a.yaml");
    const two = diffed(streams({ s: [OWN_NOTES] }), streams({ s: [OWN_NOTES] }), SCHEMA, "b.yaml");
    const out = text([one, two]);
    expect(out).toContain("== a.yaml, against main ==");
    expect(out).toContain("== b.yaml, against main ==\n\nNo change.");
    expect(out).toContain("1 table reaches more users, or more columns, than in main: lists (a.yaml).");
  });

  it("puts every SQL text on one line", () => {
    const out = text([diffed(streams({ s: [OWN_LISTS] }), streams({ s: ['"SELECT id, name\\n  FROM lists"'] }))]);
    expect(out).toContain("now  SELECT id, name FROM lists");
  });
});

describe("formatExposureDiff, each kind of entry", () => {
  const NO_NOTES = schemaOf("create table lists (id uuid primary key, name text, owner_id uuid references auth.users);");

  it("a table changed in no way that reaches more users is 'changed', with the query's own line", () => {
    const out = text([diffed(streams({ s: [OWN_LISTS] }), streams({ s: [`${OWN_LISTS} AND name IS NOT NULL`] }))]);
    expect(out).toContain("lists: changed\n");
    expect(out).not.toContain("sends more");
  });

  it("a column moved between audiences it cannot rank says so", () => {
    const out = text([
      diffed(
        streams({ own: ["SELECT id, email FROM members WHERE user_id = auth.user_id()"], all: ["SELECT id FROM members"] }),
        streams({ own: ["SELECT id FROM members WHERE user_id = auth.user_id()"], org: ["SELECT id, email FROM members WHERE org_id = auth.parameter('org_id')"], all: ["SELECT id FROM members"] }),
      ),
    ]);
    expect(out).toContain("  columns moved     email [contact]: was to only the row's owner (user_id), now to members of the row's group, through claim org_id");
  });

  it("a query found again under another label says what it was, and what it no longer sends", () => {
    const out = text([diffed(streams({ s: [OWN_NOTES, "SELECT id, name FROM lists"] }), streams({ s: ["SELECT id FROM lists"] }))]);
    expect(out).toContain("  query edited      s, queries[0] (was queries[1])  (sync-config.yaml:7)");
    expect(out).toContain("                    no longer sends: name");
  });

  it("a CTE added and one dropped", () => {
    const yaml = (where: string, ctes: string) => streams({ s: [`SELECT id, name FROM lists WHERE ${where}`] }, [], ctes);
    const with1 = "    with:\n      mine: SELECT org_id FROM members WHERE user_id = auth.user_id()\n";
    const added = text([diffed(yaml("owner_id = auth.user_id()", ""), yaml("org_id IN mine", with1))]);
    expect(added).toContain("with.mine added  SELECT org_id FROM members WHERE user_id = auth.user_id()");
    const dropped = text([diffed(yaml("org_id IN mine", with1), yaml("owner_id = auth.user_id()", ""))]);
    expect(dropped).toContain("with.mine dropped  SELECT org_id FROM members WHERE user_id = auth.user_id()");
  });

  it("a column a * the schema did not know may have sent, now surely sent to more users, says so", () => {
    const star = "SELECT * FROM notes WHERE owner_id = auth.user_id()";
    const out = text([diffed(streams({ s: [star, "SELECT id FROM notes"] }), streams({ s: [star, "SELECT id, memo FROM notes"] }), NO_NOTES)]);
    expect(out).toContain("  columns added     memo: to every user");
    expect(out).toContain("(memo may have been sent before by a * whose columns were not known)");
  });

  it("columns no longer all known: 'may send more', and the summary says may", () => {
    const yaml = streams({ s: ["SELECT * FROM notes WHERE owner_id = auth.user_id()"] });
    const out = text([diffed(yaml, yaml, SCHEMA, "sync-config.yaml", NO_NOTES)]);
    expect(out).toContain("notes: may send more");
    expect(out).toContain("  columns           not all known now (a * the schema does not define, or a query that cannot be read)");
    expect(out).toContain("No table is known to reach more users than in main, but: 1 table may send more, since not all its columns are known now: notes.");
    const back = text([diffed(yaml, yaml, NO_NOTES, "sync-config.yaml", SCHEMA)]);
    expect(back).toContain("  columns           all known now; some were not before");
    expect(back).toContain("notes: changed");
  });

  it("a table an unreadable query may have sent before is not called newly sent", () => {
    const out = text([diffed(streams({ s: ["SELECT * FROM lists JOIN notes ON notes.id = lists.id WHERE lists.owner_id = auth.user_id()"] }), streams({ s: ["SELECT * FROM lists JOIN notes ON notes.id = lists.id WHERE lists.owner_id = auth.user_id()"], t: [OWN_NOTES] }))]);
    expect(out).toContain("notes: sent now (a query that could not be read may have sent it before)");
  });

  it("counts tables in the plural", () => {
    const out = text([diffed(streams({ a: [OWN_LISTS], b: [OWN_NOTES] }), streams({ a: ["SELECT id, name FROM lists"], b: ["SELECT id, body FROM notes"] }))]);
    expect(out).toContain("2 tables reach more users, or more columns, than in main: lists, notes.");
  });
});

describe("exposureDiffJson", () => {
  it("carries the ref, the commit, the diff of each file with lines, and widened", () => {
    const c = diffed(streams({ s: [OWN_LISTS] }), streams({ s: [OWN_LISTS], all: ["SELECT id FROM notes"], t: ["SELECT * FROM lists UNION SELECT * FROM lists"] }));
    const doc = JSON.parse(JSON.stringify(exposureDiffJson([c], { ref: "main", commit: "a".repeat(40), files: ["sync-config.yaml"], migrations: "supabase/migrations", commitMigrations: "supabase/migrations", unreadable: [] })));
    expect(doc).toMatchObject({ version: 1, against: { ref: "main", commit: "a".repeat(40) }, files: ["sync-config.yaml"], migrations: "supabase/migrations", widened: true, changed: true, unreadable: [] });
    expect(doc.diffs[0].file).toBe("sync-config.yaml");
    const notes = doc.diffs[0].tables.find((t: { table: string }) => t.table === "notes");
    expect(notes.queries.added[0]).toMatchObject({ stream: "all", line: c.lineOf("SELECT id FROM notes")?.line });
    expect(doc.diffs[0].unread.added[0]).toMatchObject({ stream: "t", line: c.lineOf("SELECT * FROM lists UNION SELECT * FROM lists")?.line });
    expect(notes.queries.added[0].line).toBeGreaterThan(0);
  });

  it("is not widened when nothing is", () => {
    const yaml = streams({ s: [OWN_LISTS] });
    const doc = exposureDiffJson([diffed(yaml, yaml)], { ref: "main", commit: "b".repeat(40), files: ["x"], migrations: null, commitMigrations: null, unreadable: [] });
    expect(doc.widened).toBe(false);
    expect(doc.changed).toBe(false);
  });
});
