/**
 * Rows the access token hook reads, given to run users before they sign in and kept for the
 * whole run (B3b). A hook table with a column pointing at auth.users (memberships.user_id)
 * gets one row per run user, varied over its columns (the team a key points at, a role from
 * its CHECK list), so the claims the hook adds differ between users; the public tables those
 * rows point at (teams) get a few rows of their own. Users take these values jointly with the
 * metadata audit gives them (assign.ts), so a role and a team are tried together.
 */

import type { ClaimValue } from "samesight/compiler";
import { type ColumnModel, insertOrder, type TableModel } from "../differential/model.ts";
import { sampleValue } from "../differential/world.ts";
import { fitsType } from "./assign.ts";

/** What the run does with the hook's tables. */
export interface FixedPlan {
  /** Tables given fixed rows, in insert order: hook tables with a user column, and the public tables they point at. */
  tables: string[];
  /** The hook tables among them, which get a row per run user. */
  perUser: string[];
  /** Hook tables audit gives no rows (no column for a user), as notes. */
  notes: string[];
  /** Why audit cannot give the hook rows, when it cannot. */
  refusal?: string;
}

/** The column a row belongs to its user by: a key to auth.users, a required one first (user_id before invited_by). */
const userColumn = (t: TableModel) => {
  const keys = t.foreignKeys.filter((fk) => fk.schema === "auth" && fk.table === "users" && fk.columns.length === 1).map((fk) => fk.columns[0] as string);
  return keys.find((c) => t.columns.find((x) => x.name === c)?.nullable === false) ?? keys[0];
};
const required = (c: ColumnModel) => !c.nullable && !c.hasDefault && !c.computed;
const uuidKey = (t: TableModel) =>
  t.primaryKey.length === 1 &&
  t.columns.find((c) => c.name === t.primaryKey[0])?.type === "uuid" &&
  !t.foreignKeys.some((fk) => fk.columns.includes(t.primaryKey[0] as string));

/** The hook tables audit can give rows, the tables they point at, and why not, if it cannot. */
export function fixedPlan(model: TableModel[], hookTables: string[]): FixedPlan {
  const byName = new Map(model.map((t) => [t.name, t]));
  const perUser = hookTables.filter((n) => byName.has(n) && userColumn(byName.get(n) as TableModel) !== undefined);
  const notes = hookTables.filter((n) => !perUser.includes(n)).map((n) => `the access token hook reads ${n}, which has no column pointing at auth.users, so audit does not choose its rows`);
  const set = new Set(perUser);
  // Every public table a row there must point at, transitively: a key it may leave null leaves
  // its table generated, as before.
  const walk = [...set];
  for (let i = 0; i < walk.length; i++) {
    const t = byName.get(walk[i] as string) as TableModel;
    for (const fk of t.foreignKeys) {
      const must = fk.columns.every((c) => t.columns.find((x) => x.name === c)?.nullable === false);
      if (must && fk.schema === "public" && fk.table !== walk[i] && !set.has(fk.table) && byName.has(fk.table)) {
        set.add(fk.table);
        walk.push(fk.table);
      }
    }
  }
  // Parents first: a row's key to a fixed table takes one of that table's rows.
  let tables: string[];
  try {
    tables = insertOrder(model.filter((t) => set.has(t.name))).map((t) => t.name);
  } catch {
    return { tables: [], perUser: [], notes, refusal: `the tables its rows must point at (${[...set].join(", ")}) point at each other in a cycle` };
  }
  for (const name of tables) {
    const t = byName.get(name) as TableModel;
    const own = perUser.includes(name);
    // Without a uuid key, its rows are found by their user, so every one must have one.
    const owned = own && t.columns.find((c) => c.name === userColumn(t))?.nullable === false;
    if (!uuidKey(t) && !owned) return { tables: [], perUser: [], notes, refusal: `${name} has no uuid key${own ? " or required column pointing at auth.users" : ""} of its own, so audit could not find its rows again` };
    for (const fk of t.foreignKeys) {
      if (!fk.columns.every((c) => required(t.columns.find((x) => x.name === c) as ColumnModel))) continue;
      if (fk.schema === "auth" && fk.table === "users" && fk.columns.length === 1) continue;
      if (fk.schema === "public" && fk.table !== name && set.has(fk.table) && fk.columns.length === 1) continue;
      return { tables: [], perUser: [], notes, refusal: `${name}.${fk.columns.join(", ")} must point at ${fk.schema}.${fk.table}, where audit gives no rows` };
    }
    for (const c of t.columns) {
      if (!required(c) || t.foreignKeys.some((fk) => fk.columns.includes(c.name)) || t.primaryKey.includes(c.name)) continue;
      if (c.values?.length || sampleValue(c, 0) !== undefined) continue;
      return { tables: [], perUser: [], notes, refusal: `${name}.${c.name} (${c.type}) needs a value audit cannot make` };
    }
  }
  return { tables, perUser: tables.filter((n) => perUser.includes(n)), notes };
}

