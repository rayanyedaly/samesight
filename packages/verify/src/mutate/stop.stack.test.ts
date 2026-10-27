/**
 * Fieldbook's verify with --mutate stopped by Ctrl+C while PowerSync serves the mutants:
 * the sync config is put back and PowerSync restarted on it, the run's users go, and the
 * next run can take the lock. Runs the CLI as a user would.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLocal } from "../db.ts";
import { PREFIX, waitForReplication } from "../differential/run.ts";
import { readStack } from "../stack.ts";
import { MUTANT_HEADER } from "./mutants.ts";

const APP = fileURLToPath(new URL("../../../../examples/fieldbook/", import.meta.url));
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const CONFIG = `${APP}powersync/sync-config.yaml`;
const POWERSYNC = process.env.SAMESIGHT_POWERSYNC_URL ?? "http://127.0.0.1:8080";

let client: pg.Client;
let child: ChildProcess | undefined;
let exited: Promise<unknown> = Promise.resolve();
let interrupted = false;
// The run's output, for afterAll to show when the test gave up on it.
let out = "";
// Set once PowerSync has caught up on the original: until then, afterAll restarts it.
let settledOnOriginal = false;
const original = readFileSync(CONFIG, "utf8");
beforeAll(async () => {
  // An earlier run killed outright may have left mutants: restore the file (samesight generate) first.
  expect(original).not.toContain(MUTANT_HEADER);
  client = await connectLocal(readStack(APP, POWERSYNC).db);
});
/** A signal to the run's whole process group, as a terminal sends Ctrl+C: its children get it too. */
const signal = (name: NodeJS.Signals) => {
  try {
    process.kill(-(child?.pid as number), name);
  } catch {}
};
// In a group of its own, the run does not get a Ctrl+C that stops the tests: pass it on.
process.once("exit", () => {
  if (child && child.exitCode === null && child.signalCode === null) signal("SIGINT");
});
afterAll(async () => {
  try {
    if (child && !settledOnOriginal) process.stderr.write(`\nthe --mutate run's output:\n${out.slice(-4000)}\n`);
    // A run the test gave up on still cleans up, as Ctrl+C would; killed only if that hangs.
    if (child && child.exitCode === null && child.signalCode === null) {
      if (!interrupted) signal("SIGINT");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 150_000))]);
      if (child.exitCode === null && child.signalCode === null) signal("SIGKILL");
    }
    // Never leave mutants in the tracked file, nor PowerSync serving them, nor a service still starting.
    if (readFileSync(CONFIG, "utf8") !== original) writeFileSync(CONFIG, original);
    if (child && !settledOnOriginal) {
      execFileSync("docker", ["compose", "restart", "powersync"], { cwd: APP, stdio: "ignore", timeout: 120_000 });
      const until = Date.now() + 60_000;
      while (Date.now() < until && !((await ready()) && (await slots()).length === 1)) await new Promise((r) => setTimeout(r, 1000));
      await waitForReplication(client, 60_000).catch(() => {});
    }
  } finally {
    await client?.end();
  }
  // At most 150s for the run to clean up, 120s to restart PowerSync, a minute each to settle and catch up.
}, 420_000);

const slots = async () =>
  (await client.query<{ name: string }>("select slot_name as name from pg_replication_slots where slot_type = 'logical' and slot_name like 'powersync%'")).rows.map((r) => r.name);
const ready = async () => {
  try {
    return (await fetch(`${POWERSYNC}/probes/readiness`, { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
};

describe("a --mutate run stopped by Ctrl+C while PowerSync serves the mutants", () => {
  it("puts the sync config back, restarts PowerSync on it, and removes its users", async () => {
    child = spawn(process.execPath, [CLI, "--mutate", "--runs", "1", "--mutate-datasets", "1", "--powersync", POWERSYNC], { cwd: APP, stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stderr?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const exit = new Promise<number | null>((r) => child?.on("exit", (code) => r(code)));
    exited = exit;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no sync mutants loaded within 240s:\n${out}`)), 240_000);
      child?.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
        if (/\d+s {2}loaded\n/.test(out)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child?.on("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`the run exited (${code}) before loading its sync mutants:\n${out}`));
      });
    });
    expect(readFileSync(CONFIG, "utf8")).toContain(MUTANT_HEADER);
    // The slot serving the mutants: the restart on the original must replace it.
    const mutantSlots = new Set(await slots());
    signal("SIGINT");
    interrupted = true;
    expect(await exit, out).toBe(130);
    expect(readFileSync(CONFIG, "utf8")).toBe(original);
    const count = async (sql: string) => Number((await client.query<{ n: string }>(sql)).rows[0]?.n);
    expect(await count("select count(*) as n from auth.users where email like '%@verify.samesight.test'")).toBe(0);
    expect(await count(`select count(*) as n from public."Tenant" where id::text like '${PREFIX}%'`)).toBe(0);
    const lock = Number.parseInt(PREFIX, 16);
    expect((await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [lock])).rows).toEqual([{ ok: true }]);
    await client.query("select pg_advisory_unlock($1)", [lock]);
    // The step restarts PowerSync without waiting for it: it comes back on the original, on a slot of its own.
    const settled = async () => {
      const now = await slots();
      return now.length === 1 && !mutantSlots.has(now[0] as string) && (await ready());
    };
    const until = Date.now() + 120_000;
    while (Date.now() < until && !(await settled())) await new Promise((r) => setTimeout(r, 1000));
    expect(await settled(), `slots: ${(await slots()).join(", ")}`).toBe(true);
    // Caught up, so whatever runs next syncs the original streams.
    await waitForReplication(client, 120_000);
    settledOnOriginal = true;
    // 240s to load the mutants, the run's two-minute grace, two minutes to settle, two to catch up.
  }, 660_000);
});
