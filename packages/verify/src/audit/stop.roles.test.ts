/**
 * A full audit of examples/audit-roles stopped by Ctrl+C mid-differential: the run users, the
 * rows the access token hook read (memberships, teams) and the generated rows all go, and
 * the next run can take the lock. Runs the CLI as a user would.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLocal } from "../db.ts";
import { PREFIX } from "../differential/run.ts";
import { readStack } from "../stack.ts";

const APP = fileURLToPath(new URL("../../../../examples/audit-roles/", import.meta.url));
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

let client: pg.Client;
let child: ChildProcess | undefined;
beforeAll(async () => {
  client = await connectLocal(readStack(APP, "http://127.0.0.1").db);
});
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await client?.end();
});

describe("a roles audit stopped by Ctrl+C mid-differential", () => {
  it("removes its users, the hook's rows and the generated rows", async () => {
    child = spawn(process.execPath, [CLI, "audit", "--project", APP, "--sync-config", `${APP}sync-config.yaml`, "--runs", "200"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stderr?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const exit = new Promise<number | null>((r) => child?.on("exit", (code) => r(code)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no differential within 200s:\n${out}`)), 200_000);
      child?.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("generating datasets for the differential")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child?.on("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`the audit exited (${code}) before its differential:\n${out}`));
      });
    });
    const count = async (sql: string) => Number((await client.query<{ n: string }>(sql)).rows[0]?.n);
    // The hook's rows are in before the differential; generated rows may or may not be at this moment.
    expect(await count(`select count(*) as n from public.memberships where id::text like '${PREFIX}%'`)).toBeGreaterThan(0);
    expect(await count(`select count(*) as n from public.teams where id::text like '${PREFIX}%'`)).toBeGreaterThan(0);
    child.kill("SIGINT");
    expect(await exit, out).toBe(130);
    expect(await count("select count(*) as n from auth.users where email like '%@verify.samesight.test'")).toBe(0);
    for (const table of ["memberships", "teams", "documents", "orgs"]) expect(await count(`select count(*) as n from public.${table} where id::text like '${PREFIX}%'`), table).toBe(0);
    const lock = Number.parseInt(PREFIX, 16);
    expect((await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [lock])).rows).toEqual([{ ok: true }]);
    await client.query("select pg_advisory_unlock($1)", [lock]);
  }, 240_000);
});
