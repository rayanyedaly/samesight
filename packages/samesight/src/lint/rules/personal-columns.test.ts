import { describe, expect, it } from "vitest";
import { corpusFiles, corpusFindings } from "../../fixtures/corpus.ts";
import { applyAllow } from "../finding.ts";
import { lintSyncConfig } from "../lint.ts";
import { applyMigrations, type Migrations } from "../migrations.ts";
import { personalColumns } from "./personal-columns.ts";

const MEMBERS = applyMigrations([
  {
    file: "m.sql",
    sql: `
      create table members (id uuid primary key, org_id uuid not null, user_id uuid not null references auth.users, email text, full_name text, role text, settings jsonb);
      create table notes (id uuid primary key, org_id uuid, owner_id uuid references auth.users, body text, title text);
      comment on column notes.body is 'What the patient said. samesight:personal=health';`,
  },
]);

/** Lint with the members migration, other migrations, or none (null). */
const findings = (yaml: string, migrations: Migrations | null = MEMBERS) => lintSyncConfig(yaml, "s.yaml", [personalColumns], migrations ?? undefined);
const lint = (yaml: string, migrations?: Migrations | null) => findings(yaml, migrations).map((f) => [f.level, f.line, f.message]);
const stream = (body: string) => `config:\n  edition: 3\nstreams:\n${body}`;
/** One auto-subscribed stream s with one query. */
const query = (sql: string) => stream(`  s:\n    auto_subscribe: true\n    query: ${sql}\n`);
/** Each finding's level and the table column it names, from its subjects. */
const columns = (yaml: string, migrations?: Migrations | null) => findings(yaml, migrations).map((f) => [f.level, f.subjects?.at(-1)]);

const MY_ORGS = "SELECT org_id FROM members WHERE user_id = auth.user_id()";

describe("personal-columns on sync streams", () => {
  it("warns about each personal column a group gets through a CTE, at the query", () => {
    const yaml = stream(`  org_members:\n    auto_subscribe: true\n    with:\n      my_orgs: ${MY_ORGS}\n    query: SELECT * FROM members WHERE org_id IN my_orgs\n`);
    expect(lint(yaml)).toEqual([
      [
        "warning",
        8,
        "stream org_members, query sends members.email (likely contact data, by its name) to members of the row's group, through with.my_orgs, not only the row's owner; fine if they need it, else drop it from the query",
      ],
      [
        "warning",
        8,
        "stream org_members, query sends members.full_name (likely identifying data, by its name) to members of the row's group, through with.my_orgs, not only the row's owner; fine if they need it, else drop it from the query",
      ],
    ]);
    expect(findings(yaml).map((f) => [f.file, f.line, f.column])).toEqual([
      ["s.yaml", 8, 12],
      ["s.yaml", 8, 12],
    ]);
  });

  it("warns the same through a membership subquery or a claim", () => {
    expect(lint(query(`SELECT id, email FROM members WHERE org_id IN (${MY_ORGS})`)).map((f) => f[2])).toEqual([
      "stream s, query sends members.email (likely contact data, by its name) to members of the row's group, through a subquery on members, not only the row's owner; fine if they need it, else drop it from the query",
    ]);
    expect(columns(query("SELECT id, email FROM members WHERE org_id = auth.parameter('org_id')"))).toEqual([["warning", "members.email"]]);
  });

  it("says nothing about columns sent only to the row's owner", () => {
    expect(lint(query("SELECT * FROM members WHERE user_id = auth.user_id()"))).toEqual([]);
    expect(lint(query("SELECT id, body FROM notes WHERE owner_id = auth.user_id()"))).toEqual([]);
  });

  it("warns when a fixed filter picks rows every user gets", () => {
    expect(lint(query("SELECT id, email FROM members WHERE role = 'public'")).map((f) => [f[0], f[2]])).toEqual([
      [
        "warning",
        "stream s, query sends members.email (likely contact data, by its name) to every user, for rows a fixed filter picks, not only the row's owner; fine if they need it, else drop it from the query",
      ],
    ]);
  });

  it("notes a role check, and says what to confirm", () => {
    expect(lint(query("SELECT id, email FROM members WHERE auth.parameter('app_metadata') ->> 'role' = 'admin'")).map((f) => [f[0], f[2]])).toEqual([
      [
        "info",
        "stream s, query sends members.email (likely contact data, by its name) to whoever passes a role or claim check, not only the row's owner; fine if only users meant to see it (such as admins) pass that check, else drop it from the query",
      ],
    ]);
  });

  it("notes columns every user or any client gets, which unscoped-query and client-scoped already fail", () => {
    expect(lint(query("SELECT id, email FROM members")).map((f) => [f[0], f[2]])).toEqual([
      ["info", "stream s, query sends members.email (likely contact data, by its name) to every user, not only the row's owner; fine if they need it, else drop it from the query"],
    ]);
    expect(lint(query("SELECT id, email FROM members WHERE org_id = subscription.parameter('org')")).map((f) => [f[0], f[2]])).toEqual([
      [
        "info",
        "stream s, query sends members.email (likely contact data, by its name) to any client, for whichever rows it asks for, not only the row's owner; fine if they need it, else drop it from the query",
      ],
    ]);
  });

  it("warns where the token is read but ties no row, which no other rule fails", () => {
    expect(lint(query("SELECT id, email FROM members WHERE user_id IN (auth.user_id(), 'system')")).map((f) => [f[0], f[2]])).toEqual([
      [
        "warning",
        "stream s, query sends members.email (likely contact data, by its name) to every user, for some rows or all (the token check does not tie rows to users), not only the row's owner; fine if they need it, else drop it from the query",
      ],
    ]);
    const rules = "bucket_definitions:\n  b:\n    parameters: SELECT token_parameters.org_id AS org_id\n    data:\n      - SELECT id, email FROM members WHERE org_id IN (bucket.org_id, 'public')\n";
    expect(columns(rules)).toEqual([["warning", "members.email"]]);
    // A plain everyone path is unscoped-query's error, so the bucket's note stays a note.
    const both = "bucket_definitions:\n  b:\n    parameters:\n      - SELECT token_parameters.org_id AS org_id\n      - SELECT org_id FROM orgs\n    data:\n      - SELECT id, email FROM members WHERE org_id IN (bucket.org_id, 'public')\n";
    expect(columns(both)).toEqual([["info", "members.email"]]);
  });

  it("reports a stream the app subscribes to on demand too", () => {
    expect(columns(stream("  s:\n    query: SELECT id, email FROM members WHERE org_id = subscription.parameter('org')\n"))).toEqual([["info", "members.email"]]);
  });
});

