/**
 * The differential test. For each user of the run: sync a fresh headless device, read the
 * same tables through RLS with the same token's claims, and compare. fast-check generates
 * the rows; a failing world is shrunk to the fewest rows that still fail, and reported in
 * plain words.
 */

import fc from "fast-check";
import type pg from "pg";
import { type IR, ident, type Stream } from "samesight/compiler";
import { leftForNext, type Mode } from "../autostart/teardown.ts";
import { connectLocal, rows } from "../db.ts";
import { type Finding, formatRows, type RowReport, rowSentence } from "../report.ts";
import type { Stack } from "../stack.ts";
import { show } from "../audit/assign.ts";
import { claimKey } from "../audit/claims.ts";
import { type Coverage, measure, pending } from "../audit/coverage.ts";
import { sendingQueries } from "./attribute.ts";
import { likelyFixes } from "./fix.ts";
import { policyVerdicts } from "./policies.ts";
import { compare, type Problem } from "./compare.ts";
import { syncOnce } from "./device.ts";
import { insertOrder, policyTables, readModel, type ScopeTable, type TableModel } from "./model.ts";
import { readAsUsers } from "./rls.ts";
import { createUsers, deleteUser, leftoverUsers, type Session, signIn } from "./users.ts";
import {
  cleanable,
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
  /** Device table names a query's alias gives, with the synced table each holds rows of. */
  deviceTables?: Record<string, string>;
  /** Tables beyond the run's that cleanup also looks in (audit's cleanup scope). */
  outside?: string[];
  /** Per table, the columns this user's devices must not hold. */
  hidden: (user: Member) => Map<string, string[]>;
  /**
   * A row (or a column of one) RLS allows that no device received: a failure where a policy
   * says what syncs, a warning in an audit, where sync may be meant to send less than RLS allows.
   */
  gaps: "fail" | "warn";
  /** Synced tables the run cannot give rows it would find again: compared as the database holds them. */
  asFound?: string[];
  /** Their rows, for generated rows to point at. */
  existing?: Inserted[];
  /** Rows given before sign-in and kept for the run (the access token hook's): a subset of `existing`. */
  fixedRows?: Inserted[];
  /** Fixed rows the database refused, as table, user and its message. */
  fixedRefused?: string[];
}

/** A run under a Samesight policy: tenants, a user per role, the policy's hidden columns. */
export interface Setup extends Run {
  ir: IR;
}

export interface UserProblems {
  user: Member;
  problems: Problem[];
}

/**
 * Removes everything an earlier run may have left: its rows, then its users. `outside` are
 * tables beyond the run's that may hold an earlier run's rows (the access token hook's, from
 * a run made while it was enabled): only rows keyed by the prefix or owned by a run user go.
 */
