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
import { insertOrder, policyTables, readModel, type ScopeTable, type TableModel } from "./model.ts";
import { readAsUsers } from "./rls.ts";
import { createUsers, deleteUser, leftoverUsers, type Session, signIn } from "./users.ts";
import {
  deleteRows,
  type Fixed,
  generatedTables,
  type Inserted,
  insertWorld,
  lastInsertError,
  type Member,
  prefixedUuid,
  sampleValue,
  type World,
  worldArbitrary,
} from "./world.ts";

/** Every row the verifier writes has an id starting with this. */
export const PREFIX = "5a3e5a3e";
const TENANTS = 3;
/** Tenants with users; the last tenant only holds rows nobody in the run may see. */
const STAFFED = 2;

/** What every run has, with or without a Samesight policy. */
export interface Run {
  client: pg.Client;
  stack: Stack;
  model: TableModel[];
  /** The tables fast-check fills, in insert order. */
  tables: TableModel[];
  fixed: Fixed;
  sessions: Map<string, Session>;
  /** Every run user's password, to sign in again before a token expires. */
  password: string;
  /** The tables read through RLS and compared with the devices. */
  synced: string[];
  /** Per table, the columns this user's devices must not hold. */
  hidden: (user: Member) => Map<string, string[]>;
  /**
   * A row (or a column of one) RLS allows that no device received: a failure where a policy
   * says what syncs, a warning in an audit, where sync may be meant to send less than RLS allows.
   */
  gaps: "fail" | "warn";
}

/** A run under a Samesight policy: tenants, a user per role, the policy's hidden columns. */
export interface Setup extends Run {
  ir: IR;
}

export interface UserProblems {
  user: Member;
  problems: Problem[];
}

/** Removes everything an earlier run may have left: its rows, then its users. */
export async function cleanup(client: pg.Client, stack: Stack, model: TableModel[]): Promise<void> {
  const users = await leftoverUsers(client);
  const rowsDeleted = await deleteRows(client, insertOrder(model), PREFIX, users).then(
    () => undefined,
    (e: unknown) => e,
  );
  // Every user is tried, whatever happened to the rows; a row outside the run's tables that
  // still points at one can block its delete.
  const failed: string[] = [];
  for (const id of users) await deleteUser(stack, id).catch((e: Error) => failed.push(`${id}: ${e.message}`));
  if (rowsDeleted !== undefined) throw rowsDeleted;
  if (failed.length) throw new Error(`could not delete ${failed.length} earlier run users (a row outside the audited tables may still reference them): ${failed.join("; ")}`);
}

const letter = (i: number) => String.fromCharCode(65 + i);

/** Held for the run: runs share one prefix and one email domain, so a second would delete the first's data. */
const LOCK = Number.parseInt(PREFIX, 16);

export async function setUp(client: pg.Client, stack: Stack, ir: IR): Promise<Setup> {
  return exclusive(client, stack, policyTables(ir), () => prepareRun(client, stack, ir));
}

/** Users a run without a policy signs up. */
export const AUDIT_USERS = 4;

/**
 * A run without a policy (audit mode): plain signed-up users, no tenants, roles or token
 * hook. Rows belong to users through their foreign keys to auth.users, and what a device
 * may hold is whatever RLS lets its user read.
 */
export async function setUpUsers(client: pg.Client, stack: Stack, scope: { tables: ScopeTable[]; synced: string[] }, count = AUDIT_USERS): Promise<Run> {
  return exclusive(client, stack, scope.tables, async () => {
    const model = insertOrder(await readModel(client, scope.tables));
    // Without tenants, the run finds its rows again only by the prefix it gives uuid keys.
    const refused = auditRefusals(model, scope.synced);
    if (refused.length) throw new Error(`audit mode cannot run on these tables: ${refused.join("; ")}`);
    await cleanup(client, stack, model);
    const { users, password } = await createUsers(stack, count, PREFIX.slice(0, 4) + Date.now().toString(36));
    const members: Member[] = users.map((u, i) => ({ ...u, tenant: null, role: null, label: `u${i}` }));
    const sessions = new Map<string, Session>();
    for (const u of members) sessions.set(u.id, await signIn(stack, u.email, password));
    return {
      client,
      stack,
      model,
      tables: generatedTables(model, []),
      fixed: { prefix: PREFIX, tenants: [], users: members },
      sessions,
      password,
      synced: scope.synced,
      hidden: () => new Map(),
      gaps: "warn",
    };
  });
}

