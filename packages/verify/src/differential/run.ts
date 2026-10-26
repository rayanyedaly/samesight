/**
 * The differential test. For each user of the run: sync a fresh headless device, read the
 * same tables through RLS with the same token's claims, and compare. fast-check generates
 * the rows; a failing world is shrunk to the fewest rows that still fail, and reported in
 * plain words.
 */

import fc from "fast-check";
import type pg from "pg";
import { type IR, ident } from "samesight/compiler";
import { rows } from "../db.ts";
import type { Finding } from "../report.ts";
import type { Stack } from "../stack.ts";
import { compare, type Problem } from "./compare.ts";
import { syncOnce } from "./device.ts";
import { insertOrder, readModel, type TableModel } from "./model.ts";
import { readAsUsers } from "./rls.ts";
import { createUsers, deleteUser, leftoverUsers, type Session, signIn } from "./users.ts";
import { deleteRows, type Fixed, generatedTables, type Inserted, insertWorld, type Member, prefixedUuid, sampleValue, type World, worldArbitrary } from "./world.ts";

/** Every row the verifier writes has an id starting with this. */
export const PREFIX = "5a3e5a3e";
const TENANTS = 3;
/** Tenants with users; the last tenant only holds rows nobody in the run may see. */
const STAFFED = 2;

export interface Setup {
  client: pg.Client;
  stack: Stack;
  ir: IR;
  model: TableModel[];
  /** The tables fast-check fills, in insert order. */
  tables: TableModel[];
  fixed: Fixed;
  sessions: Map<string, Session>;
  /** Every run user's password, to sign in again before a token expires. */
  password: string;
  synced: string[];
}

export interface UserProblems {
  user: Member;
  problems: Problem[];
}

/** Removes everything an earlier run may have left: its rows, then its users. */
export async function cleanup(client: pg.Client, stack: Stack, model: TableModel[]): Promise<void> {
  await deleteRows(client, insertOrder(model), PREFIX);
  for (const id of await leftoverUsers(client)) await deleteUser(stack, id);
}

const letter = (i: number) => String.fromCharCode(65 + i);

/** Held for the run: runs share one prefix and one email domain, so a second would delete the first's data. */
const LOCK = Number.parseInt(PREFIX, 16);

