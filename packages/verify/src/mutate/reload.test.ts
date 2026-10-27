import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Teardown } from "../autostart/teardown.ts";
import { MUTANT_HEADER } from "./mutants.ts";
import { withSyncConfig } from "./reload.ts";

vi.mock("../differential/run.ts", () => ({ waitForReplication: async () => {} }));

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

describe("withSyncConfig under the run's teardown", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A service that takes up each restart: a new slot on every look, and ready. */
  function live(failFrom = Number.POSITIVE_INFINITY) {
    const dir = mkdtempSync(join(tmpdir(), "samesight-reload-test-"));
    const configPath = join(dir, "sync-config.yaml");
    const marker = join(dir, "restarts");
    writeFileSync(configPath, "streams: {}\n");
    vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
    let n = 0;
    const slots = { query: async () => ({ rows: [{ name: `powersync_${++n}` }] }) } as unknown as pg.Client;
    const script = `const fs=require("fs");const n=fs.existsSync(${JSON.stringify(marker)})?fs.readFileSync(${JSON.stringify(marker)},"utf8").length:0;fs.appendFileSync(${JSON.stringify(marker)},"r");process.exit(n>=${failFrom}?1:0)`;
    const ps = { configPath, restart: [process.execPath, "-e", script], cwd: dir, url: "http://127.0.0.1:1" };
    const restarts = () => readFileSync(marker, "utf8").length;
    return { ps, slots, restarts };
  }

  it("puts the original back as a step when a stop comes mid-run, and the run's own put-back then does nothing", async () => {
    const { ps, slots, restarts } = live();
    const t = new Teardown(() => {}, "policy");
    const signals = process.listenerCount("SIGINT");
    await withSyncConfig(
      slots,
      ps,
      `${MUTANT_HEADER}\nstreams: {}\n`,
      async () => {
        // Its own signal handlers are the run's: none of its own.
        expect(process.listenerCount("SIGINT")).toBe(signals);
        expect(readFileSync(ps.configPath, "utf8")).toContain(MUTANT_HEADER);
        expect(await t.run()).toEqual([]);
        expect(readFileSync(ps.configPath, "utf8")).toBe("streams: {}\n");
      },
      t,
    );
    // Loaded once, restarted once by the step; the put-back after it neither writes nor restarts.
    expect(restarts()).toBe(2);
    expect(process.listenerCount("exit")).toBe(0);
  });

  it("does nothing as a step once the run has put the original back", async () => {
    const { ps, slots, restarts } = live();
    const t = new Teardown(() => {});
    await withSyncConfig(slots, ps, `${MUTANT_HEADER}\nstreams: {}\n`, async () => {}, t);
    expect(restarts()).toBe(2);
    expect(await t.run()).toEqual([]);
    expect(restarts()).toBe(2);
    expect(readFileSync(ps.configPath, "utf8")).toBe("streams: {}\n");
  });

  it("says where the original is and how to load it when the step cannot restart PowerSync", async () => {
    const { ps, slots } = live(1);
    const lines: string[] = [];
    const t = new Teardown((l) => lines.push(l));
    await withSyncConfig(slots, ps, `${MUTANT_HEADER}\nstreams: {}\n`, async () => {
      expect(await t.run()).toEqual(["the mutants in the sync config"]);
    }, t);
    expect(readFileSync(ps.configPath, "utf8")).toBe("streams: {}\n");
    expect(lines).toEqual([expect.stringMatching(/^could not remove the mutants in the sync config: .*: exit code 1; the original is at .*sync-config\.yaml: copy it to .* if it is not there, then restart PowerSync \(.*\)/)]);
  });

  it("refuses to begin once the teardown has", async () => {
    const { ps, slots } = live();
    const t = new Teardown(() => {});
    await t.run();
    await expect(withSyncConfig(slots, ps, "streams: {}\n", async () => {}, t)).rejects.toThrow("stopped");
    expect(readFileSync(ps.configPath, "utf8")).toBe("streams: {}\n");
  });
});
