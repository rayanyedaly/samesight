/**
 * The data a differential iteration runs on. The run fixes the tenants, the users and
 * their memberships (so each user signs in once per run); fast-check generates the rows
 * of every other policy table, so a failure shrinks to the fewest rows that show it.
 *
 * Rows are generated from the schema alone: foreign keys pick a parent already inserted
 * (matching any column set before them, so composite keys stay within a tenant), auth.users
 * keys pick one of the run's users, check-constraint lists and policy literals feed the
 * values. A row the database refuses is skipped, under a savepoint.
 */

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type pg from "pg";
import { ident } from "samesight/compiler";
import { type ColumnModel, type ForeignKeyModel, jsPattern, type TableModel } from "./model.ts";

export interface Member {
  id: string;
  email: string;
  /** Null: signed up, no membership. */
  tenant: string | null;
  role: string | null;
  label: string;
}

export interface Fixed {
  /** Every id the run writes starts with this, so cleanup finds exactly its rows. */
  prefix: string;
  tenants: string[];
  users: Member[];
}

export interface RowGene {
  tenant: number;
  picks: number[];
  values: Record<string, unknown>;
}

export type World = Record<string, RowGene[]>;

export interface Inserted {
  table: string;
  row: Record<string, unknown>;
  tenant: unknown;
}

const MAX_ROWS = 8;

/** A run's ids: a fixed 8-hex prefix, then random. */
export function prefixedUuid(prefix: string): string {
  return `${prefix}${randomUUID().slice(prefix.length)}`;
}

function fkColumns(t: TableModel): Set<string> {
  return new Set(t.foreignKeys.flatMap((fk) => fk.columns));
}

function scalar(c: ColumnModel): fc.Arbitrary<unknown> | undefined {
  const base = baseScalar(c);
  // Values run users hold in a claim the rules compare this column with: drawn as often as the rest.
  return base && c.claimValues?.length ? fc.oneof(fc.constantFrom(...c.claimValues), base) : base;
}

function baseScalar(c: ColumnModel): fc.Arbitrary<unknown> | undefined {
  const t = c.type;
  if (c.values?.length) return fc.constantFrom(...new Set([...c.values, ...c.hints]));
  if (c.pattern !== undefined) {
    // A Postgres-only pattern (a POSIX class, say) gets plain strings: rows it refuses are skipped.
    const re = jsPattern(c.pattern);
    if (!re) return fc.string({ maxLength: 12 });
    try {
      return fc.stringMatching(re);
    } catch {
      return fc.string({ maxLength: 12 });
    }
  }
  const hinted = (arb: fc.Arbitrary<unknown>) => (c.hints.length ? fc.oneof(fc.constantFrom(...c.hints), arb) : arb);
  if (t === "uuid") return fc.uuid({ version: 4 });
  if (t === "text" || t.startsWith("character")) return hinted(fc.string({ maxLength: 12 }));
  if (/^(bigint|integer|smallint|numeric)/.test(t)) return hinted(fc.integer({ min: -1000, max: 1000 }));
  if (t === "boolean") return fc.boolean();
  if (/^(timestamp|date)/.test(t)) return fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01"), noInvalidDate: true }).map((d) => d.toISOString());
  if (t === "jsonb" || t === "json") return fc.constant("{}");
  return undefined;
}

/**
 * The arbitrary for one column, or undefined to leave it to its default. A column with a
 * default is generated too, with the default as the first (and simplest) choice: a rule on
 * `is_public boolean default false` must see rows on both sides of it.
 */
export function columnArbitrary(c: ColumnModel): fc.Arbitrary<unknown> | undefined {
  if (c.computed || c.autoKey) return undefined;
  const arb = scalar(c);
  if (!arb) return c.nullable && !c.hasDefault ? fc.constant(null) : undefined;
  const value = c.nullable ? fc.option(arb, { nil: null, freq: 4 }) : arb;
  return c.hasDefault ? fc.oneof(fc.constant(undefined), value) : value;
}

/** The tables fast-check fills: every policy table but the tenant and membership tables. */
export function generatedTables(model: TableModel[], skip: string[]): TableModel[] {
  return model.filter((t) => !skip.includes(t.name));
}

/** `minRows`/`maxRows` per table: the differential shrinks towards one row; the mutation test wants more. */
export function worldArbitrary(tables: TableModel[], size: { minRows?: number; maxRows?: number } = {}): fc.Arbitrary<World> {
  const perTable: Record<string, fc.Arbitrary<RowGene[]>> = {};
  for (const t of tables) {
    const viaFk = fkColumns(t);
    const values: Record<string, fc.Arbitrary<unknown>> = {};
    for (const c of t.columns) {
      if (c.name === t.tenant || viaFk.has(c.name)) continue;
      const arb = columnArbitrary(c);
      if (arb) values[c.name] = arb;
    }
    perTable[t.name] = fc.array(
      fc.record({
        tenant: fc.nat(),
        picks: fc.array(fc.nat(), { minLength: t.foreignKeys.length, maxLength: t.foreignKeys.length }),
        values: fc.record(values),
      }),
      { minLength: size.minRows ?? 1, maxLength: size.maxRows ?? MAX_ROWS },
    );
  }
  return fc.record(perTable);
}