export async function setUp(client: pg.Client, stack: Stack, ir: IR): Promise<Setup> {
  const [{ locked } = { locked: false }] = await rows<{ locked: boolean }>(client, "select pg_try_advisory_lock($1) as locked", [LOCK]);
  if (!locked) throw new Error("another samesight verify run is using this database; wait for it to finish");
  try {
    return await prepareRun(client, stack, ir);
  } catch (e) {
    // Users, tenants and memberships made before the failure: removed now, not by the next run.
    const model = insertOrder(await readModel(client, ir).catch(() => []));
    await cleanup(client, stack, model).catch(() => {});
    await client.query("select pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    throw e;
  }
}

async function prepareRun(client: pg.Client, stack: Stack, ir: IR): Promise<Setup> {
  const model = insertOrder(await readModel(client, ir));
  await cleanup(client, stack, model);
  const tenants = Array.from({ length: TENANTS }, () => prefixedUuid(PREFIX));
  const plan: { tenant: number | null; role: string | null }[] = [];
  for (let t = 0; t < STAFFED; t++) for (const role of ir.claims.roles) plan.push({ tenant: t, role });
  // A second user of one role in tenant A (rows that belong to someone else), and a user with no membership.
  plan.push({ tenant: 0, role: ir.claims.roles[1] ?? ir.claims.roles[0] ?? null }, { tenant: null, role: null });

  const runId = PREFIX.slice(0, 4) + Date.now().toString(36);
  const { users, password } = await createUsers(stack, plan.length, runId);
  const members: Member[] = users.map((u, i) => {
    const p = plan[i] ?? { tenant: null, role: null };
    const tenant = p.tenant === null ? null : (tenants[p.tenant] ?? null);
    return {
      ...u,
      tenant,
      role: p.role,
      label: p.tenant === null ? `u${i} (no membership)` : `u${i} (${p.role} of tenant ${letter(p.tenant)})`,
    };
  });

  const fill = (t: TableModel | undefined, row: Record<string, unknown>, seed: number) => {
    for (const c of t?.columns ?? []) {
      if (row[c.name] !== undefined || c.computed || c.hasDefault || c.nullable) continue;
      row[c.name] = sampleValue(c, seed);
    }
    return row;
  };
  await client.query("begin");
  try {
    if (ir.tenantTable) {
      const t = model.find((m) => m.name === ir.tenantTable);
      for (const [i, id] of tenants.entries()) await insertRow(client, ir.tenantTable, fill(t, { id }, i));
    }
    const m = ir.membership;
    const mt = model.find((x) => x.name === m.table);
    for (const [i, u] of members.entries()) {
      if (!u.tenant) continue;
      const row: Record<string, unknown> = { [m.user]: u.id, [m.tenant]: u.tenant, [m.role]: u.role };
      if (mt?.primaryKey.length === 1 && mt.columns.find((c) => c.name === mt.primaryKey[0])?.type === "uuid") {
        row[mt.primaryKey[0] as string] = prefixedUuid(PREFIX);
      }
      await insertRow(client, m.table, fill(mt, row, 100 + i));
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }

  const sessions = new Map<string, Session>();
  for (const u of members) sessions.set(u.id, await signIn(stack, u.email, password));
  for (const u of members) {
    const claims = sessions.get(u.id)?.claims ?? {};
    const tenantClaim = claims[ir.claims.tenant] ?? null;
    if (tenantClaim !== u.tenant || (claims[ir.claims.role] ?? null) !== u.role) {
      throw new Error(
        `the access token hook gave ${u.label} ${ir.claims.tenant}=${JSON.stringify(tenantClaim)} and ${ir.claims.role}=${JSON.stringify(claims[ir.claims.role] ?? null)}; ` +
          `expected ${JSON.stringify(u.tenant)} and ${JSON.stringify(u.role)}. Is the hook enabled in supabase/config.toml?`,
      );
    }
  }
  const skip = [ir.tenantTable ?? "", ir.membership.table];
  return {
    client,
    stack,
    ir,
    model,
    tables: generatedTables(model, skip),
    fixed: { prefix: PREFIX, tenants, users: members },
    sessions,
    password,
    synced: ir.tables.filter((t) => t.read.size > 0).map((t) => t.name),
  };
}

async function insertRow(client: pg.Client, table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await client.query(
    `insert into public.${ident(table)} (${cols.map(ident).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => row[c]),
  );
}

/** Waits until PowerSync's replication slot has confirmed everything written so far. */
export async function waitForReplication(client: pg.Client, timeoutMs = 60_000): Promise<void> {
  const [{ lsn } = { lsn: "" }] = await rows<{ lsn: string }>(client, "select pg_current_wal_lsn()::text as lsn");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const slots = await rows<{ name: string; caught_up: boolean }>(
      client,
      `select slot_name as name, coalesce(confirmed_flush_lsn >= $1::pg_lsn, false) as caught_up
         from pg_replication_slots where slot_type = 'logical' and slot_name like 'powersync%'`,
      [lsn],
    );
    if (slots.length && slots.every((s) => s.caught_up)) return;
    if (Date.now() > deadline) {
      throw new Error(slots.length ? `PowerSync has not replicated up to ${lsn} after ${timeoutMs / 1000}s` : "PowerSync has no replication slot; is the service running?");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The tables and columns a user's devices must not hold, by the user's role. */
function hiddenFor(ir: IR, role: string | null): Map<string, string[]> {
  return new Map(ir.tables.map((t) => [t.name, role ? (t.hide.get(role) ?? []) : []]));
}

export interface IterationOptions {
  /** Runs in each RLS read's transaction before the role switch (the RLS mutants). */
  prepare?: (client: pg.Client) => Promise<void>;
  /** Users to read through RLS only, reusing devices from `devices`. */
  devices?: Map<string, Awaited<ReturnType<typeof syncOnce>>>;
  /** Counts, per table, the (user, row) pairs RLS returned and the comparison covered. */
  tally?: Map<string, number>;
}

/** Syncs every user's device once, for the current data. */
export async function syncAll(s: Setup): Promise<Map<string, Awaited<ReturnType<typeof syncOnce>>>> {
  const out = new Map<string, Awaited<ReturnType<typeof syncOnce>>>();
  await Promise.all(
    s.fixed.users.map(async (u) => {
      let session = s.sessions.get(u.id);
      if (!session) throw new Error(`${u.label} is not signed in`);
      // PowerSync refuses an expired token; RLS reads only its claims and would not notice.
      if (session.expiresAt - Date.now() < 120_000) {
        session = await signIn(s.stack, u.email, s.password);
        s.sessions.set(u.id, session);
      }
      out.set(u.id, await syncOnce(s.stack.powersync, session.token));
    }),
  );
  return out;
}

/** Compares every user's device with what RLS returns them, for the data in the database now. */
export async function compareAll(s: Setup, options: IterationOptions = {}): Promise<UserProblems[]> {
  const devices = options.devices ?? (await syncAll(s));
  const out: UserProblems[] = [];
  const readers = s.fixed.users.map((u) => s.sessions.get(u.id)?.claims ?? {});
  const seen = await readAsUsers(s.client, readers, s.synced, options.prepare);
  if (options.tally) {
    for (const rs of seen) for (const key of rs.keys()) {
      const table = key.slice(0, key.indexOf("\u0000"));
      options.tally.set(table, (options.tally.get(table) ?? 0) + 1);
    }
  }
  for (const [i, u] of s.fixed.users.entries()) {
    const problems = compare(devices.get(u.id) ?? [], seen[i] ?? new Map(), hiddenFor(s.ir, u.role), s.model);
    if (problems.length) out.push({ user: u, problems });
  }
  return out;
}

/** Writes a world, waits for PowerSync, runs `fn`, and always removes the world's rows. */
export async function withWorld<T>(s: Setup, world: World, fn: (inserted: Inserted[]) => Promise<T>): Promise<T> {
  await s.client.query("begin");
  let inserted: Inserted[];
  try {
    inserted = await insertWorld(s.client, s.tables, world, s.fixed);
    await s.client.query("commit");
  } catch (e) {
    await s.client.query("rollback").catch(() => {});
    throw e;
  }
  try {
    await waitForReplication(s.client);
    return await fn(inserted);
  } finally {
    await deleteRows(s.client, s.tables, PREFIX);
  }
}

export interface DifferentialResult {
  findings: Finding[];
  runs: number;
  /** The shrunk failing world's problems, in plain words. */
  counterexample?: string[];
}

export async function differential(s: Setup, options: { runs: number; seed?: number; timeLimitMs: number }): Promise<DifferentialResult> {
  const check = "differential";
  let runs = 0;
  // What the run actually compared: a dataset whose rows all fail to insert, or that nobody
  // may read, would agree on both sides and prove nothing.
  const inserted = new Map<string, number>();
  const visible = new Map<string, number>();
  const property = fc.asyncProperty(worldArbitrary(s.tables), async (world) => {
    runs++;
    const failures = await withWorld(s, world, (rowsIn) => {
      for (const r of rowsIn) inserted.set(r.table, (inserted.get(r.table) ?? 0) + 1);
      return compareAll(s, { tally: visible });
    });
    return failures.length === 0;
  });
  const result = await fc.check(property, {
    numRuns: options.runs,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    interruptAfterTimeLimit: options.timeLimitMs,
    markInterruptAsFailure: false,
  });
  if (result.failed && result.counterexample && !result.errorInstance) {
    const [world] = result.counterexample;
    const failures = await withWorld(s, world, () => compareAll(s));
    const counterexample = describeFailures(s, failures);
    if (!counterexample.length) {
      return { runs, findings: [{ status: "fail", check, detail: `a dataset failed (seed ${result.seed}) but passed when run again: devices may not have caught up` }] };
    }
    return {
      runs,
      counterexample,
      findings: [
        {
          status: "fail",
          check,
          detail: `devices and RLS disagree (seed ${result.seed}, shrunk ${result.numShrinks} times to ${countRows(world)} rows):\n${counterexample.map((l) => `    ${l}`).join("\n")}`,
        },
      ],
    };
  }
  if (result.failed) return { runs, findings: [{ status: "fail", check, detail: `the run failed: ${String(result.errorInstance ?? "interrupted or too many skips")}` }] };
  if (result.numRuns === 0) return { runs, findings: [{ status: "fail", check, detail: "no dataset was tested before the time limit" }] };
  const untested = s.tables
    .filter((t) => s.synced.includes(t.name))
    .flatMap((t) => (!inserted.get(t.name) ? [`no ${t.name} row could be inserted`] : !visible.get(t.name) ? [`no user could read any ${t.name} row`] : []));
  if (untested.length) {
    return { runs, findings: [{ status: "fail", check, detail: `${result.numRuns} datasets left tables untested: ${untested.join("; ")}` }] };
  }
  const users = s.fixed.users.length;
  return {
    runs,
    findings: [
      {
        status: "ok",
        check,
        detail: `${result.numRuns} generated datasets (${[...inserted.values()].reduce((a, b) => a + b, 0)} rows; ${[...visible.values()].reduce((a, b) => a + b, 0)} row reads compared), ${users} users each: every synced row is one RLS returns, with no hidden column, and every row RLS returns was synced${result.interrupted ? " (stopped at the time limit)" : ""}`,
      },
    ],
  };
}

const countRows = (world: World) => Object.values(world).reduce((n, rs) => n + rs.length, 0);

/** "Inspection 5a3e5a3e-… (tenant B, assigneeId u3, status DRAFT)" */
function describeRow(s: Setup, table: string, id: string, row: Record<string, unknown>): string {
  const t = s.model.find((m) => m.name === table);
  const parts: string[] = [];
  const tenant = row[t?.tenant ?? ""];
  const ti = s.fixed.tenants.indexOf(String(tenant));
  if (tenant !== undefined) parts.push(ti >= 0 ? `tenant ${letter(ti)}` : `tenant ${String(tenant).slice(0, 8)} (outside the run)`);
  for (const c of t?.columns ?? []) {
    if (c.name === t?.tenant || c.name === "id") continue;
    const v = row[c.name];
    const user = s.fixed.users.find((u) => u.id === v);
    if (user) parts.push(`${c.name} ${user.label.split(" ")[0]}`);
    else if ((c.values?.length || c.hints.length) && v !== undefined) parts.push(`${c.name} ${v === null ? "null" : String(v)}`);
  }
  return `${table} ${id}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

export function describeFailures(s: Setup, failures: UserProblems[]): string[] {
  const out: string[] = [];
  for (const { user, problems } of failures) {
    for (const p of problems) {
      const row = describeRow(s, p.table, p.id, p.row);
      const via = p.streams.length ? ` (stream ${p.streams.join(", ")})` : "";
      if (p.kind === "leak") out.push(`${user.label} received ${row}${via}; RLS returns no such row for this user.`);
      else if (p.kind === "hidden") out.push(`${user.label} received ${row} with ${p.columns?.join(", ")}${via}, which the policy hides from ${user.role}.`);
      else if (p.kind === "gap") out.push(`RLS lets ${user.label} read ${row}, but no stream sent it.`);
      else out.push(`${user.label}'s copy of ${row} differs from the database in ${p.columns?.join(", ")}${via}.`);
    }
  }
  return out;
}

export async function tearDown(s: Setup): Promise<void> {
  try {
    await cleanup(s.client, s.stack, s.model);
  } finally {
    await s.client.query("select pg_advisory_unlock($1)", [LOCK]).catch(() => {});
  }
}
