import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Teardown } from "../autostart/teardown.ts";
import { MUTANT_HEADER } from "./mutants.ts";
import { withSyncConfig } from "./reload.ts";

// How long the put-back's wait for PowerSync to catch up takes: at once, unless a test holds it.
const gate = vi.hoisted(() => ({ wait: async () => {} }));
vi.mock("../differential/run.ts", () => ({ waitForReplication: () => gate.wait() }));

const client = { query: async () => ({ rows: [] }) } as unknown as pg.Client;

/** A temporary directory, removed once the test is done. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "samesight-reload-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The copies of the original a message named, which withSyncConfig keeps: removed once the test is done. */
function removeNamed(said: string) {
  // From the temp directory itself, so a path with spaces still matches.
  const tmp = tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [, dir] of said.matchAll(new RegExp(`(${tmp}[/\\\\]samesight-mutate-[^/\\\\\\s]+)[/\\\\]sync-config\\.yaml`, "g"))) {
    onTestFinished(() => rmSync(dir as string, { recursive: true, force: true }));
  }
}

function project(content: string) {
  const dir = tempDir();
  const configPath = join(dir, "sync-config.yaml");
  writeFileSync(configPath, content);
  // A restart that fails, as a stopped Docker would.
  return { configPath, restart: [process.execPath, "-e", "process.exit(1)"], cwd: dir, url: "http://127.0.0.1:1" };
}

describe("withSyncConfig", () => {
  it("puts the original back when PowerSync cannot load the mutants", async () => {
    const ps = project("streams: {}\n");
    const exits = process.listenerCount("exit");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fn = vi.fn();
    await expect(withSyncConfig(client, ps, `${MUTANT_HEADER}\nstreams: {}\n`, fn)).rejects.toThrow();
    const said = stderr.mock.calls.map(([x]) => String(x));
    stderr.mockRestore();
    removeNamed(said.join(""));
    expect(said).toEqual([expect.stringMatching(/^samesight-verify: restored .* but PowerSync did not reload it and may still serve the mutants: /)]);
    expect(fn).not.toHaveBeenCalled();
    expect(readFileSync(ps.configPath, "utf8")).toBe("streams: {}\n");
    expect(process.listenerCount("exit")).toBe(exits);
  });

  it("refuses to treat another run's mutants as the original", async () => {
    const ps = project(`${MUTANT_HEADER} and restored when it finishes.\nstreams: {}\n`);
    await expect(withSyncConfig(client, ps, "streams: {}\n", async () => {})).rejects.toThrow(/holds mutants from another samesight-verify --mutate run; wait for it, or restore the file \(samesight generate\), then retry$/);
    expect(readFileSync(ps.configPath, "utf8")).toContain(MUTANT_HEADER);
  });
});

