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

const userColumn = (t: TableModel) =>
  t.foreignKeys.find((fk) => fk.schema === "auth" && fk.table === "users" && fk.columns.length === 1)?.columns[0];
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
  // Every public table a row there points at, transitively.
  const walk = [...set];
  for (let i = 0; i < walk.length; i++) {
    for (const fk of byName.get(walk[i] as string)?.foreignKeys ?? []) {
      if (fk.schema === "public" && fk.table !== walk[i] && !set.has(fk.table) && byName.has(fk.table)) {
        set.add(fk.table);
        walk.push(fk.table);
      }
    }
  }
  // Parents first: a row's key to a fixed table takes one of that table's rows.
  const tables = insertOrder(model.filter((t) => set.has(t.name))).map((t) => t.name);
  for (const name of tables) {
    const t = byName.get(name) as TableModel;
    const own = perUser.includes(name);
    if (!uuidKey(t) && !(own && userColumn(t))) return { tables: [], perUser: [], notes, refusal: `${name} has no uuid key${own ? " or column pointing at auth.users" : ""} of its own, so audit could not find its rows again` };
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
export function hookDims(model: TableModel[], plan: FixedPlan, body: string, parentRows: (table: string) => number = () => PARENT_ROWS): Dim[] {
  const out: Dim[] = [];
  const named = (c: string) => new RegExp(`(?<![A-Za-z0-9_$])${c.replace(/[$]/g, "\\$")}(?![A-Za-z0-9_$])`, "i").test(body);
  for (const name of plan.perUser) {
    const t = model.find((m) => m.name === name) as TableModel;
    const user = userColumn(t);
    const own: Dim[] = [];
    for (const c of t.columns) {
      if (c.name === user || c.computed || (t.primaryKey.includes(c.name) && uuidKey(t))) continue;
      const fk = t.foreignKeys.find((k) => k.columns.length === 1 && k.columns[0] === c.name && k.schema === "public" && plan.tables.includes(k.table));
      if (fk) {
        own.push({ table: name, column: c.name, options: Array.from({ length: parentRows(fk.table) }, (_, i) => i), parent: fk.table });
        continue;
      }
      if (t.foreignKeys.some((k) => k.columns.includes(c.name))) continue;
      if (c.values?.length) {
        own.push({ table: name, column: c.name, options: [...c.values] });
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
): FixedRow[] {
  const out: FixedRow[] = [];
  const keysOf = new Map<string, unknown[]>();
  const fill = (t: TableModel, row: Record<string, unknown>, seed: number) => {
    for (const c of t.columns) {
      if (row[c.name] !== undefined || !required(c)) continue;
      row[c.name] = c.values?.[seed % c.values.length] ?? sampleValue(c, seed);
    }
    return row;
  };
  for (const name of plan.tables) {
    const t = model.find((m) => m.name === name) as TableModel;
    const key = t.primaryKey[0] as string;
    if (!plan.perUser.includes(name)) {
      const pool = keyPool(name);
      const keys = Array.from({ length: parentRows(name) }, (_, i) => (pool?.column === key ? pool.values[i] : undefined) ?? mint());
      keysOf.set(name, keys);
      for (const [i, k] of keys.entries()) {
        const row: Record<string, unknown> = { [key]: k };
        // A key to another fixed table: its rows in turn.
        for (const fk of t.foreignKeys) {
          if (fk.schema === "public" && fk.columns.length === 1 && keysOf.has(fk.table)) {
            const parents = keysOf.get(fk.table) as unknown[];
            row[fk.columns[0] as string] = parents[i % parents.length];
          }
        }
        out.push({ table: name, row: fill(t, row, i) });
      }
      continue;
    }
    const user = userColumn(t) as string;
    const mine = dims.map((d, i) => ({ d, i })).filter(({ d }) => d.table === name);
    for (const [u, pick] of picks.entries()) {
      if (!pick || userIds[u] === undefined) continue;
      const row: Record<string, unknown> = { [user]: userIds[u] };
      if (uuidKey(t)) row[key] = mint();
      let present = true;
      for (const { d, i } of mine) {
        const option = d.options[pick[i] ?? 0];
        if (d.column === null) present = option === true;
        else if (d.parent) row[d.column] = (keysOf.get(d.parent) ?? [])[option as number];
        else row[d.column] = option;
      }
      if (present) out.push({ table: name, row: fill(t, row, 100 + u), user: u });
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
