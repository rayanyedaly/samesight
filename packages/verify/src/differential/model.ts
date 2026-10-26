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
  /** From CHECK (col = ANY (ARRAY[...])) or CHECK (col IN (...)). */
  values?: string[];
  /** From CHECK (col ~ '...'). */
  pattern?: string;
  /** Literals the policy compares this column with. */
  hints: string[];
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
}

const literal = (s: string) => s.replace(/''/g, "'");

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

function ruleHints(rule: Rule, out: Map<string, Set<string>>): void {
  if (rule === true) return;
  const add = (column: string, v: unknown) => {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      if (!out.has(column)) out.set(column, new Set());
      out.get(column)?.add(String(v));
    }
  };
  switch (rule.kind) {
    case "eq":
      add(rule.column, rule.value);
      break;
    case "in":
      for (const v of rule.values) add(rule.column, v);
      break;
    case "and":
    case "or":
      for (const item of rule.items) ruleHints(item, out);
      break;
  }
}

/** A policy's tables, with the literals its rules compare each column with. */
export function policyTables(ir: IR): ScopeTable[] {
  return ir.tables.map((t) => {
    const hints = new Map<string, Set<string>>();
    for (const op of [t.read, t.insert, t.update, t.delete]) for (const rule of op.values()) ruleHints(rule, hints);
    if (t.check) ruleHints(t.check, hints);
    return { name: t.name, tenant: t.tenant, hints };
  });
}

export async function readModel(client: pg.Client, tables: ScopeTable[]): Promise<TableModel[]> {
  const names = tables.map((t) => t.name);
  const columns = await rows<{ table: string; name: string; type: string; nullable: boolean; has_default: boolean; computed: boolean; default_expr: string | null }>(
    client,
    `select c.relname as table, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
            a.atthasdef or a.attidentity = 'd' as has_default, (a.attidentity = 'a' or a.attgenerated <> '') as computed,
            pg_get_expr(d.adbin, d.adrelid) as default_expr
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
        const values = checks.find((k) => k.values)?.values;
        const pattern = checks.find((k) => k.pattern !== undefined)?.pattern;
        return {
          name: c.name,
          type: c.type,
          nullable: c.nullable,
          hasDefault: c.has_default,
          computed: c.computed,
          ...(values ? { values } : {}),
          ...(pattern !== undefined ? { pattern } : {}),
          hints: [...(hints.get(c.name) ?? [])],
        };
      });
    const primaryKey = mine.find((k) => k.type === "p")?.columns ?? ["id"];
    const foreignKeys: ForeignKeyModel[] = mine
      .filter((k) => k.type === "f" && k.ref_schema && k.ref_table && k.ref_columns)
      .map((k) => ({ columns: k.columns, schema: k.ref_schema ?? "", table: k.ref_table ?? "", references: k.ref_columns ?? [] }));
    // Left to its default, auth.uid() is null for the run's own inserts, and NOT NULL would
    // refuse every row; it is given one of the run's users, as a key to auth.users would be.
    for (const c of columns) {
      if (c.table !== t.name || c.type !== "uuid" || !/\bauth\.uid\(\)/.test(c.default_expr ?? "")) continue;
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
