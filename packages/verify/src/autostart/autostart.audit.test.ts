/**
 * Auto-start on PowerSync's to-do list demo (pnpm --filter audit-todolist stack:up): a
 * run stopped by Ctrl+C or SIGTERM leaves nothing behind, one killed outright is swept by
 * the next, and the project's own publication is never touched.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connectLocal } from "../db.ts";
import { readStack } from "../stack.ts";
import { Docker } from "./docker.ts";
import { PROJECT_LABEL } from "./storage.ts";
import { sweep } from "./sweep.ts";

const DEMO = fileURLToPath(new URL("../../../../examples/audit-todolist/upstream/", import.meta.url));
const CHILD = fileURLToPath(new URL("../fixtures/autostart-child.ts", import.meta.url));
const PROJECT = "react-supabase-todolist";

let client: pg.Client;
const docker = new Docker();
const children = new Set<ChildProcess>();
beforeAll(async () => {
  client = await connectLocal(readStack(DEMO, "http://127.0.0.1:1").db);
});
// A test that fails half way leaves no child, container, role or slot for the next.
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  children.clear();
  await sweep(docker, client, PROJECT);
});
afterAll(async () => {
  await client?.end();
});

/** Starts the child and resolves with it and its PowerSync URL once it prints READY (within 150s). */
function startChild(keep = false): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [CHILD], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SAMESIGHT_KEEP: keep ? "1" : "0" } });
  children.add(child);
  let err = "";
  child.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the child was not ready within 150s:\n${err}`));
    }, 150_000);
    child.stdout?.on("data", (d: Buffer) => {
      const m = /READY (\S+)/.exec(d.toString());
      if (m?.[1]) {
        clearTimeout(timer);
        resolve({ child, url: m[1] });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the child exited (${code}) before it was ready:\n${err}`));
    });
  });
}

const exited = (child: ChildProcess) => new Promise<number | null>((r) => child.on("exit", (code) => r(code)));

/** What a run leaves: the project's labelled containers, samesight_audit_ roles and slots; and checks the demo's publication is still its own. */
async function leftovers(): Promise<string[]> {
  const roles = await client.query<{ name: string }>("select rolname as name from pg_roles where starts_with(rolname, 'samesight_audit_')");
  const slots = await client.query<{ name: string }>("select slot_name as name from pg_replication_slots where starts_with(slot_name, 'samesight_audit_')");
  const pub = await client.query<{ all: boolean }>("select puballtables as all from pg_publication where pubname = 'powersync'");
  expect(pub.rows).toEqual([{ all: true }]);
  return [...(await docker.containers([`label=${PROJECT_LABEL}=${PROJECT}`])), ...roles.rows.map((r) => r.name), ...slots.rows.map((r) => r.name)];
}

describe("auto-start on the demo", () => {
  it("serves the sync config, and removes everything on Ctrl+C or SIGTERM", async () => {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const { child, url } = await startChild();
      expect((await fetch(`${url}/probes/readiness`)).ok).toBe(true);
      expect((await leftovers()).length).toBeGreaterThan(0);
      const exit = exited(child);
      child.kill(signal);
      expect(await exit, signal).toBe(code);
      expect(await leftovers(), signal).toEqual([]);
    }
  }, 240_000);

  it("refuses a second run while one is going, leaving the first untouched", async () => {
    const first = await startChild();
    await expect(startChild()).rejects.toThrow(/another samesight-verify audit is running PowerSync on this database/);
    expect((await fetch(`${first.url}/probes/readiness`)).ok).toBe(true);
    const exit = exited(first.child);
    first.child.kill("SIGINT");
    expect(await exit).toBe(130);
    expect(await leftovers()).toEqual([]);
  }, 240_000);

  it("leaves a run killed outright for the next one's sweep", async () => {
    const { child } = await startChild();
    const exit = exited(child);
    child.kill("SIGKILL");
    await exit;
    expect((await leftovers()).length).toBeGreaterThan(0);
    // Its PowerSync held the role's session; with the container gone, the sweep takes the rest.
    expect((await sweep(docker, client, PROJECT)).length).toBeGreaterThan(0);
    expect(await leftovers()).toEqual([]);
  }, 120_000);

  it("keeps the service with keep, reuses it for the same config, and sweeps it otherwise", async () => {
    const first = await startChild(true);
    const firstExit = exited(first.child);
    first.child.kill("SIGINT");
    await firstExit;
    const kept = await leftovers();
    expect(kept.length).toBeGreaterThan(0);
    expect((await fetch(`${first.url}/probes/readiness`)).ok).toBe(true);
    // The same config: reused, and removed at the end of a run that does not keep it.
    const second = await startChild(false);
    expect(second.url).toBe(first.url);
    const secondExit = exited(second.child);
    second.child.kill("SIGINT");
    await secondExit;
    expect(await leftovers()).toEqual([]);
  }, 240_000);
});
