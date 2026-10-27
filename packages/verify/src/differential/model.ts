/**
 * What the data generator needs to know about each table of the run, read from the live
 * database: columns, foreign keys (auth.users ones included, and uuid columns defaulting to
 * auth.uid(), which hold a user as surely as a key would), the value lists and
 * patterns of single-column check constraints, and the literals the rules compare
 * columns with, so generated rows land on both sides of every rule.
 */

import type pg from "pg";
import type { IR, Rule } from "samesight/compiler";
import { rows } from "../db.ts";

export interface ColumnModel {
  name: string;
  /** format_type(), e.g. "uuid", "text", "timestamp with time zone". */
  type: string;
  nullable: boolean;
  hasDefault: boolean;
  /** Generated, or identity ALWAYS: no one can write it (identity BY DEFAULT counts as a default). */
  computed: boolean;
  /** An identity or serial key: left to its sequence, which a generated value would collide with. */
  autoKey?: boolean;
  /** From CHECK (col = ANY (ARRAY[...])) or CHECK (col IN (...)), or the labels of an enum type. */
  values?: string[];
  /** From CHECK (col ~ '...'). */
  pattern?: string;
  /** Literals the policy compares this column with. */
  hints: string[];
  /** Values run users hold in a claim the rules compare this column with (audit): drawn often. */
  claimValues?: unknown[];
}

export interface ForeignKeyModel {
  columns: string[];
  schema: string;
  table: string;
  references: string[];
}

/** A table the run covers: its tenant column, if it has one, and literals its rules compare columns with. */
export interface ScopeTable {
  name: string;
  tenant?: string;
  hints?: Map<string, Set<string>>;
  /** Columns a rule compares with the signed-in user: they get the run's users as values. */
  userColumns?: Set<string>;
  /** Per column, values run users hold in a claim a rule compares the column with. */
  claimValues?: Map<string, unknown[]>;
  /** A key column whose first generated rows take these values, one each: keys run users hold in a claim. */
  keyPool?: { column: string; values: unknown[] };
}

/**
 * Literals a piece of SQL compares columns with, and the columns it compares with the
 * signed-in user (auth.uid() in RLS, auth.user_id() or request.user_id() in streams). Read
 * from pg_policies and stream queries in audit mode, and from raw rules: without them the
 * generator would only produce random values, and a branch like `visibility = 'public'`
 * would never see a row on either side of it. A heuristic: names are not tied to tables,
 * so a hint applies to every table with that column.
 */
export function sqlHints(sql: string): { hints: Map<string, Set<string>>; users: Set<string> } {
  const hints = new Map<string, Set<string>>();
  const users = new Set<string>();
  // The column name alone: unquoted, without a table or alias in front.
  const bare = (column: string) => column.replace(/^.*\./, "").replace(/^"(.*)"$/, "$1");
  const add = (column: string, v: string) => {
    const key = bare(column);
    if (!hints.has(key)) hints.set(key, new Set());
    hints.get(key)?.add(v);
  };
  const name = String.raw`((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)`;
  const value = String.raw`(?:'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|(true|false))(?:::[\w ]+)?`;
  const pick = (m: RegExpMatchArray, i: number) => (m[i] !== undefined ? literal(m[i]) : m[i + 1] ?? m[i + 2]);
  for (const m of sql.matchAll(new RegExp(`${name}\\s*(?:=|<>|!=)\\s*${value}`, "gi"))) add(m[1] ?? "", String(pick(m, 2)));
  for (const m of sql.matchAll(new RegExp(`${value}\\s*(?:=|<>|!=)\\s*${name}`, "gi"))) add(m[4] ?? "", String(pick(m, 1)));
  for (const m of sql.matchAll(new RegExp(`${name}\\s+(?:not\\s+)?in\\s*\\(([^()]*)\\)`, "gi"))) {
    for (const v of (m[2] ?? "").matchAll(/'((?:[^']|'')*)'/g)) add(m[1] ?? "", literal(v[1] ?? ""));
  }
  const user = String.raw`\(?\s*(?:select\s+)?(?:auth\.uid|auth\.user_id|request\.user_id)\s*\(\s*\)\s*\)?`;
  for (const m of sql.matchAll(new RegExp(`${name}\\s*=\\s*${user}`, "gi"))) users.add(bare(m[1] ?? ""));
  for (const m of sql.matchAll(new RegExp(`${user}\\s*=\\s*${name}`, "gi"))) users.add(bare(m[1] ?? ""));
  return { hints, users };
}

