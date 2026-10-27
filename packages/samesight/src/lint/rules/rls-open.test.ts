import { describe, expect, it } from "vitest";
import { lintSyncConfig } from "../lint.ts";
import { applyMigrations } from "../migrations.ts";
import { rlsOpen } from "./rls-open.ts";

const config = "config:\n  edition: 3\nstreams:\n  s:\n    auto_subscribe: true\n    query: SELECT * FROM lists WHERE owner_id = auth.user_id()\n";
const lint = (sql: string) => lintSyncConfig(config, "s.yaml", [rlsOpen], applyMigrations([{ file: "m.sql", sql }])).map((f) => [f.level, f.line, f.message]);

describe("rls-open", () => {
  it("warns about a policy that lets a client role read or change every row", () => {
    expect(lint("create policy \"anyone reads\" on lists for select to authenticated using (true);")).toEqual([
      ["warning", 6, 'policy "anyone reads" on lists (m.sql:1) lets every signed-in user read every row through the Supabase API, whatever the sync config sends'],
    ]);
    expect(lint("create policy open on lists using ((true));").map((f) => f[2])).toEqual([
      'policy "open" on lists (m.sql:1) lets every client, signed in or not, read every row, update every row and delete every row through the Supabase API, whatever the sync config sends',
    ]);
    expect(lint("create policy w on lists for insert to anon, authenticated with check (true);").map((f) => f[2])).toEqual([
      'policy "w" on lists (m.sql:1) lets anyone with the anon key and every signed-in user write rows with any values through the Supabase API, whatever the sync config sends',
    ]);
  });

  it("names only what the policy's command lets through", () => {
    expect(lint("create policy u on lists for update to authenticated using (true) with check (true);").map((f) => f[2])).toEqual([
      'policy "u" on lists (m.sql:1) lets every signed-in user update every row and write rows with any values through the Supabase API, whatever the sync config sends',
    ]);
    expect(lint("create policy d on lists for delete to anon using (true);").map((f) => f[2])).toEqual([
      'policy "d" on lists (m.sql:1) lets anyone with the anon key delete every row through the Supabase API, whatever the sync config sends',
    ]);
  });

  it("follows ALTER POLICY, and leaves restrictive policies alone", () => {
    expect(lint("create policy own on lists to authenticated using (auth.uid() = owner_id);\nalter policy own on lists using (true);").map((f) => f[2])).toEqual([
      expect.stringMatching(/^policy "own" on lists \(m.sql:2\) lets every signed-in user read every row/),
    ]);
    expect(lint("create policy r on lists as restrictive to authenticated using (true);")).toEqual([]);
  });

  it("accepts real conditions, other roles, and unsynced tables", () => {
    expect(lint("create policy own on lists for select to authenticated using (auth.uid() = owner_id);")).toEqual([]);
    expect(lint("create policy hook on lists for select to supabase_auth_admin using (true);")).toEqual([]);
    expect(lint("create policy open on notes for select to authenticated using (true);")).toEqual([]);
  });

  it("does not run without migrations", () => {
    expect(lintSyncConfig(config, "s.yaml", [rlsOpen])).toEqual([]);
  });
});