/**
 * Why audit mode cannot generate or compare a table, if it cannot. Without tenants, the run
 * finds its rows again only by the prefix it gives a uuid key, so every table needs one
 * uuid key column of its own (not a foreign key, as profiles.id referencing auth.users is);
 * and devices and RLS reads are matched by `id`, which every synced table must have.
 */
export function auditRefusals(model: TableModel[], synced: string[]): string[] {
  return model.flatMap((t) => {
    const [key] = t.primaryKey;
    const out: string[] = [];
    if (t.primaryKey.length !== 1 || !key || t.columns.find((c) => c.name === key)?.type !== "uuid") {
      out.push(`${t.name} is not keyed by one uuid column (${t.primaryKey.join(", ")})`);
    } else if (t.foreignKeys.some((fk) => fk.columns.includes(key))) out.push(`${t.name}.${key} is a foreign key, so the run cannot give it a value`);
    if (synced.includes(t.name) && !t.columns.some((c) => c.name === "id")) out.push(`${t.name} has no id column to match device rows by`);
    return out;
  });
}

/** Holds the run's lock while `prepare` sets the run up; on failure, removes what it made and lets go. */
async function exclusive<T extends Run>(client: pg.Client, stack: Stack, tables: ScopeTable[], prepare: () => Promise<T>): Promise<T> {
  const [{ locked } = { locked: false }] = await rows<{ locked: boolean }>(client, "select pg_try_advisory_lock($1) as locked", [LOCK]);
  if (!locked) throw new Error("another samesight verify run is using this database; wait for it to finish");
  try {
    return await prepare();
  } catch (e) {
    // Users, tenants and memberships made before the failure: removed now, not by the next run.
    const model = insertOrder(await readModel(client, tables).catch(() => []));
    await cleanup(client, stack, model).catch(() => {});
    await client.query("select pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    throw e;
  }
}

async function prepareRun(client: pg.Client, stack: Stack, ir: IR): Promise<Setup> {
  const model = insertOrder(await readModel(client, policyTables(ir)));
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
    hidden: (u) => hiddenFor(ir, u.role),
    gaps: "fail",
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
  /** Counts, per table, the rows devices received. */
  received?: Map<string, number>;
}

/** Syncs every user's device once, for the current data. */
export async function syncAll(s: Run): Promise<Map<string, Awaited<ReturnType<typeof syncOnce>>>> {
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
export async function compareAll(s: Run, options: IterationOptions = {}): Promise<UserProblems[]> {
  const devices = options.devices ?? (await syncAll(s));
  const out: UserProblems[] = [];
  const readers = s.fixed.users.map((u) => s.sessions.get(u.id)?.claims ?? {});
  const seen = await readAsUsers(s.client, readers, s.synced, options.prepare);
  // Only the run's own rows count as tested: rows already in the database say nothing about the generated ones.
  const ours = (table: string, id: string) => {
    const t = s.model.find((m) => m.name === table);
    const key = t?.columns.find((c) => c.name === t.primaryKey[0]);
    return key?.type !== "uuid" || id.startsWith(s.fixed.prefix);
  };
  if (options.tally) {
    for (const rs of seen) for (const key of rs.keys()) {
      const cut = key.indexOf("\u0000");
      const table = key.slice(0, cut);
      if (ours(table, key.slice(cut + 1))) options.tally.set(table, (options.tally.get(table) ?? 0) + 1);
    }
  }
  if (options.received) {
    for (const rows of devices.values()) for (const r of rows) if (ours(r.table, r.id)) options.received.set(r.table, (options.received.get(r.table) ?? 0) + 1);
  }
  for (const [i, u] of s.fixed.users.entries()) {
    const problems = compare(devices.get(u.id) ?? [], seen[i] ?? new Map(), s.hidden(u), s.model);
    if (problems.length) out.push({ user: u, problems });
  }
  return out;
}

/** Writes a world, waits for PowerSync, runs `fn`, and always removes the world's rows. */
export async function withWorld<T>(s: Run, world: World, fn: (inserted: Inserted[]) => Promise<T>): Promise<T> {
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
    await deleteRows(
      s.client,
      s.tables,
      PREFIX,
      s.fixed.users.map((u) => u.id),
    );
  }
}

export interface DifferentialResult {
  findings: Finding[];
  /** Datasets tried before the first failure; shrinking runs are not counted. */
  runs: number;
  /** The shrunk failing world's problems, in plain words. */
  counterexample?: string[];
}

/** Problems a run fails on, and those it only warns about: in an audit, sync may be meant to send less than RLS allows. */
export function splitProblems(all: UserProblems[], gaps: Run["gaps"]): { failing: UserProblems[]; narrower: UserProblems[] } {
  if (gaps === "fail") return { failing: all, narrower: [] };
  const isNarrower = (p: Problem) => p.kind === "gap" || p.kind === "unsent";
  const pick = (keep: (p: Problem) => boolean) => all.map((u) => ({ user: u.user, problems: u.problems.filter(keep) })).filter((u) => u.problems.length);
  return { failing: pick((p) => !isNarrower(p)), narrower: pick(isNarrower) };
}

export interface Exploration<W> {
  /** Worlds tried before the first failure; shrinking runs are not counted. */
  datasets: number;
  /** The time limit ended the run (or its shrinking). */
  stopped: boolean;
  /** What a run threw, if one did; no run starts after it. */
  crash: unknown;
  /** The smallest world seen failing, shrinking included. */
  lastFailing: W | undefined;
  seed: number;
  numShrinks: number;
}

/**
 * Runs `evaluate` (true: the world passes) on generated worlds, then shrinks a failing one.
 * The time limit is checked here, before each run, never by racing a run: fast-check's
 * interruptAfterTimeLimit leaves the losing run going, still writing to the database the
 * next step uses. Past the limit, or after a crash, every run passes at once, which also
 * ends shrinking at the smallest failure so far. Nothing is left running when it returns.
 */
export async function explore<W>(
  arbitrary: fc.Arbitrary<W>,
  evaluate: (world: W) => Promise<boolean>,
  options: { runs: number; seed?: number; timeLimitMs: number },
): Promise<Exploration<W>> {
  const deadline = Date.now() + options.timeLimitMs;
  const out: Exploration<W> = { datasets: 0, stopped: false, crash: undefined, lastFailing: undefined, seed: 0, numShrinks: 0 };
  let failedOnce = false;
  const property = fc.asyncProperty(arbitrary, async (world) => {
    if (out.crash !== undefined) return true;
    if (Date.now() > deadline) {
      out.stopped = true;
      return true;
    }
    if (!failedOnce) out.datasets++;
    try {
      const ok = await evaluate(world);
      failedOnce ||= !ok;
      if (!ok) out.lastFailing = world;
      return ok;
    } catch (e) {
      out.crash = e ?? new Error("a run threw without an error");
      return true;
    }
  });
  const result = await fc.check(property, { numRuns: options.runs, ...(options.seed !== undefined ? { seed: options.seed } : {}) });
  out.seed = result.seed;
  out.numShrinks = result.numShrinks;
  // Every failure goes through lastFailing; anything else fast-check reports is its own error.
  if (result.failed && !out.lastFailing && out.crash === undefined) out.crash = result.errorInstance ?? new Error("fast-check stopped: too many skipped runs");
  return out;
}

export async function differential(s: Run, options: { runs: number; seed?: number; timeLimitMs: number }): Promise<DifferentialResult> {
  const check = "differential";
  lastInsertError.clear();
  // What the run actually compared: a dataset whose rows all fail to insert, that nobody may
  // read, or that no device receives would agree (or only warn) on both sides and prove nothing.
  const inserted = new Map<string, number>();
  const visible = new Map<string, number>();
  const received = new Map<string, number>();
  // Gaps that are only warnings (audit mode): one example per kind of gap, ids aside.
  const gaps = new Map<string, string>();
  const failing = (all: UserProblems[]): UserProblems[] => {
    const split = splitProblems(all, s.gaps);
    for (const line of describeFailures(s, split.narrower)) {
      const key = line.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "…");
      if (!gaps.has(key)) gaps.set(key, line);
    }
    return split.failing;
  };
  const withGaps = (findings: Finding[]): Finding[] => {
    if (!gaps.size) return findings;
    const shown = [...gaps.values()].slice(0, 5);
    const more = gaps.size > shown.length ? `\n    and ${gaps.size - shown.length} more` : "";
    return [
      ...findings,
      {
        status: "warn",
        check,
        detail: `RLS lets users read rows no stream sends them (sync is narrower than RLS: fine if intended, but RLS alone guards the REST API), for example:\n${shown.map((l) => `    ${l}`).join("\n")}${more}`,
      },
    ];
  };
  const fail = (detail: string, runs: number) => ({ runs, findings: withGaps([{ status: "fail" as const, check, detail }]) });

  const x = await explore(
    worldArbitrary(s.tables),
    async (world) => {
      const failures = await withWorld(s, world, (rowsIn) => {
        for (const r of rowsIn) inserted.set(r.table, (inserted.get(r.table) ?? 0) + 1);
        return compareAll(s, { tally: visible, received });
      });
      return failing(failures).length === 0;
    },
    options,
  );
  const crashed = x.crash === undefined ? "" : ` (then a run failed: ${String(x.crash)})`;
  if (x.lastFailing) {
    const world = x.lastFailing;
    const counterexample = describeFailures(s, failing(await withWorld(s, world, () => compareAll(s))));
    if (!counterexample.length) return fail(`a dataset failed (seed ${x.seed}) but passed when run again: devices may not have caught up${crashed}`, x.datasets);
    return {
      runs: x.datasets,
      counterexample,
      findings: withGaps([
        {
          status: "fail",
          check,
          detail: `devices and RLS disagree (seed ${x.seed}, shrunk ${x.numShrinks} times to ${countRows(world)} rows${x.stopped ? "; shrinking stopped at the time limit" : ""}${crashed}):\n${counterexample.map((l) => `    ${l}`).join("\n")}`,
        },
      ]),
    };
  }
  if (x.crash !== undefined) return fail(`the run failed: ${String(x.crash)}`, x.datasets);
  if (x.datasets === 0) return { runs: 0, findings: [{ status: "fail", check, detail: "no dataset was tested before the time limit" }] };
  const untested = s.tables
    .filter((t) => s.synced.includes(t.name))
    .flatMap((t) =>
      !inserted.get(t.name)
        ? [`no ${t.name} row could be inserted${lastInsertError.has(t.name) ? ` (the database said: ${lastInsertError.get(t.name)})` : ""}`]
        : !visible.get(t.name)
          ? [`no user could read any ${t.name} row`]
          : !received.get(t.name)
            ? [`no device received any ${t.name} row (is PowerSync serving this sync config?)`]
            : [],
    );
  if (untested.length) return fail(`${x.datasets} datasets left tables untested: ${untested.join("; ")}`, x.datasets);
  const users = s.fixed.users.length;
  const complete = s.gaps === "fail" ? ", and every row RLS returns was synced" : "";
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    runs: x.datasets,
    findings: withGaps([
      {
        status: "ok",
        check,
        detail: `${x.datasets} generated datasets (${sum(inserted)} rows; ${sum(visible)} row reads compared), ${users} users each: every synced row is one RLS returns, with no hidden column${complete}${x.stopped ? " (stopped at the time limit)" : ""}`,
      },
    ]),
  };
}

