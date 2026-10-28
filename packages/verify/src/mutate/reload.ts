/**
 * Swapping the PowerSync sync config for the mutation test. The service reads its config
 * at startup (an API deploy is refused while service.yaml names a config file), so a swap
 * is: write the file, restart the service, wait for the new sync rules to replicate. New
 * rules replicate into a new slot, and the old slot is dropped once they take over.
 *
 * The original file is always put back: in `finally`, and on Ctrl-C, from a copy kept
 * outside the project. With the run's teardown, Ctrl-C puts it back as a step of it, before
 * the run's users and rows are removed.
 */

import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import type { Teardown } from "../autostart/teardown.ts";
import { rows } from "../db.ts";
import { waitForReplication } from "../differential/run.ts";
import { MUTANT_HEADER } from "./mutants.ts";

export interface PowerSyncControl {
  /** The sync config file the service reads. */
  configPath: string;
  /** Restarts the service, e.g. ["docker", "compose", "restart", "powersync"]. */
  restart: string[];
  /** Where the restart command runs. */
  cwd: string;
  /** The service's base URL, for its readiness probe. */
  url: string;
}

async function slots(client: pg.Client): Promise<string[]> {
  return (await rows<{ name: string }>(client, "select slot_name as name from pg_replication_slots where slot_type = 'logical' and slot_name like 'powersync%'")).map(
    (r) => r.name,
  );
}

async function ready(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/probes/readiness`)).ok;
  } catch {
    return false;
  }
}

/**
 * Restarts PowerSync and waits until it serves the config on disk: a single slot that did
 * not exist before, caught up. With `expectNew` false (the config may be the one already
 * loaded), a ready service whose slot stays put also counts.
 */
export async function reload(client: pg.Client, ps: PowerSyncControl, expectNew: boolean, timeoutMs = 120_000): Promise<void> {
  const before = new Set(await slots(client));
  // Not blocking: signal handlers, and a teardown's steps and grace, go on during it.
  await restartAsync(ps, timeoutMs);
  await settle(client, ps, before, expectNew, timeoutMs);
}

/** Waits, after a restart, until PowerSync serves the config on disk, as reload says. */
async function settle(client: pg.Client, ps: PowerSyncControl, before: Set<string>, expectNew: boolean, timeoutMs = 120_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const now = await slots(client);
    const fresh = now.filter((s) => !before.has(s));
    if (now.length === 1 && fresh.length === 1 && (await ready(ps.url))) break;
    if (!expectNew && Date.now() - started > 30_000 && now.length === 1 && (await ready(ps.url))) break;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `PowerSync did not take up ${ps.configPath} within ${timeoutMs / 1000}s (slots: ${now.join(", ") || "none"}). Check the service's logs.`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await waitForReplication(client, timeoutMs);
}

/** Runs the restart command, without blocking: a teardown's later steps and its grace go on. */
function restartAsync(ps: PowerSyncControl, timeoutMs: number): Promise<void> {
  const [cmd, ...args] = ps.restart;
  if (!cmd) return Promise.reject(new Error("no restart command"));
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd: ps.cwd, timeout: timeoutMs }, (e, _out, err) => {
      if (!e) return resolve();
      const why = String(err).trim() || (e.killed ? `no end within ${timeoutMs / 1000}s` : `exit code ${e.code}`);
      reject(new Error(`${ps.restart.join(" ")}: ${why}`));
    });
    // Nothing to read: a command that asks would wait out the timeout.
    child.stdin?.end();
  });
}

/**
 * Runs `fn` with `config` as the sync config, then restores the original and reloads again.
 * With `teardown` (the run's, which onSignals runs), a stop puts the original back as a step
 * of it and restarts PowerSync without waiting for it to replicate; otherwise this listens
 * for signals itself.
 */