/** One value for a column outside fast-check (tenant and membership rows), deterministic per seed. */
export function sampleValue(c: ColumnModel, seed: number): unknown {
  const arb = columnArbitrary({ ...c, nullable: false });
  return arb ? fc.sample(arb, { numRuns: 1, seed })[0] : undefined;
}

/** Per table, the last error that refused a generated row: said when a table gets no rows at all. */
export const lastInsertError = new Map<string, string>();

async function insert(client: pg.Client, table: string, row: Record<string, unknown>): Promise<boolean> {
  const cols = Object.keys(row).filter((c) => row[c] !== undefined);
  const sql = `insert into public.${ident(table)} (${cols.map(ident).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`;
  await client.query("savepoint row");
  try {
    await client.query(sql, cols.map((c) => row[c]));
    await client.query("release savepoint row");
    return true;
  } catch (e) {
    // A generated row can break a constraint the model does not know (a CHECK across
    // columns, a trigger); it is skipped, and the dataset is smaller.
    lastInsertError.set(table, (e as Error).message);
    await client.query("rollback to savepoint row");
    return false;
  }
}

/** Resolves one foreign key for `row`, or returns false when no parent fits a required key. */
function resolve(fk: ForeignKeyModel, pick: number, row: Record<string, unknown>, t: TableModel, fixed: Fixed, done: Inserted[]): boolean {
  const unset = fk.columns.filter((c) => row[c] === undefined);
  if (!unset.length) return true;
  const nullable = unset.every((c) => t.columns.find((x) => x.name === c)?.nullable);
  // Without a tenant column (audit mode), every row is in the one "tenant" of the run.
  const rowTenant = t.tenant === undefined ? undefined : row[t.tenant];
  if (fk.schema === "auth" && fk.table === "users" && fk.columns.length === 1) {
    // Users of the row's own tenant come up most often: they are the ones rules compare with.
    const own = fixed.users.filter((u) => u.tenant !== null && u.tenant === rowTenant);
    const choices = [...own, ...own, ...fixed.users];
    const user = choices[pick % (choices.length + (nullable ? 1 : 0))];
    row[fk.columns[0] as string] = user ? user.id : null;
    return true;
  }
  const fits = done
    .filter((d) => d.table === fk.table)
    .filter((d) => fk.columns.every((c, i) => row[c] === undefined || d.row[fk.references[i] as string] === row[c]));
  // Parents in the row's own tenant come up most often; others stay possible where the schema allows them.
  const own = fits.filter((d) => d.tenant === rowTenant);
  const candidates = [...own, ...own, ...fits];
  const n = candidates.length + (nullable ? 1 : 0);
  const parent = n ? candidates[pick % n] : undefined;
  if (!parent) {
    if (!nullable) return false;
    for (const c of unset) row[c] = null;
    return true;
  }
  fk.columns.forEach((c, i) => {
    if (row[c] === undefined) row[c] = parent.row[fk.references[i] as string];
  });
  return true;
}