describe("personal-columns on sync rules", () => {
  it("gives a data query the widest audience of its parameter queries", () => {
    const rules = [
      "bucket_definitions:",
      "  by_org:",
      "    parameters:",
      "      - SELECT org_id FROM members WHERE user_id = request.user_id()",
      "      - SELECT id AS org_id FROM orgs WHERE visibility = 'public'",
      "    data:",
      "      - SELECT id, email FROM members WHERE org_id = bucket.org_id",
      "",
    ].join("\n");
    expect(lint(rules)).toEqual([
      [
        "warning",
        7,
        "bucket by_org, data[0] sends members.email (likely contact data, by its name) to every user, for rows a fixed filter picks, and to members of the row's group, through parameters[0], not only the row's owner; fine if they need it, else drop it from the query",
      ],
    ]);
  });

  it("warns about a bucket a group reaches through one parameter query and a role check through another", () => {
    const rules = [
      "bucket_definitions:",
      "  by_org:",
      "    parameters:",
      "      - SELECT org_id FROM members WHERE user_id = request.user_id()",
      "      - SELECT id AS org_id FROM orgs WHERE request.jwt() ->> 'app_role' = 'admin'",
      "    data:",
      "      - SELECT id, email FROM members WHERE org_id = bucket.org_id",
      "",
    ].join("\n");
    expect(findings(rules).map((f) => [f.level, f.message.replace(/^.*\) to /, "to ")])).toEqual([
      ["warning", "to whoever passes a role or claim check, and to members of the row's group, through parameters[0], not only the row's owner; fine if they need it, else drop it from the query"],
    ]);
  });

  it("names a bucket's group path once, not again through the owner it merges with", () => {
    const rules = [
      "bucket_definitions:",
      "  people:",
      "    parameters:",
      "      - SELECT token_parameters.user_id AS uid",
      "      - SELECT id AS uid FROM members WHERE org_id = token_parameters.org",
      "    data:",
      "      - SELECT id, email FROM members WHERE id = bucket.uid",
      "",
    ].join("\n");
    expect(findings(rules).map((f) => f.message.replace(/^.*\) to /, "to "))).toEqual([
      "to members of the row's group, through parameters[1], not only the row's owner; fine if they need it, else drop it from the query",
    ]);
  });

  it("warns about a bucket whose owner and fixed paths reach one table, and passes the owner's alone", () => {
    const rules = (...parameters: string[]) =>
      ["bucket_definitions:", "  mine:", "    parameters:", ...parameters.map((p) => `      - ${p}`), "    data:", "      - SELECT * FROM members WHERE id = bucket.member_id", ""].join("\n");
    const own = "SELECT id AS member_id FROM members WHERE user_id = request.user_id()";
    expect(lint(rules(own))).toEqual([]);
    expect(columns(rules(own, "SELECT id AS member_id FROM members WHERE role = 'public'"))).toEqual([
      ["warning", "members.email"],
      ["warning", "members.full_name"],
    ]);
  });
});

