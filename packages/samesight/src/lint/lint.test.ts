import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findSyncConfig, lineOf, type LintRule, lintSyncConfig } from "./lint.ts";

const streams = "config:\n  edition: 3\n\nstreams:\n  user_data:\n    auto_subscribe: true\n    queries:\n      - SELECT * FROM lists WHERE owner_id = auth.user_id()\n";

describe("lintSyncConfig", () => {
  it("runs each rule on the parsed config, and places queries by line", () => {
    const rule: LintRule = ({ file, config, lineOf }) =>
      config.streams.flatMap((s) => s.queries.map((q) => ({ rule: "test", level: "info" as const, file, line: lineOf(q.sql), message: s.name })));
    expect(lintSyncConfig(streams, "sync-config.yaml", [rule])).toEqual([{ rule: "test", level: "info", file: "sync-config.yaml", line: 8, message: "user_data" }]);
  });

  it("throws on a file that is not a sync config it can read", () => {
    expect(() => lintSyncConfig("streams: [1]\n", "x.yaml")).toThrow(/no streams: section/);
  });
});

describe("lineOf", () => {
  it("finds a query by its first line, whatever the spacing, and gives up on what it cannot find", () => {
    const text = "streams:\n  s:\n    query: |\n      SELECT *\n        FROM todos\n";
    expect(lineOf(text, "SELECT  *\nFROM todos")).toBe(4);
    expect(lineOf(text, "SELECT id FROM lists")).toBeUndefined();
    expect(lineOf(text, "")).toBeUndefined();
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
});