export async function cleanup(client: pg.Client, stack: Stack, model: TableModel[], outside: TableModel[] = []): Promise<void> {
  const users = await leftoverUsers(client);
  // Tables the run does not model are cleaned as the project's own deletes would be: one at a
  // time, children first, with its foreign keys, cascades and triggers. One that refuses (a row
  // still referenced, a trigger that raises) keeps its rows and stops nothing else; it is tried
  // again once the run's own rows, which may reference it, are gone.
  const others = outside.filter((t) => !model.some((m) => m.name === t.name));
  const ordered = (() => {
    try {
      return insertOrder(others);
    } catch {
      return others;
    }
  })().reverse();
  const refused = new Set<string>();
  const outsideRows = async (tables: TableModel[]) => {
    for (const t of tables) {
      await deleteRows(client, [t], PREFIX, users, { ownedOnly: new Set([t.name]), replica: false }).then(
        () => refused.delete(t.name),
        () => refused.add(t.name),
      );
    }
  };
  await outsideRows(ordered);
  const rowsDeleted = await deleteRows(client, insertOrder(model), PREFIX, users).then(
    () => undefined,
    (e: unknown) => e,
  );
  await outsideRows(ordered.filter((t) => refused.has(t.name)));
  // Every user is tried, whatever happened to the rows; a row outside the run's tables that
  // still points at one can block its delete.
  const failed: string[] = [];
  for (const id of users) await deleteUser(stack, id).catch((e: Error) => failed.push(`${id}: ${e.message}`));
  if (rowsDeleted !== undefined) throw rowsDeleted;
  if (!failed.length) return;
  // Auth answers a row that still references the user with Postgres' 23503, naming its table.
  const tableOf = (f: string) => /still referenced from table \\?"([^"\\]+)\\?"/.exec(f)?.[1];
  const blocked = failed.filter((f) => tableOf(f) !== undefined);
  const rest = failed.filter((f) => tableOf(f) === undefined);
  if (blocked.length) {
    const tables = [...new Set(blocked.map((f) => tableOf(f) as string))];
    throw new UsersBlocked(
      `could not delete ${blocked.length} of ${failed.length} run users: rows in ${tables.join(", ")} still reference them that are not the run's to delete (a real user owns them too, or only an optional column ties them to a run user). ` +
        "Those rows may hold a real user's data: remove or repoint them by hand, then, with no verify run going, delete the users (delete from auth.users where email like '%@verify.samesight.test'; " +
        `a foreign key with on delete cascade then removes the rows that point at them, someone else's included); until then no run can: ${blocked.join("; ")}` +
        (rest.length ? `. The others failed otherwise, and the next run tries them again: ${rest.join("; ")}` : ""),
    );
  }
  // A database error behind Auth's 500 may be a row that blocks the delete.
  const database = failed.some((f) => / 500 /.test(f));
  throw new Error(`could not delete ${failed.length} run users${database ? " (a row a foreign key without on delete cascade ties to them can block it)" : ""}: ${failed.join("; ")}`);
}

/** Run users that rows the run may not delete still reference: no later run removes them either. */
export class UsersBlocked extends Error {}

/** The tables of `names` deleteRows can clean; none when they cannot be read. */
async function outsideModel(client: pg.Client, names: string[]): Promise<TableModel[]> {
  if (!names.length) return [];
  return (await readModel(client, names.map((name) => ({ name }))).catch(() => [])).filter(cleanable);
}

const letter = (i: number) => String.fromCharCode(65 + i);

/** Held for the run: runs share one prefix and one email domain, so a second would delete the first's data. */
const LOCK = Number.parseInt(PREFIX, 16);

/** The connections holding LOCK: added once it is taken, removed once let go. Exported for tests. */
export const holdingLock = new WeakSet<pg.Client>();

const unlock = async (client: pg.Client) => {
  holdingLock.delete(client);
  await client.query("select pg_advisory_unlock($1)", [LOCK]).catch(() => {});
};

/**
 * For a run a signal may stop half way (Ctrl+C, SIGTERM, SIGHUP): `step` removes its users
 * and rows. It ends the run's own database connection (`client`, whose backend id is read
 * now), which rolls back what that had open and lets go of the lock; then, on a connection
 * of its own that takes the lock, it cleans up as tearDown would. It does nothing while the
 * run does not hold the lock (one refused it never cleans another's data), and once the run
 * has begun its own tearDown, which it waits for instead. Use the `tearDown` it returns in
 * place of the plain one, which does nothing once `step` has begun.
 */
