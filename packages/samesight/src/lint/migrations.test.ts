import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyMigrations, readMigrations, statements } from "./migrations.ts";

describe("statements", () => {
  it("splits on semicolons outside strings, quoted names, dollar bodies and comments, keeping each start line", () => {
    const sql = [
      "-- a comment; not a statement",
      "create table t (x text default 'a;b');",
      "",
      "create function f() returns int language sql as $$ select 1; $$;",
      '/* block; comment */ create table "we;ird" (id int);',
      "alter table t",
      "  enable row level security;",
    ].join("\n");
    expect(statements(sql)).toEqual([
      { text: "create table t (x text default 'a;b')", line: 2 },
      { text: "create function f() returns int language sql as $$ select 1; $$", line: 4 },
      { text: 'create table "we;ird" (id int)', line: 5 },
      { text: "alter table t enable row level security", line: 6 },
    ]);
  });
});

describe("applyMigrations", () => {
  const read = (...sql: string[]) => applyMigrations(sql.map((s, i) => ({ file: `m${i}.sql`, sql: s })));

  it("tracks RLS per public table, in file order, through disable and drop table", () => {
    const m = read(
      'alter table public.lists enable row level security;\nalter table "Todos" enable row level security;\nalter table other.x enable row level security;',
      "alter table lists disable row level security;\nalter table if exists only notes enable row level security;",
      'drop table if exists public."Todos";',
    );
    expect([...m.rls.entries()]).toEqual([["notes", { file: "m1.sql", line: 2 }]]);
  });

  it("reads each policy's command, roles and expressions, and follows drop and re-create", () => {
    const m = read(
      `create policy "owners read" on public.lists for select to authenticated using ((select auth.uid()) = owner_id);
create policy everyone on lists using (true);
create policy "writers" on lists as permissive for insert to authenticated, anon with check (owner_id = auth.uid());`,
      'drop policy if exists everyone on public.lists;\ncreate policy "owners read" on lists for all to "authenticated" using (true) with check (true);',
    );
    expect(m.policies.get("lists")).toEqual([
      { file: "m0.sql", line: 3, name: "writers", command: "insert", restrictive: false, roles: ["authenticated", "anon"], using: null, check: "owner_id = auth.uid()" },
      { file: "m1.sql", line: 2, name: "owners read", command: "all", restrictive: false, roles: ["authenticated"], using: "true", check: "true" },
    ]);
  });

  it("reads every action of one ALTER TABLE, and follows a table renamed", () => {
    const m = read("alter table lists enable row level security, force row level security;\nalter table notes add column x int, enable row level security;", "alter table lists rename to todo_lists;");
    expect([...m.rls.keys()]).toEqual(["notes", "todo_lists"]);
    const moved = read("alter table lists enable row level security;\ncreate policy p on lists using (true);", "alter table lists set schema private;");
    expect([[...moved.rls.keys()], moved.policies.has("lists")]).toEqual([[], false]);
    expect([...read("alter table lists enable row level security;", "alter table lists set schema public;").rls.keys()]).toEqual(["lists"]);
    const renamed = read("create policy p on lists using (true);", "alter table lists rename to todo_lists;");
    expect([renamed.policies.has("lists"), renamed.policies.get("todo_lists")?.map((p) => p.name)]).toEqual([false, ["p"]]);
  });

  it("reads AS RESTRICTIVE, and a TO that only USING mentions is no TO", () => {
    const m = read("create policy r on lists as restrictive for select to authenticated using (true);\ncreate policy s on lists using (note = 'sent to anon');");
    expect(m.policies.get("lists")?.map((p) => [p.name, p.restrictive, p.roles])).toEqual([
      ["r", true, ["authenticated"]],
      ["s", false, ["public"]],
    ]);
  });

  it("follows ALTER POLICY: new roles, expressions or name, placed where it changed", () => {
    const m = read(
      "create policy own on lists for select to authenticated using (owner_id = auth.uid());\ncreate policy w on lists for insert with check (owner_id = auth.uid());",
      "alter policy own on lists using (true);\nalter policy w on lists rename to writes;\nalter policy missing on lists using (true);",
    );
    expect(m.policies.get("lists")?.map((p) => [p.name, p.roles, p.using, p.check, `${p.file}:${p.line}`])).toEqual([
      ["own", ["authenticated"], "true", null, "m1.sql:1"],
      ["writes", ["public"], null, "owner_id = auth.uid()", "m0.sql:2"],
    ]);
    expect(read("create policy p on lists using (x);", "alter policy p on lists to anon;").policies.get("lists")?.[0]?.roles).toEqual(["anon"]);
    expect(read("create policy w on lists for insert with check (owner_id = auth.uid());", "alter policy w on lists with check (true);").policies.get("lists")?.[0]?.check).toBe("true");
  });

  it("reads only .sql files from a directory, in name order", () => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-migrations-"));
    try {
      writeFileSync(join(dir, "2_off.sql"), "alter table lists disable row level security;");
      writeFileSync(join(dir, "1_on.sql"), "alter table lists enable row level security;\nalter table notes enable row level security;");
      writeFileSync(join(dir, "0_notes.md"), "alter table todos enable row level security;");
      expect([...readMigrations(dir).rls.keys()]).toEqual(["notes"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores tables outside public", () => {
    expect(read("create policy p on storage.objects using (true);").policies.size).toBe(0);
  });

  it("reads a table's columns and types, its primary key and the columns that reference auth.users", () => {
    const m = read(`-- People.
CREATE TABLE IF NOT EXISTS public."Users" (
  id uuid primary key default gen_random_uuid(), -- a comment, with a comma (and a parenthesis
  "createdAt" TIMESTAMP WITH TIME ZONE not null default now(),
  /* in cents, (two places) */ price numeric(10,2) check (price > 0 and price < 1000000),
  tags text[] not null default '{a,b}',
  "Email" varchar(255) unique collate "C",
  owner_id uuid not null references auth.users (id) on delete cascade,
  editor uuid constraint editor_fk references "auth"."users",
  org_id uuid references public.orgs (id),
  friend uuid references users (id),
  status text check (status <> 'primary key, references auth.users'),
  mood public."Mood" default 'happy, (mostly)',
  seq bigint generated always as identity
);`);
    expect(m.tables.get("Users")).toEqual({
      file: "m0.sql",
      line: 2,
      columns: [
        { name: "id", type: "uuid" },
        { name: "createdAt", type: "timestamp with time zone" },
        { name: "price", type: "numeric(10,2)" },
        { name: "tags", type: "text[]" },
        { name: "Email", type: "varchar(255)" },
        { name: "owner_id", type: "uuid" },
        { name: "editor", type: "uuid" },
        { name: "org_id", type: "uuid" },
        { name: "friend", type: "uuid" },
        { name: "status", type: "text" },
        { name: "mood", type: 'public."Mood"' },
        { name: "seq", type: "bigint" },
      ],
      primaryKey: ["id"],
      userColumns: ["owner_id", "editor"],
      complete: true,
    });
  });

  it("reads table constraints: a primary key and foreign keys to auth.users, the rest ignored", () => {
    const m = read(`create table memberships(
  "userId" uuid not null,
  org uuid,
  approver uuid,
  exclude boolean,
  constraint memberships_pkey primary key ("userId", org),
  foreign key ("userId") references "auth"."users"("id") on delete cascade,
  constraint approver_fk foreign key (approver) references AUTH.USERS,
  foreign key (org) references public.orgs (id),
  unique (org, approver),
  check (approver <> "userId"),
  exclude using gist (org with =)
);`);
    expect(m.tables.get("memberships")).toMatchObject({
      columns: [
        { name: "userId", type: "uuid" },
        { name: "org", type: "uuid" },
        { name: "approver", type: "uuid" },
        { name: "exclude", type: "boolean" },
      ],
      primaryKey: ["userId", "org"],
      userColumns: ["userId", "approver"],
      complete: true,
    });
  });

  it("marks a table whose columns come from elsewhere incomplete, keeps the columns it names, and skips temporary tables", () => {
    const m = read(`create table copy (like lists including all, extra text);
create table child (extra text) inherits (lists);
create table part partition of lists for values in ('a');
create table typed of list_type;
create table snapshot as select * from lists;
create table named (a, b) as select 1, 2;
create table ranged (at date) partition by range (at);
create unlogged table cache (k text primary key);
create temp table scratch (x int);
create global temporary table scratch_too (x int);
create table private.secrets (x int);
create table "public"."Empty" ();`);
    expect([...m.tables].map(([t, d]) => [t, d.complete, d.columns.map((c) => c.name)])).toEqual([
      ["copy", false, ["extra"]],
      ["child", false, ["extra"]],
      ["part", false, []],
      ["typed", false, []],
      ["snapshot", false, []],
      ["named", false, []],
      ["ranged", true, ["at"]],
      ["cache", true, ["k"]],
      ["Empty", true, []],
    ]);
  });

  it("leaves a known table to CREATE TABLE IF NOT EXISTS, and forgets tables dropped or moved out of public", () => {
    const m = read(
      "create table lists (id int);\ncreate table notes (id int);\ncreate table if not exists lists (id int, name text);\nalter table notes enable row level security;",
      'drop table if exists lists, public."Other", notes cascade;\ncreate table if not exists lists (name text);\ncreate table moved (id int);\nalter table moved set schema private;',
    );
    expect([...m.tables].map(([t, d]) => [t, d.columns.map((c) => c.name), `${d.file}:${d.line}`])).toEqual([["lists", ["name"], "m1.sql:2"]]);
    expect(m.rls.size).toBe(0);
  });

  it("follows ALTER TABLE on columns in a later file: add, drop, rename and retype, keys and user columns in step", () => {
    const m = read(
      "create table public.todos (id uuid, owner uuid, title text, done boolean);",
      `alter table if exists only todos
  add column if not exists "dueAt" timestamptz default now(),
  add assignee uuid references auth.users (id) on delete set null,
  add column title varchar(10),
  add constraint todos_pkey primary key (id),
  add constraint owner_fk foreign key (owner) references auth.users (id) not valid,
  add constraint title_set check (title <> ''),
  enable row level security;
ALTER TABLE todos DROP COLUMN IF EXISTS done CASCADE, drop column if exists missing;
alter table todos rename column owner to "ownerId";
alter table todos rename assignee to helper;
alter table todos rename constraint owner_fk to owner_fkey;
alter table todos alter column title set data type varchar(255) using title::varchar(255), alter "dueAt" type date;`,
    );
    expect(m.tables.get("todos")).toEqual({
      file: "m0.sql",
      line: 1,
      columns: [
        { name: "id", type: "uuid" },
        { name: "ownerId", type: "uuid" },
        { name: "title", type: "varchar(255)" },
        { name: "dueAt", type: "date" },
        { name: "helper", type: "uuid" },
      ],
      primaryKey: ["id"],
      userColumns: ["helper", "ownerId"],
      complete: true,
    });
    expect([...m.rls.keys()]).toEqual(["todos"]);
  });

  it("drops a column from the user columns, and the primary key it was part of", () => {
    const m = read("create table t (a int, b int, owner uuid references auth.users, primary key (a, b));\nalter table t drop column b, drop owner restrict;");
    expect(m.tables.get("t")).toMatchObject({ columns: [{ name: "a", type: "int" }], primaryKey: [], userColumns: [] });
  });

  it("carries a table's definition through a rename, and leaves tables alone on an ALTER of an unknown one", () => {
    const m = read("create table lists (id int primary key);", "alter table lists rename to todo_lists;\nalter table todo_lists add column name text;\nalter table ghosts add column x int, enable row level security;");
    expect([...m.tables].map(([t, d]) => [t, d.columns.map((c) => c.name)])).toEqual([["todo_lists", ["id", "name"]]]);
    expect([...m.rls.keys()]).toEqual(["ghosts"]);
  });

  it("reads COMMENT ON COLUMN, through a rename, and clears it with NULL or an empty string", () => {
    const m = read(
      `create table "Users" (id uuid, email text, phone text, bio text);
comment on column "Users".email is 'The user''s email';
comment on column public."Users".phone is $$Phone, as given$$;
comment on column "Users".bio is 'About them';`,
      `alter table "Users" rename column email to "contactEmail", rename column phone to mobile;
comment on column "Users"."contactEmail" is 'Where we write; it''s personal';
comment on column "Users".bio is null;
comment on column "Users".id is 'Its key';
comment on column "Users".id is '';
comment on column "Users".missing is 'x';
comment on column users.email is 'not this table';
comment on column private."Users".mobile is 'nor this one';`,
    );
    expect(m.tables.get("Users")?.columns).toStrictEqual([
      { name: "id", type: "uuid" },
      { name: "contactEmail", type: "text", comment: "Where we write; it's personal" },
      { name: "mobile", type: "text", comment: "Phone, as given" },
      { name: "bio", type: "text" },
    ]);
  });

  it("reads the example apps' tables", () => {
    const example = (app: string) => readMigrations(fileURLToPath(new URL(`../../../../examples/${app}/supabase/migrations`, import.meta.url))).tables;
    const roles = example("audit-roles");
    expect(roles.get("documents")?.columns.map((c) => c.name)).toEqual(["id", "org_id", "owner_id", "title", "status", "created_at", "team_id"]);
    expect([roles.get("documents")?.userColumns, roles.get("memberships")?.userColumns]).toEqual([["owner_id"], ["user_id"]]);
    const quickstart = example("quickstart");
    expect([...quickstart.keys()]).toEqual(["organizations", "members", "projects", "tasks", "project_members", "labels"]);
    expect(quickstart.get("tasks")).toMatchObject({ primaryKey: ["id"], userColumns: ["assignee_id"], complete: true });
    expect(quickstart.get("tasks")?.columns.find((c) => c.name === "created_at")?.type).toBe("timestamptz");
  });
});
