/**
 * Swapping the PowerSync sync config for the mutation test. The service reads its config
 * at startup (an API deploy is refused while service.yaml names a config file), so a swap
 * is: write the file, restart the service, wait for the new sync rules to replicate. New
 * rules replicate into a new slot, and the old slot is dropped once they take over.
 *
 * The original file is always put back: in `finally`, and on Ctrl-C, from a copy kept
 * outside the project.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
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
  const [cmd, ...args] = ps.restart;
  if (!cmd) throw new Error("no restart command");
  execFileSync(cmd, args, { cwd: ps.cwd, stdio: ["ignore", "ignore", "pipe"] });
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

/** Runs `fn` with `config` as the sync config, then restores the original and reloads again. */
export async function withSyncConfig<T>(client: pg.Client, ps: PowerSyncControl, config: string, fn: () => Promise<T>): Promise<T> {
  const original = readFileSync(ps.configPath, "utf8");
  // Another run's mutants, or ones an earlier run could not take back: restoring "this"
  // original would put the mutants back for good.
  if (original.startsWith(MUTANT_HEADER)) {
    throw new Error(`${ps.configPath} holds mutants from another samesight verify --mutate run; wait for it, or restore the file (samesight generate), then retry`);
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
      process.stderr.write(`\nsamesight verify: restored ${ps.configPath} and restarted PowerSync.\n`);
    } catch {
      process.stderr.write(`\nsamesight verify: restored ${ps.configPath}; restart PowerSync to load it (${ps.restart.join(" ")}).\n`);
    }
    process.exit(signal === "SIGTERM" ? 143 : 130);
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? (["SIGBREAK"] as const) : [])];
  for (const s of signals) process.once(s, onSignal);
  // Any other exit (process.exit elsewhere, an uncaught error): the file at least.
  process.once("exit", restore);
  // Puts the original back. A failed reload fails the run, unless an earlier error is
  // already on its way out.
  const putBack = async (strict: boolean) => {
    restore();
    for (const s of signals) process.off(s, onSignal);
    process.off("exit", restore);
    try {
      await reload(client, ps, false);
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      const message = `restored ${ps.configPath} (a copy is at ${backup}), but PowerSync did not reload it and may still serve the mutants: ${(e as Error).message}`;
      if (strict) throw new Error(message);
      process.stderr.write(`samesight verify: ${message}\n`);
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