const countRows = (world: World) => Object.values(world).reduce((n, rs) => n + rs.length, 0);

/** "Inspection 5a3e5a3e-… (tenant B, assigneeId u3, status DRAFT)" */
function describeRow(s: Run, table: string, id: string, row: Record<string, unknown>): string {
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

export function describeFailures(s: Run, failures: UserProblems[]): string[] {
  const out: string[] = [];
  for (const { user, problems } of failures) {
    for (const p of problems) {
      const row = describeRow(s, p.table, p.id, p.row);
      const via = p.streams.length ? ` (stream ${p.streams.join(", ")})` : "";
      if (p.kind === "leak") out.push(`${user.label} received ${row}${via}; RLS returns no such row for this user.`);
      else if (p.kind === "hidden") out.push(`${user.label} received ${row} with ${p.columns?.join(", ")}${via}, which the policy hides from ${user.role}.`);
      else if (p.kind === "gap") out.push(`RLS lets ${user.label} read ${row}, but no stream sent it.`);
      else if (p.kind === "unsent") out.push(`${user.label}'s copy of ${row} lacks ${p.columns?.join(", ")}, which RLS lets them read${via}.`);
      else out.push(`${user.label}'s copy of ${row} differs from the database in ${p.columns?.join(", ")}${via}.`);
    }
  }
  return out;
}

export async function tearDown(s: Run): Promise<void> {
  try {
    await cleanup(s.client, s.stack, s.model);
  } finally {
    await s.client.query("select pg_advisory_unlock($1)", [LOCK]).catch(() => {});
  }
}
