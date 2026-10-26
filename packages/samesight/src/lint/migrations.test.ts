import { describe, expect, it } from "vitest";
import { applyMigrations, statements } from "./migrations.ts";

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
      { file: "m0.sql", line: 3, name: "writers", command: "insert", roles: ["authenticated", "anon"], using: null, check: "owner_id = auth.uid()" },
      { file: "m1.sql", line: 2, name: "owners read", command: "all", roles: ["authenticated"], using: "true", check: "true" },
    ]);
  });

  it("ignores tables outside public", () => {
    expect(read("create policy p on storage.objects using (true);").policies.size).toBe(0);
  });
});
