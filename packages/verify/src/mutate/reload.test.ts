import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { MUTANT_HEADER } from "./mutants.ts";
import { withSyncConfig } from "./reload.ts";

const client = { query: async () => ({ rows: [] }) } as unknown as pg.Client;

function project(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "samesight-reload-test-"));
  const configPath = join(dir, "sync-config.yaml");
  writeFileSync(configPath, content);
  // A restart that fails, as a stopped Docker would.
  return { configPath, restart: [process.execPath, "-e", "process.exit(1)"], cwd: dir, url: "http://127.0.0.1:1" };
}

describe("withSyncConfig", () => {
  it("puts the original back when PowerSync cannot load the mutants", async () => {
    const ps = project("streams: {}\n");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fn = vi.fn();
    await expect(withSyncConfig(client, ps, `${MUTANT_HEADER}\nstreams: {}\n`, fn)).rejects.toThrow();
    stderr.mockRestore();
    expect(fn).not.toHaveBeenCalled();
    expect(readFileSync(ps.configPath, "utf8")).toBe("streams: {}\n");
    expect(process.listenerCount("exit")).toBe(0);
  });

  it("refuses to treat another run's mutants as the original", async () => {
    const ps = project(`${MUTANT_HEADER} and restored when it finishes.\nstreams: {}\n`);
    await expect(withSyncConfig(client, ps, "streams: {}\n", async () => {})).rejects.toThrow(/holds mutants from another/);
    expect(readFileSync(ps.configPath, "utf8")).toContain(MUTANT_HEADER);
  });
});
