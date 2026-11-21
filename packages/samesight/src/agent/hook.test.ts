import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { agentHook, type HookOptions } from "./hook.ts";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "samesight-hook-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const config = (query: string) => `config:\n  edition: 3\nstreams:\n  user_data:\n    auto_subscribe: true\n    queries:\n      - ${query}\n`;
const leaky = config("SELECT * FROM lists");
const owned = config("SELECT * FROM lists WHERE owner_id = auth.user_id()");
// A fixed filter: a warning, not an error.
const fixed = config("SELECT * FROM lists WHERE status = 'public'");
const migration = "create table public.lists (id uuid primary key, owner_id uuid references auth.users, status text);\nalter table public.lists enable row level security;\ncreate policy \"own\" on public.lists for select to authenticated using (owner_id = (select auth.uid()));\n";

const NONE: HookOptions = { given: [], allow: [] };
const edited = (dir: string, path: string, extra: object = {}) => JSON.stringify({ session_id: "s", cwd: dir, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(dir, path) }, ...extra });
const hook = (dir: string, input: string, options = NONE, env: object = {}) => agentHook(input, options, { cwd: "/nowhere", skillDir: join(dir, "no-skill"), ...env });
const context = (r: { stdout: string }) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;

describe("agentHook", () => {
  it("blocks on an error finding, with the finding, where to read the fix and what to do", () => {
    const dir = project({ "powersync/sync-config.yaml": leaky, "supabase/migrations/1_lists.sql": migration });
    const r = hook(dir, edited(dir, "powersync/sync-config.yaml"));
    expect([r.code, r.stdout]).toEqual([2, ""]);
    expect(r.stderr.split("\n")).toEqual([
      "samesight lint found 1 error after this edit:",
      expect.stringMatching(/^powersync\/sync-config\.yaml:7:9 {2}error {2}unscoped-query {2}stream user_data, queries\[0\] sends every row of lists to every user/),
      "  Fix: references/unscoped-query.md in the samesight skill, or https://rayanyedaly.github.io/samesight/rules/unscoped-query",
      "Fix the errors above before going on. If a finding is intended, ask the user before accepting it with --allow.",
      "",
    ]);
  });

  it("blocks on a sync config lint cannot read", () => {
    const dir = project({ "sync-config.yaml": "streams: [\n" });
    const r = hook(dir, edited(dir, "sync-config.yaml"));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^samesight lint found 1 sync config it cannot read after this edit:\nsync-config\.yaml: cannot be read as a sync config: /);
  });

  it("passes warnings as context, and says when the RLS rules did not run", () => {
    const dir = project({ "sync-config.yaml": fixed });
    const r = hook(dir, edited(dir, "sync-config.yaml"));
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(context(r).split("\n")).toEqual([
      "samesight lint found 1 finding in sync-config.yaml, none of them an error. Decide each with the user; they do not block.",
      expect.stringMatching(/^sync-config\.yaml:7:9 {2}warning {2}unscoped-query {2}/),
      "  Fix: references/unscoped-query.md in the samesight skill, or https://rayanyedaly.github.io/samesight/rules/unscoped-query",
      "No migrations were read (none in supabase/migrations), so the RLS rules (rls-off, rls-open) did not run.",
    ]);
  });

  it("says a clean lint is not proof", () => {
    const dir = project({ "sync-config.yaml": owned, "supabase/migrations/1_lists.sql": migration });
    const r = hook(dir, edited(dir, "supabase/migrations/1_lists.sql"));
    expect([r.code, context(r)]).toEqual([0, "samesight lint: no findings in sync-config.yaml. Lint reads files only; a clean lint does not show that no rows leak (samesight audit tests that on the local stack)."]);
  });

  it("says nothing about an edit to anything else: another file, service.yaml, a nested .sql, a file outside the project", () => {
    const dir = project({ "powersync/sync-config.yaml": leaky, "powersync/service.yaml": "telemetry: {}\n", "supabase/migrations/old/1.sql": "", "README.md": "" });
    for (const path of ["README.md", "powersync/service.yaml", "supabase/migrations/old/1.sql", "../elsewhere/sync-config.yaml"]) {
      expect(hook(dir, edited(dir, path)), path).toEqual({ code: 0, stdout: "", stderr: "" });
    }
    // Another event, or no sync config at all.
    expect(hook(dir, edited(dir, "powersync/sync-config.yaml", { hook_event_name: "PreToolUse" }))).toEqual({ code: 0, stdout: "", stderr: "" });
    const bare = project({ "supabase/migrations/1.sql": migration });
    expect(hook(bare, edited(bare, "supabase/migrations/1.sql"))).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("lints a sync config outside the usual paths when the edit was to it, beside the usual one", () => {
    const dir = project({ "sync-config.yaml": owned, "config/streams.yml": leaky });
    const r = hook(dir, edited(dir, "config/streams.yml"));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/\nconfig\/streams\.yml:7:9 {2}error {2}unscoped-query/);
  });

  it("takes the sync configs, migrations and --allow the hook command names", () => {
    const dir = project({ "app/sync.yaml": leaky, "db/1.sql": migration });
    const options = { given: ["app/sync.yaml"], migrationsDir: "db", allow: [] };
    expect(hook(dir, edited(dir, "db/1.sql"), options).code).toBe(2);
    const allowed = hook(dir, edited(dir, "app/sync.yaml"), { ...options, allow: ["unscoped-query:lists"] });
    expect([allowed.code, context(allowed)]).toEqual([0, expect.stringMatching(/^samesight lint: no findings in app\/sync\.yaml\./)]);
    const bad = hook(dir, edited(dir, "app/sync.yaml"), { ...options, migrationsDir: "nowhere" });
    expect([bad.code, context(bad)]).toEqual([0, "samesight lint could not run: no migrations directory at nowhere; check the path given to --migrations"]);
    const typo = hook(dir, edited(dir, "app/sync.yaml"), { ...options, allow: ["unscoped-querry"] });
    expect([typo.code, context(typo)]).toEqual([0, expect.stringMatching(/^samesight lint could not run: --allow names no rule unscoped-querry; the rules are /)]);
  });

  it("finds the project from $CLAUDE_PROJECT_DIR, else the payload's cwd, and reads relative paths from the payload's cwd", () => {
    const dir = project({ "sync-config.yaml": leaky });
    const input = JSON.stringify({ cwd: dir, tool_input: { file_path: "sync-config.yaml" } });
    expect(hook(dir, input).code).toBe(2);
    const noCwd = JSON.stringify({ tool_input: { file_path: join(dir, "sync-config.yaml") } });
    expect(hook(dir, noCwd, NONE, { projectDir: dir }).code).toBe(2);
    expect(hook(dir, noCwd, NONE, { cwd: dir }).code).toBe(2);
  });

  it("matches paths without case on Windows", () => {
    const dir = project({ "sync-config.yaml": leaky });
    const upper = JSON.stringify({ cwd: dir, tool_input: { file_path: join(dir, "SYNC-CONFIG.yaml") } });
    expect(hook(dir, upper).code).toBe(0);
    expect(hook(dir, upper, NONE, { win32: true }).code).toBe(2);
  });

  it("reads Codex's apply_patch and, with no file named, the paths a command mentions", () => {
    const dir = project({ "powersync/sync-config.yaml": leaky });
    const patch = JSON.stringify({ cwd: dir, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Update File: powersync/sync-config.yaml\n@@\n-a\n+b\n*** End Patch\n" } });
    expect(hook(dir, patch).code).toBe(2);
    const shell = (command: string) => JSON.stringify({ cwd: dir, tool_name: "Bash", tool_input: { command } });
    expect(hook(dir, shell("sed -i s/a/b/ powersync/sync-config.yaml")).code).toBe(2);
    expect(hook(dir, shell("ls"))).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("cuts what it says to what a hook may pass, saying how to see the rest", () => {
    const streams = Array.from({ length: 80 }, (_, i) => `  s${i}:\n    auto_subscribe: true\n    query: SELECT * FROM table_with_a_long_name_${i}\n`).join("");
    const dir = project({ "sync-config.yaml": `config:\n  edition: 3\nstreams:\n${streams}` });
    const r = hook(dir, edited(dir, "sync-config.yaml"));
    expect(r.code).toBe(2);
    expect(r.stderr.length).toBeLessThan(9_600);
    expect(r.stderr).toMatch(/\nand \d+ more lines: run npx samesight lint --format json\n$/);
  });

  it("says when an installed copy of the skill differs from the package's", () => {
    const dir = project({ "sync-config.yaml": owned, "skill/SKILL.md": "new\n", "skill/references/a.md": "a\n", ".claude/skills/samesight/SKILL.md": "old\n", ".agents/skills/samesight/SKILL.md": "new\n", ".agents/skills/samesight/references/a.md": "a\n" });
    const r = hook(dir, edited(dir, "sync-config.yaml"), NONE, { skillDir: join(dir, "skill") });
    expect(context(r).split("\n").slice(1)).toEqual(["No migrations were read (none in supabase/migrations), so the RLS rules (rls-off, rls-open) did not run.", "The samesight skill in .claude/skills/samesight differs from the one this samesight ships; npx samesight agent init updates it."]);
  });

  it("never blocks on a payload it cannot read, or on a problem of its own", () => {
    const dir = project({ "sync-config.yaml": leaky });
    expect(hook(dir, "not json")).toEqual({ code: 0, stdout: "", stderr: "samesight agent hook: no hook payload on stdin (a JSON object); nothing to check\n" });
    const broken = hook(dir, edited(dir, "sync-config.yaml"), { given: [], allow: null as unknown as string[] });
    expect([broken.code, broken.stdout]).toEqual([0, ""]);
    expect(broken.stderr).toMatch(/^samesight agent hook: internal error: /);
  });
});