export async function stoppable(
  client: pg.Client,
  stack: Stack,
  tables: ScopeTable[],
  log: (line: string) => void,
  outside: string[] = [],
  mode: Mode = "audit",
): Promise<{ step: () => Promise<void>; tearDown: (s: Run) => Promise<void> }> {
  const [{ pid } = { pid: 0 }] = await rows<{ pid: number }>(client, "select pg_backend_pid() as pid");
  let ending: Promise<void> | undefined;
  let stopping = false;
  return {
    tearDown: (s) => {
      if (stopping) return Promise.resolve();
      ending ??= tearDown(s);
      return ending;
    },
    step: async () => {
      if (ending) return ending.catch(() => {});
      if (!holdingLock.has(client)) return;
      stopping = true;
      const later = leftForNext(mode);
      let fresh: pg.Client | undefined;
      try {
        fresh = await connectLocal(stack.db);
        // Unheard, the run's client's error on its ended connection would crash the process.
        client.on("error", () => {});
        await fresh.query("select pg_terminate_backend($1, 5000)", [pid]);
        for (let i = 0; i < 50 && (await rows(fresh, "select 1 from pg_stat_activity where pid = $1", [pid])).length; i++) await new Promise((r) => setTimeout(r, 100));
        holdingLock.delete(client);
        const [{ locked } = { locked: false }] = await rows<{ locked: boolean }>(fresh, "select pg_try_advisory_lock($1) as locked", [LOCK]);
        if (!locked) {
          log(`could not take the run's lock to remove its users and rows; ${later}`);
          return;
        }
        try {
          await cleanup(fresh, stack, insertOrder(await readModel(fresh, tables)), await outsideModel(fresh, outside));
        } finally {
          await fresh.query("select pg_advisory_unlock($1)", [LOCK]).catch(() => {});
        }
      } catch (e) {
        log(`could not remove the run's users and rows: ${(e as Error).message}${e instanceof UsersBlocked ? "" : `; ${later}`}`);
      } finally {
        await fresh?.end().catch(() => {});
      }
    },
  };
}

export async function setUp(client: pg.Client, stack: Stack, ir: IR): Promise<Setup> {
  return exclusive(client, stack, policyTables(ir), () => prepareRun(client, stack, ir));
}

/** How a differential finding says a dataset could not be run (the service failed, say), alone or after a counterexample. */
const RUN_FAILED = "the run failed: ";

/** Whether the differential broke down rather than found something: its service's logs are then worth showing. */
export function brokeDown(findings: Finding[]): boolean {
  return findings.some((f) => f.status === "fail" && f.incomplete === true);
}

/** Users a run without a policy signs up. */
export const AUDIT_USERS = 4;

/** Rows to insert before sign-in and keep for the run (audit/fixed.ts), and the tables they fill. */
export interface FixedSetUp {
  /** Fixed tables: generated rows never go there. */
  tables: string[];
  rows: { table: string; row: Record<string, unknown>; user?: number }[];
  /** The hook's URI, for messages. */
  hook?: string;
  /** Fixed rows' keys as labels show them (teams row 1). */
  names?: Map<string, string>;
  /** Per-user tables and their user columns: run users' rows there (a sign-up trigger's) go before the fixed ones. */
  clear?: { table: string; column: string }[];
}

/** The metadata audit gives each run user, and the claim paths to label users by. */
export interface UserClaims {
  /** Per user, by index; the number of users. */
  metadata: Partial<Record<"app_metadata" | "user_metadata", Record<string, unknown>>>[];
  paths: string[][];
  /** Ids to create the users with, by index (claims may hold them); fresh run ids otherwise. */
  ids?: string[];
}

/**
 * Ids for run users, minted before they are created so claims can hold them. They carry the
 * run's prefix, so a row keyed by its user's id (a profile a signup trigger makes) counts as
 * the run's own.
 */
export function runUserIds(count: number): string[] {
  return Array.from({ length: count }, () => prefixedUuid(PREFIX));
}

/**
 * A run without a policy (audit mode): signed-up users with no tenants, holding the
 * metadata `claims` gives them, if any. Rows belong to users through their foreign keys to
 * auth.users, and what a device may hold is whatever RLS lets its user read. A user is
 * labelled by the values its token carries at the claim paths: u2 (app_metadata.role=editor).
 */
