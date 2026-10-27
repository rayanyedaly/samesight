import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { lintSyncConfig } from "../lint.ts";
import { applyMigrations } from "../migrations.ts";
import { rlsOff } from "./rls-off.ts";

const temps: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "samesight-lint-"));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const config = 'config:\n  edition: 3\nstreams:\n  s:\n    auto_subscribe: true\n    queries:\n      - SELECT * FROM lists WHERE owner_id = auth.user_id()\n      - SELECT * FROM "Notes" WHERE owner_id = auth.user_id()\n';
const lint = (...sql: string[]) =>
  lintSyncConfig(config, "s.yaml", [rlsOff], applyMigrations(sql.map((s, i) => ({ file: `m${i}.sql`, sql: s })))).map((f) => [f.level, f.line, f.message]);

describe("rls-off", () => {
  it("warns about each synced table whose migrations never enable RLS", () => {
    expect(lint("alter table lists enable row level security;")).toEqual([
      ["warning", 8, "Notes is synced, but the migrations never enable row level security on it, so unless its grants to anon and authenticated were revoked, any client can read and change every row through the Supabase API"],
    ]);
    expect(lint('alter table lists enable row level security;\nalter table "Notes" enable row level security;')).toEqual([]);
  });

  it("follows a later migration that turns RLS off again", () => {
    expect(lint('alter table lists enable row level security;\nalter table "Notes" enable row level security;', "alter table lists disable row level security;").map((f) => f[2])).toEqual([
      expect.stringMatching(/^lists is synced/),
    ]);
  });

  it("does not run without migrations", () => {
    expect(lintSyncConfig(config, "s.yaml", [rlsOff])).toEqual([]);
  });
});

describe("samesight lint with migrations", () => {
  const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));
  const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, "lint", ...args], { cwd, encoding: "utf8" });

  it("reads supabase/migrations by default, takes --migrations, and says when it has none", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "sync-config.yaml"), config);
    const none = run(dir);
    expect([none.status, none.stderr]).toEqual([0, expect.stringMatching(/no supabase\/migrations here, so the RLS rules .* did not run/)]);
    mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(dir, "supabase", "migrations", "1_init.sql"), "alter table lists enable row level security;\n");
    const found = run(dir);
    expect([found.status, found.stdout]).toEqual([0, expect.stringMatching(/sync-config.yaml:8 {2}warning {2}Notes is synced/)]);
    const missing = run(dir, "--migrations", "elsewhere");
    expect([missing.status, missing.stderr]).toEqual([2, expect.stringMatching(/No migrations directory at elsewhere/)]);
    mkdirSync(join(dir, "supabase", "migrations", "broken.sql"));
    const broken = run(dir);
    expect([broken.status, broken.stderr]).toEqual([2, expect.stringMatching(/Cannot read the migrations in supabase\/migrations: EISDIR/)]);
    // The default path, not a flag: no word about --migrations.
    const plain = tempDir();
    writeFileSync(join(plain, "sync-config.yaml"), config);
    mkdirSync(join(plain, "supabase"));
    writeFileSync(join(plain, "supabase", "migrations"), "");
    const notDir = run(plain);
    expect([notDir.status, notDir.stderr]).toEqual([2, expect.stringMatching(/supabase\/migrations is not a directory\.$/m)]);
    const file = run(dir, "--migrations", "supabase/migrations/1_init.sql");
    expect([file.status, file.stderr]).toEqual([2, expect.stringMatching(/1_init.sql is not a directory; --migrations takes the directory/)]);
  });
});