/** One way a per-user row varies: the options one user's row takes one of. */
export interface Dim {
  table: string;
  /** The column, or null for whether the user has a row at all. */
  column: string | null;
  /** Values (for a key to another fixed table, the index of its row there). */
  options: unknown[];
  /** For a key: the table its options are rows of. */
  parent?: string;
}

/** How many rows a fixed table that per-user rows point at gets. */
export const PARENT_ROWS = 2;

/**
 * The ways per-user rows vary, column by column: a key to a fixed table over its rows, a
 * CHECK or enum list, else the literals rules compare the column with (its hints and claim
 * values, when the hook names the column). A table with none varies by having a row or not.
 */
export function hookDims(model: TableModel[], plan: FixedPlan, body: string, parentRows: (table: string) => number = () => PARENT_ROWS, own = body): Dim[] {
  const out: Dim[] = [];
  // A column the hook reads: named in `body` (its own and its helpers'), or any, when its own body selects *.
  const star = /(?<![A-Za-z0-9_$])select\s+(?:[A-Za-z_][A-Za-z0-9_$]*\.)?\*/i.test(own);
  const named = (c: string) => star || new RegExp(`(?<![A-Za-z0-9_$])${c.replace(/[$]/g, "\\$")}(?![A-Za-z0-9_$])`, "i").test(body);
  for (const name of plan.perUser) {
    const t = model.find((m) => m.name === name) as TableModel;
    const user = userColumn(t);
    const own: Dim[] = [];
    for (const c of t.columns) {
      if (c.name === user || c.computed || (t.primaryKey.includes(c.name) && uuidKey(t))) continue;
      // A key to a parent's rows varies; one to itself, or to another per-user table (the same user's row there), does not.
      const fk = t.foreignKeys.find((k) => k.columns.length === 1 && k.columns[0] === c.name && k.schema === "public" && k.table !== name && plan.tables.includes(k.table) && !plan.perUser.includes(k.table));
      if (fk) {
        own.push({ table: name, column: c.name, options: Array.from({ length: parentRows(fk.table) }, (_, i) => i), parent: fk.table });
        continue;
      }
      if (t.foreignKeys.some((k) => k.columns.includes(c.name))) continue;
      if (c.values?.length) {
        if (named(c.name)) own.push({ table: name, column: c.name, options: [...c.values] });
        continue;
      }
      const literals = [...new Set([...c.hints, ...(c.claimValues ?? [])])].filter((v) => fitsType(v as ClaimValue, c.type));
      if (literals.length && named(c.name)) own.push({ table: name, column: c.name, options: literals });
    }
    out.push(...(own.length ? own : [{ table: name, column: null, options: [true, false] }]));
  }
  return out;
}

/** A fixed row: its table, its values, and the run user it was made for, if any. */
export interface FixedRow {
  table: string;
  row: Record<string, unknown>;
  user?: number;
}

/**
 * The rows to insert before sign-in, in insert order: PARENT_ROWS rows (or `parentRows`) for
 * each table per-user rows point at, then one row per user with picks, from `picks[user]` (an
 * option index per dim; absent: no row). Keys are `mint()`ed run uuids; required columns
 * left over take a sample value.
 */