export async function setUpUsers(
  client: pg.Client,
  stack: Stack,
  scope: { tables: ScopeTable[]; synced: string[]; deviceTables?: Record<string, string>; fixed?: FixedSetUp; cleanup?: string[] },
  claims?: UserClaims,
): Promise<Run> {
  const count = claims?.metadata.length || AUDIT_USERS;
  return exclusive(client, stack, scope.tables, async () => {
    const model = insertOrder(await readModel(client, scope.tables));
    const fixedTables = scope.fixed?.tables ?? [];
    // Without tenants, the run finds its rows again only by the prefix it gives uuid keys
    // (fixed tables were checked for a key or a user column when they were planned).
    const refused = auditRefusals(model.filter((t) => !fixedTables.includes(t.name)), scope.synced);
    if (refused.length) throw new Error(`audit mode cannot run on these tables: ${refused.join("; ")}`);
    await cleanup(client, stack, model, await outsideModel(client, scope.cleanup ?? []));
    const ids = claims?.ids?.slice(0, count) ?? runUserIds(count);
    const { users, password } = await createUsers(stack, count, PREFIX.slice(0, 4) + Date.now().toString(36), claims?.metadata, ids);
    // Rows the access token hook reads, before anyone signs in; each on its own, so one the
    // database refuses leaves the others.
    const fixedRows: Inserted[] = [];
    const fixedRefused: string[] = [];
    if (scope.fixed?.clear?.length) {
      await client.query("begin");
      try {
        // As cleanup deletes: past the project's own delete triggers.
        await client.query("set local session_replication_role = replica");
        for (const { table, column } of scope.fixed.clear) {
          await client.query(`delete from public.${ident(table)} where ${ident(column)} = any($1::uuid[])`, [users.map((u) => u.id)]);
        }
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      }
    }
    if (scope.fixed?.rows.length) {
      await client.query("begin");
      try {
        for (const r of scope.fixed.rows) {
          await client.query("savepoint fixed");
          try {
            await insertRow(client, r.table, r.row);
            await client.query("release savepoint fixed");
            fixedRows.push({ table: r.table, row: r.row, tenant: undefined });
          } catch (e) {
            await client.query("rollback to savepoint fixed");
            fixedRefused.push(`${r.table} row${r.user === undefined ? "" : ` for u${r.user}`}: ${(e as Error).message}`);
          }
        }
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      }
    }
    const sessions = new Map<string, Session>();
    for (const [i, u] of users.entries()) {
      try {
        sessions.set(u.id, await signIn(stack, u.email, password));
      } catch (e) {
        // The hook runs on every sign-in, with the rows this user was given.
        if (scope.fixed?.hook) {
          const given = scope.fixed.rows.filter((r) => r.user === i).map((r) => r.table);
          throw new Error(`signing in u${i} failed: ${(e as Error).message}. The access token hook ${scope.fixed.hook} runs on every sign-in${given.length ? `, with the rows audit gave u${i} in ${[...new Set(given)].join(", ")}` : ""}`);
        }
        throw e;
      }
    }
    const names = new Map([...users.map((u, i) => [u.id, `u${i}`] as const), ...(scope.fixed?.names ?? [])]);
    const members: Member[] = users.map((u, i) => ({ ...u, tenant: null, role: null, label: claimLabel(`u${i}`, sessions.get(u.id)?.claims ?? {}, claims?.paths ?? [], names) }));
    return {
      client,
      stack,
      model,
      tables: generatedTables(model, fixedTables),
      fixed: { prefix: PREFIX, tenants: [], users: members },
      sessions,
      password,
      synced: scope.synced,
      ...(scope.deviceTables ? { deviceTables: scope.deviceTables } : {}),
      ...(scope.fixed ? { existing: fixedRows, fixedRows, fixedRefused } : {}),
      ...(scope.cleanup?.length ? { outside: scope.cleanup } : {}),
      hidden: () => new Map(),
      gaps: "warn",
    };
  }, scope.cleanup);
}

/**
 * u2 (app_metadata.role=editor), from what the token carries at each path; bare when it
 * carries none. A value that is a run user's id shows as that user (manager_id=u1).
 */
