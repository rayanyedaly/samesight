/**
 * Fieldbook's verify with --mutate stopped by Ctrl+C while PowerSync serves the mutants:
 * the sync config is put back and PowerSync restarted on it, the run's users go, and the
 * next run can take the lock. Runs the CLI as a user would.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLocal } from "../db.ts";
import { PREFIX } from "../differential/run.ts";
import { readStack } from "../stack.ts";
import { MUTANT_HEADER } from "./mutants.ts";

const APP = fileURLToPath(new URL("../../../../examples/fieldbook/", import.meta.url));
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const CONFIG = `${APP}powersync/sync-config.yaml`;
const POWERSYNC = "http://127.0.0.1:8080";

let client: pg.Client;
let child: ChildProcess | undefined;
beforeAll(async () => {
  client = await connectLocal(readStack(APP, POWERSYNC).db);
});
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await client?.end();
});

describe("a --mutate run stopped by Ctrl+C while PowerSync serves the mutants", () => {
  it("puts the sync config back, restarts PowerSync on it, and removes its users", async () => {
    const original = readFileSync(CONFIG, "utf8");
    child = spawn(process.execPath, [CLI, "--mutate", "--runs", "1"], { cwd: APP, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stderr?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const exit = new Promise<number | null>((r) => child?.on("exit", (code) => r(code)));
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
    child.kill("SIGINT");
    expect(await exit, out).toBe(130);
    expect(readFileSync(CONFIG, "utf8")).toBe(original);
    const count = async (sql: string) => Number((await client.query<{ n: string }>(sql)).rows[0]?.n);
    expect(await count("select count(*) as n from auth.users where email like '%@verify.samesight.test'")).toBe(0);
    expect(await count(`select count(*) as n from public."Tenant" where id::text like '${PREFIX}%'`)).toBe(0);
    const lock = Number.parseInt(PREFIX, 16);
    expect((await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [lock])).rows).toEqual([{ ok: true }]);
    await client.query("select pg_advisory_unlock($1)", [lock]);
    // The step restarts PowerSync without waiting for it: it comes back on the original, on one slot.
    const ready = async () => {
      try {
        return (await fetch(`${POWERSYNC}/probes/readiness`)).ok;
      } catch {
        return false;
      }
    };
    const slots = () => count("select count(*) as n from pg_replication_slots where slot_name like 'powersync%'");
    const until = Date.now() + 120_000;
    while (Date.now() < until && !((await ready()) && (await slots()) === 1)) await new Promise((r) => setTimeout(r, 1000));
    expect([await ready(), await slots()]).toEqual([true, 1]);
  }, 400_000);
});
