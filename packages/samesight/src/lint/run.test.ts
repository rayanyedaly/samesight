import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { runLint, unknownRules } from "./run.ts";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "samesight-run-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const leaky = "config:\n  edition: 3\n\nstreams:\n  user_data:\n    auto_subscribe: true\n    queries:\n      - SELECT * FROM lists\n";
const owned = "config:\n  edition: 3\n\nstreams:\n  user_data:\n    auto_subscribe: true\n    queries:\n      - SELECT * FROM lists WHERE owner_id = auth.user_id()\n";
const migration = "create table public.lists (id uuid primary key, owner_id uuid references auth.users);\nalter table public.lists enable row level security;\n";

describe("runLint", () => {
  it("finds the sync config and the migrations in the directory it is given, not the process's", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "powersync"));
    writeFileSync(join(dir, "powersync", "sync-config.yaml"), leaky);
    mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(dir, "supabase", "migrations", "0001_lists.sql"), migration);
    const run = runLint({ given: [], allow: [], cwd: dir });
    expect(run.files).toEqual(["powersync/sync-config.yaml"]);
    expect(run.rlsChecked).toBe(true);
    expect(run.kept.map((f) => [f.rule, f.level, f.file])).toEqual([["unscoped-query", "error", "powersync/sync-config.yaml"]]);
    expect(run.code).toBe(1);
  });

  it("applies --allow and reads named files relative to the directory", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.yaml"), leaky);
    writeFileSync(join(dir, "b.yaml"), owned);
    const run = runLint({ given: ["a.yaml", "b.yaml"], allow: ["unscoped-query"], cwd: dir });
    expect([run.kept.length, run.allowed.map((f) => f.rule), run.rlsChecked, run.code]).toEqual([0, ["unscoped-query"], false, 0]);
  });

  it("returns what it would say about a file it cannot read, and prints nothing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bad.yaml"), "streams: [\n");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    onTestFinished(() => {
      err.mockRestore();
      log.mockRestore();
    });
    const run = runLint({ given: ["bad.yaml", "gone.yaml"], allow: [], cwd: dir });
    expect(run.unreadable.map((u) => u.file)).toEqual(["bad.yaml", "gone.yaml"]);
    expect(run.messages).toEqual([expect.stringMatching(/^samesight: bad\.yaml: cannot be read as a sync config: [\s\S]*fix the YAML, or name another file$/), expect.stringMatching(/^samesight: gone\.yaml: cannot be read as a sync config: .*; check the path, or name another file$/)]);
    expect(run.code).toBe(2);
    expect([err.mock.calls.length, log.mock.calls.length]).toEqual([0, 0]);
  });

  it("throws, with what to fix, when there is no sync config or the migrations cannot be read", () => {
    const dir = tempDir();
    expect(() => runLint({ given: [], allow: [], cwd: dir })).toThrow(/^no sync config found \(tried sync-config\.yaml, .*\); name one: samesight lint <file>$/);
    writeFileSync(join(dir, "sync-config.yaml"), owned);
    expect(() => runLint({ given: [], migrationsDir: "nowhere", allow: [], cwd: dir })).toThrow("no migrations directory at nowhere; check the path given to --migrations");
  });

  it("names migration files and files it cannot read as given, never by where they are on this machine", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "sync-config.yaml"), owned);
    mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(dir, "supabase", "migrations", "0001.sql"), `${migration}create policy "open" on public.lists for select using (true);\n`);
    const run = runLint({ given: ["sync-config.yaml", "gone.yaml"], allow: [], cwd: dir });
    const open = run.kept.find((f) => f.rule === "rls-open");
    expect(open?.message).toContain(`(${join("supabase", "migrations", "0001.sql")}:3)`);
    expect(JSON.stringify(run)).not.toContain(dir);
    expect(run.unreadable[0]?.error).toMatch(/'gone\.yaml'/);
  });
});

describe("unknownRules", () => {
  it("names the rules --allow entries give that do not exist, by the part before the colon", () => {
    expect(unknownRules(["unscoped-query", "rls-off:lists", "unscoped-querys", "nope:x"])).toEqual(["unscoped-querys", "nope"]);
  });
});