export async function withSyncConfig<T>(client: pg.Client, ps: PowerSyncControl, config: string, fn: () => Promise<T>, teardown?: Teardown): Promise<T> {
  if (teardown?.started) throw new Error("stopped");
  const original = readFileSync(ps.configPath, "utf8");
  // Another run's mutants, or ones an earlier run could not take back: restoring "this"
  // original would put the mutants back for good.
  if (original.startsWith(MUTANT_HEADER)) {
    throw new Error(`${ps.configPath} holds mutants from another samesight-verify --mutate run; wait for it, or restore the file (samesight generate), then retry`);
  }
  const dir = mkdtempSync(join(tmpdir(), "samesight-mutate-"));
  const backup = join(dir, "sync-config.yaml");
  copyFileSync(ps.configPath, backup);
  const restore = () => writeFileSync(ps.configPath, original);
  // Interrupted: put the file back and restart PowerSync, which would otherwise keep
  // serving the mutant streams to every device until its next restart.
  const onSignal = (signal: NodeJS.Signals) => {
    restore();
    const [cmd, ...args] = ps.restart;
    try {
      if (cmd) execFileSync(cmd, args, { cwd: ps.cwd, stdio: "ignore", timeout: 60_000 });
      process.stderr.write(`\nsamesight-verify: restored ${ps.configPath} and restarted PowerSync.\n`);
    } catch {
      process.stderr.write(`\nsamesight-verify: restored ${ps.configPath}; restart PowerSync to load it (${ps.restart.join(" ")}).\n`);
    }
    process.exit(({ SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 } as Record<string, number>)[signal] ?? 130);
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? (["SIGBREAK"] as const) : [])];
  // Whether PowerSync's restart command ran on the original: then neither the run's putBack
  // nor the teardown's step has anything left to do.
  let reloaded = false;
  // A message has named the copy: it stays, whatever restarts PowerSync after.
  let named = false;
  // One restore at a time: whoever asks while another is under way waits for it, and tries
  // again only if it failed (a Ctrl+C that kills the run's own restart, say).
  // Only the restart is shared: the run's wait for PowerSync to replicate after it is its own,
  // so a stop waits at most for one restart before removing the run's users.
  let restoring: Promise<void> | undefined;
  // True when this call's own attempt restarted PowerSync; false when another had already.
  const restoreOnce = async (how: () => Promise<void>): Promise<boolean> => {
    while (restoring) await restoring.catch(() => {});
    if (reloaded) return false;
    // No await between the check and this: one attempt at a time.
    const attempt = (async () => {
      restore();
      process.off("exit", restore);
      await how();
      reloaded = true;
    })();
    restoring = attempt;
    try {
      await attempt;
    } finally {
      if (restoring === attempt) restoring = undefined;
    }
    return true;
  };
  // The copy goes once PowerSync is back on the original, unless a message has named it.
  const done = () => {
    if (!named) rmSync(dir, { recursive: true, force: true });
  };
  if (teardown) {
    teardown.add(
      "the mutant streams PowerSync serves",
      async () => {
        try {
          // Back on the original, whoever restarted it: after a stop, the put-back names no copy.
          await restoreOnce(() => restartAsync(ps, 60_000));
          done();
        } catch (e) {
          // Its message names the copy.
          named = true;
          throw e;
        }
      },
      `PowerSync serves them to every device until it restarts on the original sync config: the original is at ${backup}; copy it to ${ps.configPath} if it is not there, then restart PowerSync (${ps.restart.join(" ")})`,
    );
  } else for (const s of signals) process.once(s, onSignal);
  // Any other exit (process.exit elsewhere, an uncaught error): the file at least.
  process.once("exit", restore);
  // Puts the original back. A failed reload fails the run, unless an earlier error is
  // already on its way out.
  const putBack = async (strict: boolean) => {
    for (const s of signals) process.off(s, onSignal);
    try {
      let before = new Set<string>();
      const own = await restoreOnce(async () => {
        // Taken after the file is back, and never in the way of the restart.
        before = new Set(await slots(client).catch(() => []));
        // A minute at most, so a stop that waits for it still has time to remove the run's users.
        await restartAsync(ps, 60_000);
      });
      // The stop's step restarted it: the stop goes on from there, and the run's connection may be gone.
      if (!own || teardown?.started) return;
      await settle(client, ps, before, false);
      done();
    } catch (e) {
      named = true;
      const message = `restored ${ps.configPath} (a copy is at ${backup}), but PowerSync did not reload it and may still serve the mutants: ${(e as Error).message}`;
      if (strict) throw new Error(message);
      process.stderr.write(`samesight-verify: ${message}\n`);
    }
  };
  let result: T;
  try {
    writeFileSync(ps.configPath, config);
    await reload(client, ps, true);
    result = await fn();
  } catch (e) {
    await putBack(false);
    throw e;
  }
  await putBack(true);
  return result;
}
