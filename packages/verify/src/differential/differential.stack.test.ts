/**
 * The differential against the running stack (Supabase and PowerSync).
 * One setup for the file: each user signs in once, and Auth allows 30 sign-ins per five
 * minutes. Every breakage is planted inside a transaction that is rolled back.
 */

import fc from "fast-check";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLocal, rows } from "../db.ts";
import { FIELDBOOK, ir } from "../fixtures/fieldbook.ts";
import { readStack } from "../stack.ts";
import { compareAll, describeFailures, differential, PREFIX, type Setup, setUp, syncAll, tearDown, withWorld } from "./run.ts";
import { EMAIL_DOMAIN } from "./users.ts";
import { worldArbitrary } from "./world.ts";

let client: pg.Client;
let s: Setup;
beforeAll(async () => {
  const stack = readStack(FIELDBOOK, process.env.SAMESIGHT_POWERSYNC_URL ?? "http://127.0.0.1:8080");
  client = await connectLocal(stack.db);
  s = await setUp(client, stack, ir);
}, 120_000);
afterAll(async () => {
  if (s) await tearDown(s);
  await client?.end();
});

const world = () => fc.sample(worldArbitrary(s.tables, { minRows: 4, maxRows: 10 }), { numRuns: 1, seed: 11 })[0] ?? {};

describe("the differential on Fieldbook", () => {
  it("finds devices and RLS in agreement", async () => {
    const r = await differential(s, { runs: 2, seed: 5, timeLimitMs: 90_000 });
    expect(r.findings).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(r.runs).toBeGreaterThan(0);
  }, 180_000);

  it("reports a narrowed read policy in plain words, both ways", async () => {
    const lines = await withWorld(s, world(), async () => {
      const devices = await syncAll(s);
      const failures = await compareAll(s, {
        devices,
        prepare: async (c) => {
          await c.query(`alter policy "Site: read" on public."Site" using (false)`);
        },
      });
      return describeFailures(s, failures);
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/^u\d \(\w+ of tenant [AB]\) received Site [0-9a-f-]{36} \(tenant [AB]\) \(stream \w+\); RLS returns no such row for this user\.$/);
  }, 120_000);
});

describe("tearDown", () => {
  it("leaves no verifier rows or users behind", async () => {
    await tearDown(s);
    const [{ n } = { n: -1 }] = await rows<{ n: number }>(
      client,
      `select (select count(*) from public."Tenant" where id::text like $1) + (select count(*) from auth.users where email like $2) as n`,
      [`${PREFIX}%`, `%@${EMAIL_DOMAIN}`],
    );
    expect(Number(n)).toBe(0);
  });
});
