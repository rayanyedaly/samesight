/**
 * Auto-start on PowerSync's to-do list demo (pnpm --filter audit-todolist stack:up, or
 * just its Supabase stack): a run stopped by Ctrl+C or SIGTERM leaves nothing behind, and
 * one killed outright is swept by the next.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
beforeAll(async () => {
  client = await connectLocal(readStack(DEMO, "http://127.0.0.1:1").db);
});
afterAll(async () => {
  await client?.end();
});

/** Starts the child and resolves with it and its PowerSync URL once it prints READY. */
function startChild(): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [CHILD], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
  });
  return new Promise((resolve, reject) => {
    child.stdout?.on("data", (d: Buffer) => {
      const m = /READY (\S+)/.exec(d.toString());
      if (m?.[1]) resolve({ child, url: m[1] });
    });
    child.on("exit", (code) => reject(new Error(`the child exited (${code}) before it was ready:\n${err}`)));
  });
}

const exited = (child: ChildProcess) => new Promise<number | null>((r) => child.on("exit", (code) => r(code)));

/** What a run leaves: the project's labelled containers, samesight_audit_ roles and slots. */
async function leftovers(): Promise<string[]> {
  const roles = await client.query<{ name: string }>("select rolname as name from pg_roles where starts_with(rolname, 'samesight_audit_')");
  const slots = await client.query<{ name: string }>("select slot_name as name from pg_replication_slots where starts_with(slot_name, 'samesight_audit_')");
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
});
