import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { defineRule, findSyncConfig, lineOf, lintSyncConfig, RULE_NAMES, RULES } from "./lint.ts";
import { applyMigrations } from "./migrations.ts";

const temps: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "samesight-lint-"));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const streams = "config:\n  edition: 3\n\nstreams:\n  user_data:\n    auto_subscribe: true\n    queries:\n      - SELECT * FROM lists WHERE owner_id = auth.user_id()\n";

describe("lintSyncConfig", () => {
  it("runs each rule on the parsed config, and places queries by line and column", () => {
    const rule = defineRule("test", ({ file, config, lineOf }) =>
      config.streams.flatMap((s) => s.queries.map((q) => ({ rule: "test", level: "info" as const, file, ...lineOf(q.sql), message: s.name }))),
    );
    expect(lintSyncConfig(streams, "sync-config.yaml", [rule])).toStrictEqual([{ rule: "test", level: "info", file: "sync-config.yaml", line: 8, column: 9, message: "user_data" }]);
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
    "  odd:\n    auto_subscribe: true\n    query: SELECT * FROM lists JOIN shares ON shares.list_id = lists.id WHERE lists.owner_id = auth.user_id()",
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
    expect(lineOf(text, "SELECT  *\nFROM todos")).toEqual({ line: 4, column: 7 });
    expect(lineOf(text, "SELECT id FROM lists")).toBeUndefined();
    expect(lineOf(text, "")).toBeUndefined();
    expect(lineOf("q: >-\n\n  SELECT 1\n", "SELECT 1")).toEqual({ line: 3, column: 3 });
    // A quoted string starts at its quote; a flow sequence's items each where they start.
    expect(lineOf('q: "SELECT\\n 2"\n', "SELECT 2")).toEqual({ line: 1, column: 4 });
    expect(lineOf("q: [SELECT 3, SELECT 4]\n", "SELECT 4")).toEqual({ line: 1, column: 15 });
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
    expect(lineOf(text, "SELECT * FROM todos")).toEqual({ line: 6, column: 12 });
    // The same query twice is placed at its first copy.
    expect(lineOf("a:\n  query: SELECT 1\nb:\n  query: SELECT 1\n", "SELECT 1")).toEqual({ line: 2, column: 10 });
  });
});

describe("findSyncConfig", () => {
  it("takes the first usual path that exists", () => {
    const dir = tempDir();
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
    const dir = tempDir();
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
    // Findings in the readable file still print; the unreadable one still fails the run.
    writeFileSync(join(dir, "open.yaml"), "config:\n  edition: 3\nstreams:\n  all:\n    auto_subscribe: true\n    query: SELECT * FROM customers\n");
    const mixed = run(dir, "open.yaml", "bad.yaml");
    expect([mixed.status, mixed.stdout]).toEqual([2, expect.stringMatching(/^open.yaml:6 {2}error .*\n1 error\n$/)]);
  });

  it("accepts --allow for a known rule, reports what it allowed, and refuses an unknown rule", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "sync-config.yaml"), "config:\n  edition: 3\nstreams:\n  all:\n    auto_subscribe: true\n    query: SELECT * FROM customers\n");
    expect(run(dir).status).toBe(1);
    const allowed = run(dir, "--allow", "unscoped-query:customers");
    expect([allowed.status, allowed.stdout]).toEqual([0, "No problems found.\n1 finding allowed by --allow\n"]);
    const typo = run(dir, "--allow", "unscoped-querry");
    expect([typo.status, typo.stderr]).toEqual([2, expect.stringMatching(/--allow names no rule unscoped-querry/)]);
  });

  it("prints one JSON object on stdout with --format json, keeping notes on stderr", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "sync-config.yaml"), "config:\n  edition: 3\nstreams:\n  all:\n    auto_subscribe: true\n    query: SELECT * FROM customers\n");
    writeFileSync(join(dir, "bad.yaml"), "streams: [1]\n");
    const out = run(dir, "sync-config.yaml", "bad.yaml", "--format", "json");
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/note: no supabase\/migrations here/);
    expect(JSON.parse(out.stdout)).toEqual({
      files: ["sync-config.yaml", "bad.yaml"],
      rlsChecked: false,
      findings: [expect.objectContaining({ rule: "unscoped-query", level: "error", file: "sync-config.yaml", line: 6, column: 12, subjects: ["all", "customers"] })],
      allowed: [],
      unreadable: [{ file: "bad.yaml", error: "the sync config has no streams: section" }],
      errors: 1,
      warnings: 0,
      notes: 0,
      exitCode: 2,
    });
    const xml = run(dir, "--format", "xml");
    expect([xml.status, xml.stderr]).toEqual([2, '--format must be text, json, sarif or github, not "xml"\n']);
  });

  it("prints one SARIF log with --format sarif, with the same exit codes", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "sync-config.yaml"), "config:\n  edition: 3\nstreams:\n  all:\n    auto_subscribe: true\n    query: SELECT * FROM customers\n");
    writeFileSync(join(dir, "bad.yaml"), "streams: [1]\n");
    const sarif = (...args: string[]) => {
      const out = run(dir, ...args, "--format", "sarif");
      const log = JSON.parse(out.stdout);
      return { status: out.status, stderr: out.stderr, run: log.runs[0], version: log.version };
    };
    const failed = sarif();
    expect([failed.status, failed.version, failed.run.tool.driver.name]).toEqual([1, "2.1.0", "samesight"]);
    expect(failed.stderr).toMatch(/note: no supabase\/migrations here/);
    expect(failed.run.results).toEqual([
      expect.objectContaining({ ruleId: "unscoped-query", level: "error", locations: [{ physicalLocation: { artifactLocation: { uri: "sync-config.yaml" }, region: { startLine: 6, startColumn: 12 } } }] }),
    ]);
    expect(failed.run.invocations).toEqual([{ executionSuccessful: true }]);
    const allowed = sarif("--allow", "unscoped-query");
    expect([allowed.status, allowed.run.results[0].suppressions]).toEqual([0, [{ kind: "external", justification: "allowed with --allow" }]]);
    const bad = sarif("sync-config.yaml", "bad.yaml");
    expect([bad.status, bad.run.invocations[0].executionSuccessful, bad.run.results.length]).toEqual([2, false, 1]);
    expect(bad.stderr).toMatch(/bad.yaml: cannot be read as a sync config/);
  });

  it("prints GitHub workflow commands with --format github, with the same exit codes", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "sync-config.yaml"), "config:\n  edition: 3\nstreams:\n  all:\n    auto_subscribe: true\n    query: SELECT * FROM customers\n");
    writeFileSync(join(dir, "bad.yaml"), "streams: [1]\n");
    const failed = run(dir, "--format", "github");
    expect([failed.status, failed.stdout]).toEqual([
      1,
      "::error file=sync-config.yaml,line=6,col=12,title=samesight unscoped-query::stream all, query sends every row of customers to every user: nothing in it reads the requesting user (auth.user_id()) or a token claim\n",
    ]);
    const allowed = run(dir, "--allow", "unscoped-query", "--format", "github");
    expect([allowed.status, allowed.stdout]).toEqual([0, "::notice::1 finding allowed by --allow\n"]);
    const bad = run(dir, "bad.yaml", "--format", "github");
    expect([bad.status, bad.stdout]).toEqual([2, "::error file=bad.yaml::could not read: the sync config has no streams: section\n"]);
  });
});