export function claimLabel(name: string, claims: Record<string, unknown>, paths: string[][], users: ReadonlyMap<string, string> = new Map()): string {
  const held = paths.flatMap((path) => {
    let v: unknown = claims;
    for (const k of path) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    return v === undefined || v === null ? [] : [`${claimKey(path)}=${typeof v === "string" && users.has(v) ? users.get(v) : show(v)}`];
  });
  return held.length ? `${name} (${held.join(", ")})` : name;
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
async function exclusive<T extends Run>(client: pg.Client, stack: Stack, tables: ScopeTable[], prepare: () => Promise<T>, outside: string[] = []): Promise<T> {
  const [{ locked } = { locked: false }] = await rows<{ locked: boolean }>(client, "select pg_try_advisory_lock($1) as locked", [LOCK]);
  if (!locked) throw new Error("another samesight verify run is using this database; wait for it to finish");
  holdingLock.add(client);
  try {
    return await prepare();
  } catch (e) {
    // Users, tenants and memberships made before the failure: removed now, not by the next run.
    const model = insertOrder(await readModel(client, tables).catch(() => []));
    await cleanup(client, stack, model, await outsideModel(client, outside)).catch(() => {});
    await unlock(client);
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
  // Policy mode's claims come from tenants and roles, not ids: Auth picks them, as any Auth can.
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
  // A shared table (tenant: null) is found again only by the prefix the run gives its uuid
  // keys; one keyed otherwise (country codes, say) gets no generated rows, and its own rows
  // are compared as they are.
  const asFound = ir.tables.filter((t) => t.tenant === null && t.read.size > 0 && auditRefusals(model.filter((m) => m.name === t.name), []).length > 0).map((t) => t.name);
  const existing: Inserted[] = [];
  for (const table of asFound) {
    for (const { row } of await rows<{ row: Record<string, unknown> }>(client, `select row_to_json(x) as row from public.${ident(table)} x limit 50`)) {
      existing.push({ table, row, tenant: undefined });
    }
  }
  const skip = [ir.tenantTable ?? "", ir.membership.table, ...asFound];
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
    asFound,
    existing,
  };
}

async function insertRow(client: pg.Client, table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await client.query(
    `insert into public.${ident(table)} (${cols.map(ident).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => row[c]),
  );
}

/**
 * Waits until PowerSync's replication slots have confirmed everything written so far: the
 * active ones named `slotPrefix` (powersync_ by default, the run's own under auto-start).
 * An inactive slot is a stopped service's, which will never catch up.
 */
export async function waitForReplication(client: pg.Client, timeoutMs = 60_000, slotPrefix = "powersync"): Promise<void> {
  const [{ lsn } = { lsn: "" }] = await rows<{ lsn: string }>(client, "select pg_current_wal_lsn()::text as lsn");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const slots = await rows<{ name: string; caught_up: boolean }>(
      client,
      `select slot_name as name, coalesce(confirmed_flush_lsn >= $1::pg_lsn, false) as caught_up
         from pg_replication_slots where slot_type = 'logical' and active and starts_with(slot_name, $2)`,
      [lsn, slotPrefix],
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
      out.set(u.id, await syncOnce(s.stack.powersync, session.token, s.deviceTables ? { deviceTables: s.deviceTables } : {}));
    }),
  );
  return out;
}

/**
 * Whether a row a device or a user's read saw is the run's own, to count in coverage: one
 * keyed by the run's prefix, or by a run user's id (a profile keyed by its user, whoever chose
 * the id); a table whose key is no uuid counts every row.
 */
export function isRunRow(model: TableModel[], prefix: string, userIds: readonly string[], table: string, id: string): boolean {
  const t = model.find((m) => m.name === table);
  const key = t?.columns.find((c) => c.name === t.primaryKey[0]);
  return key?.type !== "uuid" || id.startsWith(prefix) || userIds.includes(id);
}

/** Compares every user's device with what RLS returns them, for the data in the database now. */
export async function compareAll(s: Run, options: IterationOptions = {}): Promise<UserProblems[]> {
  const devices = options.devices ?? (await syncAll(s));
  const out: UserProblems[] = [];
  const readers = s.fixed.users.map((u) => s.sessions.get(u.id)?.claims ?? {});
  const seen = await readAsUsers(s.client, readers, s.synced, options.prepare);
  // Only the run's own rows count as tested: rows already in the database say nothing about the generated ones.
  const userIds = s.fixed.users.map((u) => u.id);
  const ours = (table: string, id: string) => isRunRow(s.model, s.fixed.prefix, userIds, table, id);
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
    inserted = await insertWorld(s.client, s.tables, world, s.fixed, s.existing);
    await s.client.query("commit");
  } catch (e) {
    await s.client.query("rollback").catch(() => {});
    throw e;
  }
  try {
    await waitForReplication(s.client, undefined, s.stack.slotPrefix);
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
  /** The shrunk failing world's problems, as row reports. */
  counterexample?: RowReport[];
  /** The time limit ended the run before every dataset. */
  stopped?: boolean;
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

export interface DifferentialOptions {
  runs: number;
  seed?: number;
  timeLimitMs: number;
  /** Audit only: counts which rules each passing dataset exercised, until the first failure. */
  coverage?: Coverage;
  /** The sync config's streams, to name the query that sent a row of the counterexample and suggest a fix. */
  sync?: { kind: "streams" | "bucket definitions"; streams: Stream[] };
  /** The command that replays the run with a seed, set on a counterexample's finding. */
  replay?: (seed: number) => string;
}

export async function differential(s: Run, options: DifferentialOptions): Promise<DifferentialResult> {
  const check = "differential";
  lastInsertError.clear();
  // What the run actually compared: a dataset whose rows all fail to insert, that nobody may
  // read, or that no device receives would agree (or only warn) on both sides and prove nothing.
  const inserted = new Map<string, number>();
  const visible = new Map<string, number>();
  const received = new Map<string, number>();
  // Gaps that are only warnings (audit mode): one example per kind of gap, ids aside.
  const gaps = new Map<string, RowReport>();
  const failing = (all: UserProblems[]): UserProblems[] => {
    const split = splitProblems(all, s.gaps);
    for (const r of reportRows(s, split.narrower)) {
      const key = r.summary.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "…");
      if (!gaps.has(key)) gaps.set(key, r);
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
        detail: `RLS lets users read rows no stream sends them (sync is narrower than RLS: fine if intended, but RLS alone guards the REST API), for example:\n${formatRows(shown)}${more}`,
        rows: shown,
      },
    ];
  };
  // A run that could not finish (a service broke down) is incomplete: it found nothing, and checked nothing either.
  const fail = (detail: string, runs: number, incomplete = false) => ({
    runs,
    findings: withGaps([{ status: "fail" as const, check, detail, ...(incomplete ? { incomplete } : {}) }]),
  });

  // Coverage counts datasets up to the first failure: shrinking replays variations of that one.
  let failedOnce = false;
  const evaluate = async (world: World) => {
    const ok = await withWorld(s, world, async (rowsIn) => {
      for (const r of rowsIn) inserted.set(r.table, (inserted.get(r.table) ?? 0) + 1);
      const devices = await syncAll(s);
      const passed = failing(await compareAll(s, { devices, tally: visible, received })).length === 0;
      if (passed && !failedOnce && options.coverage) await measure(s, options.coverage, rowsIn, devices, (s.fixedRows ?? []).filter((r) => s.synced.includes(r.table)));
      return passed;
    });
    failedOnce ||= !ok;
    return ok;
  };
  const untestedTables = () =>
    s.tables.filter((t) => s.synced.includes(t.name) && !(inserted.get(t.name) && visible.get(t.name) && received.get(t.name))).length > 0 ||
    (options.coverage !== undefined && pending(options.coverage));
  // Small random datasets can leave a table deep in the foreign keys with no row a user
  // reads (its rows all landed in the tenant nobody in the run belongs to). More datasets
  // are tried, within the time limit, until every synced table was compared.
  const started = Date.now();
  let x = await explore(worldArbitrary(s.tables), evaluate, options);
  let datasets = x.datasets;
  for (let pass = 1; pass <= 3 && !x.lastFailing && x.crash === undefined && !x.stopped && untestedTables(); pass++) {
    const left = options.timeLimitMs - (Date.now() - started);
    if (left <= 0) break;
    x = await explore(worldArbitrary(s.tables), evaluate, { runs: options.runs, timeLimitMs: left, ...(options.seed !== undefined ? { seed: options.seed + pass } : {}) });
    datasets += x.datasets;
  }
  x = { ...x, datasets };
  // A run that failed after the counterexample was found: said on its own, as incomplete.
  const crashed: Finding[] = x.crash === undefined ? [] : [{ status: "fail", check, detail: `then ${RUN_FAILED}${String(x.crash)}`, incomplete: true }];
  if (x.lastFailing) {
    const world = x.lastFailing;
    // Put down to their queries and policies while the rows are still in the database.
    const counterexample = await withWorld(s, world, async () => {
      const rows = reportRows(s, failing(await compareAll(s)));
      const claimsOf = (id: string) => s.sessions.get(id)?.claims;
      if (options.sync) await sendingQueries(s.client, options.sync.streams, rows, claimsOf);
      await policyVerdicts(s.client, rows, claimsOf);
      if (options.sync) await likelyFixes(s.client, options.sync, rows, claimsOf);
      return rows;
    });
    if (!counterexample.length) return fail(`a dataset failed (seed ${x.seed}) but passed when run again: devices may not have caught up${x.crash === undefined ? "" : ` (then ${RUN_FAILED}${String(x.crash)})`}`, x.datasets, true);
    return {
      runs: x.datasets,
      counterexample,
      findings: withGaps([
        {
          status: "fail",
          check,
          detail: `devices and RLS disagree (seed ${x.seed}, shrunk ${x.numShrinks} times to ${countRows(world)} rows${x.stopped ? "; shrinking stopped at the time limit" : ""}):\n${formatRows(counterexample)}`,
          rows: counterexample,
          ...(options.replay ? { replay: options.replay(x.seed) } : {}),
        },
        ...crashed,
      ]),
    };
  }
  if (x.crash !== undefined) return { ...fail(`${RUN_FAILED}${String(x.crash)}`, x.datasets, true), stopped: x.stopped };
  if (x.datasets === 0) return { runs: 0, findings: [{ status: "fail", check, detail: "no dataset was tested before the time limit", incomplete: true }] };
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
  const unread = (s.asFound ?? []).filter((t) => !visible.get(t));
  const notes: Finding[] = unread.map((t) => ({
    status: "warn",
    check,
    detail: `${t} is shared and not keyed by a uuid, so the run generates no rows for it, and no user read any of its rows in the database: it was not compared`,
  }));
  const users = s.fixed.users.length;
  const complete = s.gaps === "fail" ? ", and every row RLS returns was synced" : "";
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    runs: x.datasets,
    stopped: x.stopped,
    findings: withGaps([
      {
        status: "ok",
        check,
        detail: `${x.datasets} generated datasets (${sum(inserted)} rows; ${sum(visible)} row reads compared), ${users} users each: every synced row is one RLS returns, with no hidden column${complete}${x.stopped ? " (stopped at the time limit)" : ""}`,
      },
      ...notes,
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

/** Each problem as a row report: who, which row, which streams sent it. */
export function reportRows(s: Run, failures: UserProblems[]): RowReport[] {
  return failures.flatMap(({ user, problems }) =>
    problems.map((p) => {
      const r = {
        kind: p.kind,
        user: { label: user.label, id: user.id, role: user.role },
        table: p.table,
        id: p.id,
        row: describeRow(s, p.table, p.id, p.row),
        ...(p.columns ? { columns: p.columns } : {}),
        sentBy: p.streams.map((stream) => ({ stream })),
      };
      return { ...r, summary: `${rowSentence(r, p.streams.length ? ` (stream ${p.streams.join(", ")})` : "")}.` };
    }),
  );
}

/** Each problem in a sentence: who, which row, which streams, which way. */
export function describeFailures(s: Run, failures: UserProblems[]): string[] {
  return reportRows(s, failures).map((r) => r.summary);
}

export async function tearDown(s: Run): Promise<void> {
  try {
    await cleanup(s.client, s.stack, s.model, await outsideModel(s.client, s.outside ?? []));
  } finally {
    await unlock(s.client);
  }
}