/** Inserts the world's rows in foreign key order, in one transaction the caller commits. */
export async function insertWorld(client: pg.Client, tables: TableModel[], world: World, fixed: Fixed, existing: Inserted[] = []): Promise<Inserted[]> {
  // Rows already in the database that generated rows may point at (shared tables the run fills none of).
  const done: Inserted[] = [...existing];
  for (const t of tables) {
    // Keys to other tables before self-references (a parent row first, then a sibling under it),
    // keys through the tenant column first (they anchor the row in its tenant), and keys with
    // more columns first, so a composite key fixes its columns before a single one picks.
    const self = (fk: ForeignKeyModel) => (fk.schema === "public" && fk.table === t.name ? 1 : 0);
    const tenant = t.tenant;
    const anchored = (fk: ForeignKeyModel) => (tenant !== undefined && fk.columns.includes(tenant) ? 0 : 1);
    const fks = t.foreignKeys
      .map((fk, i) => ({ fk, i }))
      .sort((a, b) => self(a.fk) - self(b.fk) || anchored(a.fk) - anchored(b.fk) || b.fk.columns.length - a.fk.columns.length);
    let keyed = 0;
    for (const gene of world[t.name] ?? []) {
      const row: Record<string, unknown> = { ...gene.values };
      if (tenant !== undefined) row[tenant] = fixed.tenants[gene.tenant % fixed.tenants.length];
      // A required key through the tenant column, with no parent in the gene's tenant: the row
      // moves to a tenant that has one rather than being dropped, so small datasets still
      // reach the tables at the bottom of the tree.
      for (const { fk, i } of tenant === undefined ? [] : fks) {
        if (tenant === undefined || fk.schema !== "public" || self(fk) || !fk.columns.includes(tenant)) continue;
        if (!fk.columns.some((c) => c !== tenant && t.columns.find((x) => x.name === c)?.nullable === false)) continue;
        const parents = done.filter((d) => d.table === fk.table);
        if (parents.length && !parents.some((d) => d.tenant === row[tenant])) row[tenant] = parents[(gene.picks[i] ?? 0) % parents.length]?.tenant;
      }
      for (const pk of t.primaryKey) {
        const col = t.columns.find((c) => c.name === pk);
        if (col?.type === "uuid") row[pk] = prefixedUuid(fixed.prefix);
      }
      // The first rows take the keys run users hold in a claim (an org id), so rules comparing
      // them match; each key is tried once, so a refused one leaves the rest of the table alone.
      if (!fks.every(({ fk, i }) => resolve(fk, gene.picks[i] ?? 0, row, t, fixed, done))) continue;
      if (t.keyPool && keyed < t.keyPool.values.length) row[t.keyPool.column] = t.keyPool.values[keyed++];
      if (await insert(client, t.name, row)) done.push({ table: t.name, row, tenant: tenant === undefined ? undefined : row[tenant] });
    }
  }
  return done.slice(existing.length);
}

/** A table's columns pointing at auth.users on their own, and those of them a row must fill. */
function ownersOf(t: TableModel): { all: string[]; required: string[] } {
  const all = t.foreignKeys.filter((fk) => fk.schema === "auth" && fk.table === "users" && fk.columns.length === 1).map((fk) => fk.columns[0] as string);
  return { all, required: all.filter((c) => t.columns.find((x) => x.name === c)?.nullable === false) };
}

/**
 * Whether deleteRows can find a run's rows in the table: by a tenant column, by a
 * single-column key (the run's prefix), or by a required column pointing at auth.users.
 */
export function cleanable(t: TableModel): boolean {
  return t.tenant !== undefined || (t.primaryKey.length === 1 && t.primaryKey[0] !== undefined) || ownersOf(t).required.length > 0;
}

/**
 * Deletes the run's rows from `tables`, bypassing the append-only triggers: every row of
 * the run's tenants, or, for a table without a tenant column, every row whose primary key
 * carries the run's prefix (the generator gives uuid keys the prefix) or that points at one
 * of `users` (the run's users) through a key to auth.users, which also catches rows the
 * project's own triggers made for the run's rows.
 *
 * A table without a single key (user_roles keyed by user and role) is matched by its
 * required owner columns only: a row there whose only link to a run user is an optional
 * column (invited_by) is someone else's, and is kept, though it may then block deleting that
 * user. So are the tables in `ownedOnly`, which are not the run's own (cleanup reaches them),
 * where a row with several required owners goes only when every one is a run user. In the
 * run's own tables it goes when any is: a message a real user sent one, say, which would
 * otherwise block deleting that user. With `replica` false, the project's foreign keys,
 * cascades and triggers apply.
 */
export async function deleteRows(
  client: pg.Client,
  tables: TableModel[],
  prefix: string,
  users: string[] = [],
  options: { ownedOnly?: ReadonlySet<string>; replica?: boolean } = {},
): Promise<void> {
  await client.query("begin");
  try {
    if (options.replica !== false) await client.query("set local session_replication_role = replica");
    for (const t of [...tables].reverse()) {
      if (t.tenant !== undefined) {
        await client.query(`delete from public.${ident(t.name)} where ${ident(t.tenant)}::text like $1`, [`${prefix}%`]);
        continue;
      }
      const [key] = t.primaryKey;
      const keyed = t.primaryKey.length === 1 && key !== undefined;
      if (!cleanable(t)) throw new Error(`cannot tell the run's rows of ${t.name} apart: it has no tenant column, no single-column primary key and no required column pointing at auth.users`);
      const { all, required } = ownersOf(t);
      const outside = options.ownedOnly?.has(t.name) === true;
      const owners = keyed && !outside ? all : required;
      const params: unknown[] = [];
      // Beyond the run's tables, a row goes only when every owner it must have is a run user.
      const conds = [
        ...(keyed ? [`${ident(key)}::text like $${params.push(`${prefix}%`)}`] : []),
        ...(owners.length ? [owners.map((c) => `${ident(c)} = any($${params.length + 1}::uuid[])`).join(outside ? " and " : " or ")] : []),
      ];
      if (owners.length) params.push(users);
      await client.query(`delete from public.${ident(t.name)} where ${conds.join(" or ")}`, params);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}