export function fixedRows(
  model: TableModel[],
  plan: FixedPlan,
  dims: Dim[],
  picks: (number[] | undefined)[],
  userIds: string[],
  mint: () => string,
  parentRows: (table: string) => number = () => PARENT_ROWS,
  keyPool: (table: string) => { column: string; values: unknown[] } | undefined = () => undefined,
  claimValues: (table: string) => ReadonlyMap<string, unknown[]> | undefined = () => undefined,
): FixedRow[] {
  const out: FixedRow[] = [];
  const keysOf = new Map<string, unknown[]>();
  // Per-user tables' rows by user, for a per-user row that points at the same user's row in another.
  const mineOf = new Map<string, Map<number, Record<string, unknown>>>();
  const fill = (t: TableModel, row: Record<string, unknown>, seed: number) => {
    for (const c of t.columns) {
      if (row[c.name] !== undefined || c.computed) continue;
      // Values run users hold in a claim the rules compare this column with, as generated rows would take them.
      const held = claimValues(t.name)?.get(c.name);
      if (held?.length) row[c.name] = held[seed % held.length];
      else if (required(c)) row[c.name] = c.values?.[seed % c.values.length] ?? sampleValue(c, seed);
    }
    return row;
  };
  const toUsers = (t: TableModel) => t.foreignKeys.filter((fk) => fk.schema === "auth" && fk.table === "users" && fk.columns.length === 1).map((fk) => fk.columns[0] as string);
  for (const name of plan.tables) {
    const t = model.find((m) => m.name === name) as TableModel;
    const key = t.primaryKey[0] as string;
    if (!plan.perUser.includes(name)) {
      const pool = keyPool(name);
      const keys = Array.from({ length: parentRows(name) }, (_, i) => (pool?.column === key ? pool.values[i] : undefined) ?? mint());
      for (const [i, k] of keys.entries()) {
        const row: Record<string, unknown> = { [key]: k };
        // A key to another fixed table: its rows in turn; to auth.users, the run's users in turn; to itself, none.
        for (const fk of t.foreignKeys) {
          if (fk.columns.length !== 1) continue;
          if (fk.schema === "public" && fk.table !== name && keysOf.has(fk.table)) {
            const parents = keysOf.get(fk.table) as unknown[];
            row[fk.columns[0] as string] = parents[i % parents.length];
          }
        }
        for (const c of toUsers(t)) if (userIds.length) row[c] = userIds[i % userIds.length];
        out.push({ table: name, row: fill(t, row, i) });
      }
      keysOf.set(name, keys);
      continue;
    }
    const user = userColumn(t) as string;
    const mine = dims.map((d, i) => ({ d, i })).filter(({ d }) => d.table === name);
    const rows = new Map<number, Record<string, unknown>>();
    mineOf.set(name, rows);
    for (const [u, pick] of picks.entries()) {
      if (!pick || userIds[u] === undefined) continue;
      const row: Record<string, unknown> = {};
      // Every key to auth.users is this user (a created_by beside user_id).
      for (const c of toUsers(t)) row[c] = userIds[u];
      row[user] = userIds[u];
      if (uuidKey(t)) row[key] = mint();
      let present = true;
      for (const { d, i } of mine) {
        const option = d.options[pick[i] ?? 0];
        if (d.column === null) present = option === true;
        else if (d.parent) row[d.column] = (keysOf.get(d.parent) ?? [])[option as number];
        else row[d.column] = option;
      }
      // A key to another per-user table: this user's row there, or none.
      for (const fk of t.foreignKeys) {
        const parent = fk.columns.length === 1 && fk.schema === "public" && fk.table !== name ? mineOf.get(fk.table) : undefined;
        if (!parent) continue;
        const theirs = parent.get(u);
        const column = fk.columns[0] as string;
        if (theirs) row[column] = theirs[fk.references[0] as string];
        else if (t.columns.find((c) => c.name === column)?.nullable === false) present = false;
      }
      if (!present) continue;
      rows.set(u, fill(t, row, 100 + u));
      out.push({ table: name, row, user: u });
    }
  }
  return out;
}

/** memberships.role='lead', memberships.team_id=teams row 2: one option of a dim, for messages. */
export function dimLabel(d: Dim, option: unknown): string {
  if (d.column === null) return `${option ? "a" : "no"} ${d.table} row`;
  if (d.parent) return `${d.table}.${d.column}=${d.parent} row ${(option as number) + 1}`;
  return `${d.table}.${d.column}=${typeof option === "string" ? `'${option}'` : String(option)}`;
}
