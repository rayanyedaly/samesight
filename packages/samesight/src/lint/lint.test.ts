import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineRule, findSyncConfig, lineOf, lintSyncConfig, RULE_NAMES, RULES } from "./lint.ts";
import { applyMigrations } from "./migrations.ts";

const streams = "config:\n  edition: 3\n\nstreams:\n  user_data:\n    auto_subscribe: true\n    queries:\n      - SELECT * FROM lists WHERE owner_id = auth.user_id()\n";

describe("lintSyncConfig", () => {
  it("runs each rule on the parsed config, and places queries by line", () => {
    const rule = defineRule("test", ({ file, config, lineOf }) =>
      config.streams.flatMap((s) => s.queries.map((q) => ({ rule: "test", level: "info" as const, file, line: lineOf(q.sql), message: s.name }))),
    );
    expect(lintSyncConfig(streams, "sync-config.yaml", [rule])).toEqual([{ rule: "test", level: "info", file: "sync-config.yaml", line: 8, message: "user_data" }]);
  });

  it("throws on a file that is not a sync config it can read", () => {
    expect(() => lintSyncConfig("streams: [1]\n", "x.yaml")).toThrow(/no streams: section/);
  });
});

describe("RULE_NAMES", () => {
  // One config and migration that every rule has something to say about.
  const everything = [
    "config:\n  edition: 3\nstreams:",
    "  everything:\n    query: SELECT * FROM customers",
    "  by_param:\n    auto_subscribe: true\n    query: SELECT * FROM todos WHERE list_id = subscription.parameter('list')",
    "  by_metadata:\n    auto_subscribe: true\n    query: SELECT * FROM tasks WHERE team_id = auth.parameter('user_metadata') ->> 'team'",
    "  odd:\n    auto_subscribe: true\n    query: SELECT * FROM lists AS mine WHERE owner_id = auth.user_id()",
    "",
  ].join("\n");
  const migrations = applyMigrations([{ file: "m.sql", sql: "create policy open on customers using (true);" }]);

  it("are the rules' own names, each on every finding the rule makes, so --allow reaches each one", () => {
    expect(RULE_NAMES).toEqual(["unscoped-query", "client-scoped", "user-metadata", "unreadable-query", "not-auto-subscribed", "rls-off", "rls-open"]);
    for (const rule of RULES) {
      const found = lintSyncConfig(everything, "s.yaml", [rule], migrations);
      expect(found.length, rule.ruleName).toBeGreaterThan(0);
      expect(new Set(found.map((f) => f.rule)), rule.ruleName).toEqual(new Set([rule.ruleName]));
    }
  });
});

describe("lineOf", () => {
  it("places a query at its first content line, whatever the spacing, and gives up on what it cannot find", () => {
    const text = "streams:\n  s:\n    query: |\n      SELECT *\n        FROM todos\n";
    expect(lineOf(text, "SELECT  *\nFROM todos")).toBe(4);
    expect(lineOf(text, "SELECT id FROM lists")).toBeUndefined();
    expect(lineOf(text, "")).toBeUndefined();
    expect(lineOf("q: >-\n\n  SELECT 1\n", "SELECT 1")).toBe(3);
    expect(lineOf('q: "SELECT\\n 2"\n', "SELECT 2")).toBe(1);
  });

  it("matches whole strings only: not a comment, not a longer query that starts the same", () => {
    const text = [
      "streams:",
      "  # SELECT * FROM todos",
      "  a:",
      "    query: SELECT * FROM todos WHERE owner_id = auth.user_id()",
      "  b:",
      "    query: SELECT * FROM todos",
      "",
    ].join("\n");
    expect(lineOf(text, "SELECT * FROM todos")).toBe(6);
  });
});

describe("findSyncConfig", () => {
  it("takes the first usual path that exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-lint-"));
    expect(findSyncConfig(dir)).toBeUndefined();
    mkdirSync(join(dir, "powersync"));
    writeFileSync(join(dir, "powersync", "sync-rules.yaml"), "");
    expect(findSyncConfig(dir)).toBe("powersync/sync-rules.yaml");
    writeFileSync(join(dir, "sync-config.yaml"), "");
    expect(findSyncConfig(dir)).toBe("sync-config.yaml");
  });
});

describe("samesight lint", () => {
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, "lint", ...args], { cwd, encoding: "utf8" });

  it("exits 0 on a clean config, and 2 when there is no config or it cannot be read", () => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-lint-"));
    const none = run(dir);
    expect(none.status).toBe(2);
    expect(none.stderr).toMatch(/No sync config found/);
    writeFileSync(join(dir, "sync-config.yaml"), streams);
    const clean = run(dir);
    expect([clean.status, clean.stdout.trim()]).toEqual([0, "No problems found."]);
    writeFileSync(join(dir, "bad.yaml"), "streams: [1]\n");
    const bad = run(dir, "sync-config.yaml", "bad.yaml");
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toMatch(/bad.yaml: cannot be read as a sync config.*\n1 of 2 file\(s\) could not be read/);
  });

  it("accepts --allow for a known rule, reports what it allowed, and refuses an unknown rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-lint-"));
    writeFileSync(join(dir, "sync-config.yaml"), "config:\n  edition: 3\nstreams:\n  all:\n    auto_subscribe: true\n    query: SELECT * FROM customers\n");
    expect(run(dir).status).toBe(1);
    const allowed = run(dir, "--allow", "unscoped-query:customers");
    expect([allowed.status, allowed.stdout]).toEqual([0, "No problems found.\n1 finding allowed by --allow\n"]);
    const typo = run(dir, "--allow", "unscoped-querry");
    expect([typo.status, typo.stderr]).toEqual([2, expect.stringMatching(/--allow names no rule unscoped-querry/)]);
  });

  it("prints one JSON object on stdout with --format json, keeping notes on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-lint-"));
    writeFileSync(join(dir, "sync-config.yaml"), "config:\n  edition: 3\nstreams:\n  all:\n    auto_subscribe: true\n    query: SELECT * FROM customers\n");
    writeFileSync(join(dir, "bad.yaml"), "streams: [1]\n");
    const out = run(dir, "sync-config.yaml", "bad.yaml", "--format", "json");
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/note: no supabase\/migrations here/);
    expect(JSON.parse(out.stdout)).toEqual({
      files: ["sync-config.yaml", "bad.yaml"],
      rlsChecked: false,
      findings: [expect.objectContaining({ rule: "unscoped-query", level: "error", file: "sync-config.yaml", line: 6, subjects: ["all", "customers"] })],
      allowed: [],
      unreadable: [{ file: "bad.yaml", error: "the sync config has no streams: section" }],
      errors: 1,
      warnings: 0,
      notes: 0,
      exitCode: 2,
    });
    expect(run(dir, "--format", "xml").status).toBe(2);
  });
});