describe("what counts as personal", () => {
  it("reads a comment marker, and lets one settle a column its name would flag", () => {
    expect(lint(query("SELECT id, body, title FROM notes WHERE org_id IN (SELECT org_id FROM members WHERE user_id = auth.user_id())")).map((f) => f[2])).toEqual([
      "stream s, query sends notes.body (health data, marked in its comment) to members of the row's group, through a subquery on members, not only the row's owner; fine if they need it, else drop it from the query",
    ]);
    const shared = applyMigrations([{ file: "m.sql", sql: "create table members (id uuid primary key, org_id uuid, email text);\ncomment on column members.email is 'The team inbox. samesight:not-personal';" }]);
    expect(lint(query(`SELECT * FROM members WHERE org_id = auth.parameter('org_id')`), shared)).toEqual([]);
  });

  it("says what each category holds, and whether a name or a comment says so", () => {
    const sql = [
      "create table people (id uuid primary key, org_id uuid, dob date, password_hash text, iban text, home_zip text, lat float8, lng float8, gender text, ssn text, about text, bio text);",
      "comment on column people.about is 'samesight:personal=free-text';",
      "comment on column people.bio is 'samesight:personal';",
    ].join("\n");
    const why = findings(query("SELECT * FROM people WHERE org_id = auth.parameter('org_id')"), applyMigrations([{ file: "m.sql", sql }])).map((f) => /\((.*?)\) to /.exec(f.message)?.[1]);
    expect(why).toEqual([
      "likely a birth date or age, by its name",
      "likely a secret, by its name",
      "likely financial data, by its name",
      "likely location data, by its name",
      "likely location data, by its name",
      "likely location data, by its name",
      "likely personal data, by its name",
      "likely identifying data, by its name",
      "free text about a person, marked in its comment",
      "personal data, marked in its comment",
    ]);
  });

  it("counts a weak word only as a whole name in a table named for people", () => {
    expect(columns(query("SELECT id, name, notes FROM members WHERE org_id = auth.parameter('org_id')"), null)).toEqual([
      ["warning", "members.name"],
      ["warning", "members.notes"],
    ]);
    expect(lint(query("SELECT id, name, notes FROM projects WHERE org_id = auth.parameter('org_id')"), null)).toEqual([]);
    expect(lint(query("SELECT id, role_name FROM members WHERE org_id = auth.parameter('org_id')"), null)).toEqual([]);
  });

  it("names a renamed or derived column by the table's columns it reads and its name on the device", () => {
    const sql = "SELECT id, email AS contact, lower(email) AS email, full_name, upper(full_name), concat(email, ' ', full_name) AS card, settings ->> 'phone' AS reach, 'x' AS email2 FROM members";
    expect(findings(query(`${sql} WHERE org_id = auth.parameter('org_id')`)).map((f) => f.message.replace(/ \(likely .*$/, ""))).toEqual([
      "stream s, query sends members.email as contact",
      "stream s, query sends members.email as email",
      "stream s, query sends members.full_name",
      "stream s, query sends members.full_name as upper(full_name)",
      "stream s, query sends members.email and members.full_name as card",
      // By the JSON key it picks.
      "stream s, query sends members.settings as reach",
    ]);
    expect(findings(query(`SELECT id, settings ->> 'phone' AS reach FROM members WHERE org_id = auth.parameter('org_id')`))[0]?.message).toContain(
      "sends members.settings as reach (likely contact data, by the JSON key 'phone' it reads)",
    );
    expect(findings(query("SELECT concat(email, ' ', full_name) AS card FROM members WHERE org_id = auth.parameter('org_id')"))[0]?.subjects).toEqual([
      "s",
      "members",
      "members.email",
      "members.full_name",
    ]);
  });

  it("needs the migrations to see what a * sends, and still reads the columns a query lists", () => {
    const sql = "SELECT * FROM members WHERE org_id = auth.parameter('org_id')";
    expect(columns(query(sql))).toEqual([
      ["warning", "members.email"],
      ["warning", "members.full_name"],
    ]);
    expect(lint(query(sql), null)).toEqual([]);
    // Migrations that do not create the table know no more than none.
    expect(lint(query(sql), applyMigrations([]))).toEqual([]);
    expect(columns(query("SELECT id, email FROM members WHERE org_id = auth.parameter('org_id')"), null)).toEqual([["warning", "members.email"]]);
    expect(columns(query("SELECT members.* FROM members WHERE org_id = auth.parameter('org_id')"))).toEqual([
      ["warning", "members.email"],
      ["warning", "members.full_name"],
    ]);
  });

  it("reads quoted, mixed-case and schema-qualified names as Postgres does", () => {
    const quoted = applyMigrations([{ file: "m.sql", sql: 'create table "People" (id uuid primary key, "orgId" uuid, "Email" text, "dateOfBirth" date);' }]);
    expect(findings(query(`SELECT * FROM "People" WHERE "orgId" = auth.parameter('org_id')`), quoted).map((f) => f.subjects)).toEqual([
      ["s", "People", "People.Email"],
      ["s", "People", "People.dateOfBirth"],
    ]);
    expect(columns(query("SELECT ID, EMAIL FROM Public.Members WHERE ORG_ID = auth.parameter('org_id')"))).toEqual([["warning", "members.email"]]);
  });

  it("leaves a query it cannot read to unreadable-query", () => {
    expect(lint(query("SELECT * FROM members JOIN orgs ON orgs.id = members.org_id WHERE orgs.id = auth.parameter('org_id')"))).toEqual([]);
    expect(lint(query("SELECT email FROM members UNION SELECT email FROM members WHERE user_id = auth.user_id()"))).toEqual([]);
  });
});

describe("accepting it", () => {
  const yaml = stream(
    `  org_members:\n    auto_subscribe: true\n    with:\n      my_orgs: ${MY_ORGS}\n    queries:\n      - SELECT * FROM members WHERE org_id IN my_orgs\n      - SELECT id, body FROM notes WHERE owner_id IN (SELECT user_id FROM members WHERE org_id IN my_orgs)\n`,
  );

  it("names the stream or bucket, the table and the column, so --allow can accept any of them", () => {
    const found = findings(yaml);
    expect(found.map((f) => f.subjects)).toEqual([
      ["org_members", "members", "members.email"],
      ["org_members", "members", "members.full_name"],
      ["org_members", "notes", "notes.body"],
    ]);
    const kept = (...allow: string[]) => applyAllow(found, allow).kept.map((f) => f.subjects?.at(-1));
    expect(kept("personal-columns:members.email")).toEqual(["members.full_name", "notes.body"]);
    expect(kept("personal-columns:members")).toEqual(["notes.body"]);
    expect(kept("personal-columns:org_members")).toEqual([]);
    expect(kept("personal-columns")).toEqual([]);
    // Names match as written.
    expect(kept("personal-columns:email", "personal-columns:Members.email")).toEqual(["members.email", "members.full_name", "notes.body"]);
  });

  it("says the same for the same input, since SARIF fingerprints hash the message", () => {
    expect(findings(yaml)).toEqual(findings(yaml));
    expect(findings(yaml).map((f) => f.message)).toEqual(findings(`# moved\n\n${yaml}`).map((f) => f.message));
  });
});

describe("personal-columns on the corpus", () => {
  it("finds nothing without migrations, since every query there selects * or no personal column", () => {
    expect(corpusFindings("real", [personalColumns])).toEqual([]);
    expect(corpusFindings("planted", [personalColumns])).toEqual([]);
  });

  it("notes the Trello demo's users, which every user gets, given their table", () => {
    const trello = corpusFiles("real").find((c) => c.file === "powersync-dart-trello-legacy.yaml");
    const schema = applyMigrations([{ file: "m.sql", sql: "create table trellouser (id text primary key, name text, email text);" }]);
    expect(lint(trello?.text ?? "", schema)).toEqual([
      ["info", 5, "bucket user_info, data[0] sends trellouser.email (likely contact data, by its name) to every user, not only the row's owner; fine if they need it, else drop it from the query"],
    ]);
  });
});
