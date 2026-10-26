import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