export interface TableModel {
  name: string;
  /** Absent outside a Samesight policy (audit mode), where rows belong to users, not tenants. */
  tenant?: string;
  primaryKey: string[];
  /** Columns with a single-column unique constraint or index (the primary key included). */
  unique: string[];
  columns: ColumnModel[];
  foreignKeys: ForeignKeyModel[];
  /** The first generated rows take these keys, one each (see ScopeTable.keyPool). */
  keyPool?: { column: string; values: unknown[] };
}

const literal = (s: string) => s.replace(/''/g, "'");

/**
 * A CHECK pattern as a JavaScript RegExp, or undefined when it uses Postgres-only syntax that
 * JavaScript reads differently ([[:alpha:]], \\m, \\y, embedded options) or cannot run at all.
 */
export function jsPattern(pattern: string): RegExp | undefined {
  if (/\[\[:|\\[mMyYAZ]|\(\?|^\*\*\*/.test(pattern)) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

/** The value list or pattern of a single-column check constraint, if it is one this reads. */
export function parseCheck(def: string): { values?: string[]; pattern?: string } {
  const list = /^CHECK \(\(\(?"?[^"]+"?\)? = ANY \(\(?ARRAY\[(.+)\]\)?(?:::[\w\s[\]]+)?\)\)\)$/.exec(def);
  if (list?.[1]) {
    const values = [...list[1].matchAll(/'((?:[^']|'')*)'(?:::[\w\s]+)?/g)].map((m) => literal(m[1] ?? ""));
    if (values.length) return { values };
  }
  const pattern = /^CHECK \(\("?[^"]+"? ~ '((?:[^']|'')*)'(?:::text)?\)\)$/.exec(def);
  if (pattern?.[1] !== undefined) return { pattern: literal(pattern[1]) };
  return {};
}

function ruleHints(rule: Rule, out: Map<string, Set<string>>, users: Set<string>): void {
  if (rule === true) return;
  const add = (column: string, v: unknown) => {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      if (!out.has(column)) out.set(column, new Set());
      out.get(column)?.add(String(v));
    }
  };
  switch (rule.kind) {
    case "eq":
      if (typeof rule.value === "object") users.add(rule.column);
      else add(rule.column, rule.value);
      break;
    case "in":
      for (const v of rule.values) add(rule.column, v);
      break;
    case "and":
    case "or":
      for (const item of rule.items) ruleHints(item, out, users);
      break;
    case "raw": {
      const found = sqlHints(rule.rls);
      for (const [column, values] of found.hints) for (const v of values) add(column, v);
      for (const u of found.users) users.add(u);
      break;
    }
  }
}

/** A policy's tables, with the literals its rules compare each column with. */
export function policyTables(ir: IR): ScopeTable[] {
  return ir.tables.map((t) => {
    const hints = new Map<string, Set<string>>();
    const userColumns = new Set<string>();
    for (const op of [t.read, t.insert, t.update, t.delete]) for (const rule of op.values()) ruleHints(rule, hints, userColumns);
    if (t.check) ruleHints(t.check, hints, userColumns);
    return { name: t.name, ...(t.tenant !== null ? { tenant: t.tenant } : {}), hints, userColumns };
  });
}

export async function readModel(client: pg.Client, tables: ScopeTable[]): Promise<TableModel[]> {
  const names = tables.map((t) => t.name);
  const columns = await rows<{
    table: string;
    name: string;
    type: string;
    nullable: boolean;
    has_default: boolean;
    computed: boolean;
    identity: boolean;
    default_expr: string | null;
    labels: string[] | null;
  }>(
    client,
    `select c.relname as table, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
            a.atthasdef or a.attidentity = 'd' as has_default, (a.attidentity = 'a' or a.attgenerated <> '') as computed,
            a.attidentity <> '' as identity, pg_get_expr(d.adbin, d.adrelid) as default_expr,
            (select array_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = a.atttypid)::text[] as labels
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = 'public' and c.relname = any($1) and a.attnum > 0 and not a.attisdropped
      order by c.relname, a.attnum`,
    [names],
  );
  const constraints = await rows<{ table: string; type: string; def: string; columns: string[]; ref_schema: string | null; ref_table: string | null; ref_columns: string[] | null }>(
    client,
    `select c.relname as table, k.contype as type, pg_get_constraintdef(k.oid) as def,
            array(select a.attname from unnest(k.conkey) with ordinality u(n, i)
                    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.i)::text[] as columns,
            rn.nspname as ref_schema, r.relname as ref_table,
            case when k.contype = 'f' then array(select a.attname from unnest(k.confkey) with ordinality u(n, i)
                    join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n order by u.i)::text[] end as ref_columns
       from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
       left join pg_class r on r.oid = k.confrelid left join pg_namespace rn on rn.oid = r.relnamespace
      where n.nspname = 'public' and c.relname = any($1) and k.contype in ('c', 'f', 'p')
      order by c.relname, k.conname`,
    [names],
  );

  const unique = await rows<{ table: string; column: string }>(
    client,
    `select c.relname as table, a.attname as column
       from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where n.nspname = 'public' and c.relname = any($1) and i.indisunique and i.indnatts = 1 and i.indpred is null`,
    [names],
  );
  return tables.map((t) => {
    const hints = t.hints ?? new Map<string, Set<string>>();
    const mine = constraints.filter((k) => k.table === t.name);
    const cols: ColumnModel[] = columns
      .filter((c) => c.table === t.name)
      .map((c) => {
        const checks = mine.filter((k) => k.type === "c" && k.columns.length === 1 && k.columns[0] === c.name).map((k) => parseCheck(k.def));
        const values = checks.find((k) => k.values)?.values ?? (c.labels?.length ? c.labels : undefined);
        const pattern = checks.find((k) => k.pattern !== undefined)?.pattern;
        return {
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          hasDefault: c.has_default,
          computed: c.computed,
          ...(c.identity || /^nextval\(/.test(c.default_expr ?? "") ? { autoKey: true } : {}),
          ...(values ? { values } : {}),
          ...(pattern !== undefined ? { pattern } : {}),
          hints: [...(hints.get(c.name) ?? [])],
          ...(t.claimValues?.get(c.name)?.length ? { claimValues: t.claimValues.get(c.name) } : {}),
        };
      });
    const primaryKey = mine.find((k) => k.type === "p")?.columns ?? ["id"];
    const foreignKeys: ForeignKeyModel[] = mine
      .filter((k) => k.type === "f" && k.ref_schema && k.ref_table && k.ref_columns)
      .map((k) => ({ columns: k.columns, schema: k.ref_schema ?? "", table: k.ref_table ?? "", references: k.ref_columns ?? [] }));
    // Left to its default, auth.uid() is null for the run's own inserts, and NOT NULL would
    // refuse every row; it is given one of the run's users, as a key to auth.users would be.
    // So is a column a rule compares with the signed-in user: a random uuid never matches one.
    for (const c of columns) {
      if (c.table !== t.name || c.type !== "uuid") continue;
      if (!/\bauth\.uid\(\)/.test(c.default_expr ?? "") && !t.userColumns?.has(c.name)) continue;
      if (foreignKeys.some((fk) => fk.columns.includes(c.name)) || primaryKey.includes(c.name)) continue;
      foreignKeys.push({ columns: [c.name], schema: "auth", table: "users", references: ["id"] });
    }
    return {
      name: t.name,
      ...(t.tenant !== undefined ? { tenant: t.tenant } : {}),
      primaryKey,
      unique: unique.filter((u) => u.table === t.name).map((u) => u.column),
      columns: cols,
      foreignKeys,
      ...(t.keyPool ? { keyPool: t.keyPool } : {}),
    };
  });
}

/** Policy tables in an order where every foreign key points backwards (self-references aside). */
export function insertOrder(tables: TableModel[]): TableModel[] {
  const done = new Set<string>();
  const out: TableModel[] = [];
  const pending = [...tables];
  while (pending.length) {
    const i = pending.findIndex((t) =>
      t.foreignKeys.every((fk) => fk.schema !== "public" || fk.table === t.name || done.has(fk.table) || !tables.some((x) => x.name === fk.table)),
    );
    if (i < 0) throw new Error(`foreign keys form a cycle among ${pending.map((t) => t.name).join(", ")}`);
    const [t] = pending.splice(i, 1);
    if (!t) break;
    done.add(t.name);
    out.push(t);
  }
  return out;
}