describe("withSyncConfig under the run's teardown", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A service that takes up each restart: a new slot on every look, and ready. */
  /** Restarts fail from the `failFrom`th (0-based) on, or only the `failAt`th; each takes `delayMs`. */
  function live(failFrom = Number.POSITIVE_INFINITY, { failAt = -1, delayMs = 0 } = {}) {
    const dir = tempDir();
    const configPath = join(dir, "sync-config.yaml");
    const marker = join(dir, "restarts");
    const done = join(dir, "finished");
    writeFileSync(configPath, "streams: {}\n");
    vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
    let n = 0;
    const slots = { query: async () => ({ rows: [{ name: `powersync_${++n}` }] }) } as unknown as pg.Client;
    const script = `const fs=require("fs");const n=fs.existsSync(${JSON.stringify(marker)})?fs.readFileSync(${JSON.stringify(marker)},"utf8").length:0;fs.appendFileSync(${JSON.stringify(marker)},"r");setTimeout(()=>{fs.appendFileSync(${JSON.stringify(done)},"d");process.exit(n>=${failFrom}||n===${failAt}?1:0)},${delayMs})`;
    const ps = { configPath, restart: [process.execPath, "-e", script], cwd: dir, url: "http://127.0.0.1:1" };
    const restarts = () => readFileSync(marker, "utf8").length;
    const finished = () => (existsSync(done) ? readFileSync(done, "utf8").length : 0);
    return { ps, slots, restarts, finished };
  }

  it("puts the original back as a step when a stop comes mid-run, and the run's own put-back then does nothing", async () => {
    const { ps, slots, restarts } = live();
    const t = new Teardown(() => {}, "policy");
    const signals = process.listenerCount("SIGINT");
    const exits = process.listenerCount("exit");
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
    expect(process.listenerCount("exit")).toBe(exits);
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
    // The step cannot restart PowerSync, nor can the run's own put-back after it: the run fails, saying so.
    await expect(
      withSyncConfig(slots, ps, `${MUTANT_HEADER}\nstreams: {}\n`, async () => {
        expect(await t.run()).toEqual(["the mutant streams PowerSync serves"]);
      }, t),
    ).rejects.toThrow(/PowerSync did not reload it and may still serve the mutants/);
    removeNamed(lines.join("\n"));
    expect(readFileSync(ps.configPath, "utf8")).toBe("streams: {}\n");
    expect(lines).toEqual([expect.stringMatching(/^could not remove the mutant streams PowerSync serves: .*: exit code 1; PowerSync serves them to every device until it restarts on the original sync config: the original is at .*sync-config\.yaml; copy it to .* if it is not there, then restart PowerSync \(.*\)$/)]);
  });

  it("still restarts PowerSync as a step when the run's own put-back did not get it to reload, and keeps the copy it named", async () => {
    // Loading the mutants works; the put-back's restart fails, as a Ctrl+C that kills it would; the step's works.
    const { ps, slots, restarts } = live(Number.POSITIVE_INFINITY, { failAt: 1 });
    const t = new Teardown(() => {}, "policy");
    const error = await withSyncConfig(slots, ps, `${MUTANT_HEADER}\nstreams: {}\n`, async () => {}, t).catch((e: Error) => e);
    removeNamed(String(error));
    expect(String(error)).toMatch(/did not reload/);
    const copy = /a copy is at (\S+)\)/.exec(String(error))?.[1] as string;
    expect(restarts()).toBe(2);
    expect(await t.run()).toEqual([]);
    expect(restarts()).toBe(3);
    expect(readFileSync(ps.configPath, "utf8")).toBe("streams: {}\n");
    // The run's error named it: it is not deleted from under that message.
    expect(existsSync(copy)).toBe(true);
  });

  it("restarts PowerSync once when a stop comes while the run is still going", async () => {
    const { ps, slots, restarts } = live(Number.POSITIVE_INFINITY, { delayMs: 300 });
    const t = new Teardown(() => {}, "policy");
    // The stop's step starts restarting; the run then fails (its devices lose PowerSync) and puts back too.
    const run = withSyncConfig(
      slots,
      ps,
      `${MUTANT_HEADER}\nstreams: {}\n`,
      async () => {
        void t.run();
        await new Promise((r) => setTimeout(r, 50));
        throw new Error("devices lost PowerSync");
      },
      t,
    );
    await expect(run).rejects.toThrow("devices lost PowerSync");
    expect(await t.run()).toEqual([]);
    // Loaded once, restored once.
    expect(restarts()).toBe(2);
    expect(readFileSync(ps.configPath, "utf8")).toBe("streams: {}\n");
  });

  it("lets a stop in during the put-back's restart, and the step waits for that restart instead of its own", async () => {
    const { ps, slots, restarts, finished } = live(Number.POSITIVE_INFINITY, { delayMs: 1000 });
    const t = new Teardown(() => {}, "policy");
    let during: [number, number] | undefined;
    let stop: Promise<string[]> | undefined;
    await withSyncConfig(
      slots,
      ps,
      `${MUTANT_HEADER}\nstreams: {}\n`,
      async () => {
        // The run ends; the stop comes once its put-back's restart has begun.
        const poll = setInterval(() => {
          if (restarts() < 2) return;
          clearInterval(poll);
          during = [restarts(), finished()];
          stop = t.run();
        }, 10);
      },
      t,
    );
    // The stop got in while that restart ran (it does not block: one finished, the load's), and restarted nothing itself.
    expect(during).toEqual([2, 1]);
    expect(await stop).toEqual([]);
    expect(restarts()).toBe(2);
  });

  it("does not hold a stop for the put-back's wait for PowerSync to catch up", async () => {
    const { ps, slots } = live();
    const t = new Teardown(() => {}, "policy");
    let release = () => {};
    let stopped: string[] | undefined;
    const run = withSyncConfig(
      slots,
      ps,
      `${MUTANT_HEADER}\nstreams: {}\n`,
      async () => {
        // Loaded; from here the put-back's catching up hangs until released, and a stop comes during it.
        gate.wait = () =>
          new Promise<void>((r) => {
            release = r;
            void t.run().then((x) => {
              stopped = x;
            });
          });
      },
      t,
    );
    try {
      await vi.waitFor(() => expect(stopped).toEqual([]), { timeout: 3000 });
    } finally {
      release();
      gate.wait = async () => {};
    }
    await run;
  });

  it("says nothing false after a stop restarted PowerSync and ended the run's connection", async () => {
    const { ps, restarts } = live();
    const t = new Teardown(() => {}, "policy");
    // The stop's next step ends the run's connection: every query after it fails.
    let ended = false;
    let n = 0;
    const client = {
      query: async () => {
        if (ended) throw new Error("Connection terminated");
        return { rows: [{ name: `powersync_${++n}` }] };
      },
    } as unknown as pg.Client;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        withSyncConfig(client, ps, `${MUTANT_HEADER}\nstreams: {}\n`, async () => {
          await t.run();
          ended = true;
          throw new Error("Connection terminated");
        }, t),
      ).rejects.toThrow("Connection terminated");
      expect(stderr.mock.calls.map(([x]) => String(x)).filter((x) => x.includes("may still serve the mutants"))).toEqual([]);
    } finally {
      stderr.mockRestore();
    }
    expect(restarts()).toBe(2);
    expect(readFileSync(ps.configPath, "utf8")).toBe("streams: {}\n");
  });

  it("keeps the copy a failed step named, though the run's put-back then reloads", async () => {
    // Loading works; the stop's step fails; the put-back's restart after it works.
    const { ps, slots } = live(Number.POSITIVE_INFINITY, { failAt: 1 });
    const lines: string[] = [];
    const t = new Teardown((l) => lines.push(l), "policy");
    await withSyncConfig(slots, ps, `${MUTANT_HEADER}\nstreams: {}\n`, async () => {
      await t.run();
    }, t);
    removeNamed(lines.join("\n"));
    const copy = /the original is at (\S+);/.exec(lines.join("\n"))?.[1] as string;
    expect(copy).toBeDefined();
    expect(existsSync(copy)).toBe(true);
  });

  it("gives the restart command nothing to read, so one that reads stdin does not hang", async () => {
    const { ps, slots } = live();
    ps.restart = [process.execPath, "-e", "require('fs').readFileSync(0)"];
    await withSyncConfig(slots, ps, `${MUTANT_HEADER}\nstreams: {}\n`, async () => {});
  }, 5000);

  it("refuses to begin once the teardown has", async () => {
    const { ps, slots } = live();
    const t = new Teardown(() => {});
    await t.run();
    await expect(withSyncConfig(slots, ps, "streams: {}\n", async () => {}, t)).rejects.toThrow("stopped");
    expect(readFileSync(ps.configPath, "utf8")).toBe("streams: {}\n");
  });
});
