/**
 * Renders one condition tree for both sides: Postgres RLS expressions and PowerSync
 * sync-stream SQL. Keeping both renderers side by side, case for case, is what keeps
 * them saying the same thing.
 */

import type { ConditionNode, Literal, Value } from "../policy.ts";

// Postgres reserved words that cannot be bare column names; anything else that is a
// lowercase identifier is left unquoted, as a person would write it.
const RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric both case cast check collate column " +
    "constraint create current_catalog current_date current_role current_time current_timestamp " +
    "current_user default deferrable desc distinct do else end except false fetch for foreign " +
    "from grant group having in initially intersect into lateral leading limit localtime " +
    "localtimestamp not null offset on only or order placing primary references returning " +
    "select session_user some symmetric system_user table then to trailing true union unique " +
    "user using variadic when where window with"
  ).split(" "),
);

/** A column or table name, double-quoted unless it is a plain lowercase identifier. */
export function ident(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/** Validated by the compiler: strings hold no quote, backslash or control character. */
export function literal(v: Literal): string {
  if (typeof v === "string") return `'${v}'`;
  return String(v);
}

const qualify = (q: string | undefined, column: string) => (q ? `${q}.${ident(column)}` : ident(column));

// RLS ----------------------------------------------------------------------------------------

export const RLS_USER = "(select auth.uid())";

function rlsValue(v: Value): string {
  return typeof v === "object" ? RLS_USER : literal(v);
}

/**
 * A condition as a Postgres expression. `q` qualifies column names (for subqueries).
 * A via reads the parent through a subquery, which Postgres runs under the caller's
 * own RLS on the parent: the child is visible exactly when its parent is.
 */
export function rls(node: ConditionNode, q?: string): string {
  switch (node.kind) {
    case "eq":
      return `${qualify(q, node.column)} = ${rlsValue(node.value)}`;
    case "in":
      return node.values.length === 1
        ? `${qualify(q, node.column)} = ${literal(node.values[0])}`
        : `${qualify(q, node.column)} in (${node.values.map(literal).join(", ")})`;
    case "isNull":
      return `${qualify(q, node.column)} is ${node.negate ? "not " : ""}null`;
    case "inRows": {
      const a = alias(node.rows.table, q);
      const where = node.rows.where ? ` where ${rls(node.rows.where, a)}` : "";
      return `${qualify(q, node.column)} in (select ${a}.${ident(node.rows.column)} from public.${ident(node.rows.table)} ${a}${where})`;
    }
    case "via": {
      const a = alias(node.parent, q);
      return `${qualify(q, node.column)} in (select ${a}.${ident(node.parentKey)} from public.${ident(node.parent)} ${a})`;
    }
    case "and":
    case "or":
      return node.items.map((item) => group(item, node.kind, rls(item, q))).join(` ${node.kind} `);
    case "raw":
      return `(${oneLine(node.rls)})`;
  }
}

/** A short alias for a subquery table that cannot shadow the outer one. */
function alias(table: string, outer?: string): string {
  const a = table.replace(/[^A-Za-z]/g, "").charAt(0).toLowerCase() || "t";
  return a === outer ? `${a}2` : a;
}

// Sync streams -------------------------------------------------------------------------------

export const SYNC_USER = "auth.user_id()";

function syncValue(v: Value): string {
  return typeof v === "object" ? SYNC_USER : literal(v);
}

/**
 * A condition in sync-stream SQL. Streams have no IN over a literal list, so a list is
 * an OR chain; a via is IN over the CTE named by `cte`.
 */
export function sync(node: ConditionNode, cte: (via: Extract<ConditionNode, { kind: "via" }>) => string): string {
  switch (node.kind) {
    case "eq":
      return `${ident(node.column)} = ${syncValue(node.value)}`;
    case "in":
      return node.values.length === 1
        ? `${ident(node.column)} = ${literal(node.values[0])}`
        : `(${node.values.map((v) => `${ident(node.column)} = ${literal(v)}`).join(" OR ")})`;
    case "isNull":
      return `${ident(node.column)} IS ${node.negate ? "NOT " : ""}NULL`;
    case "inRows":
      // The compiler refuses inRows in read rules, the only rules streams carry.
      throw new Error(`inRows on "${node.column}" cannot be expressed in a sync stream`);
    case "via":
      return `${ident(node.column)} IN ${cte(node)}`;
    case "and":
    case "or": {
      const op = node.kind === "and" ? "AND" : "OR";
      return node.items.map((item) => group(item, node.kind, sync(item, cte))).join(` ${op} `);
    }
    case "raw":
      return `(${oneLine(node.sync)})`;
  }
}

/** Parenthesizes an OR group inside an AND (and vice versa); leaves leaves alone. */
function group(item: ConditionNode, parent: "and" | "or", text: string): string {
  if ((item.kind === "and" || item.kind === "or") && item.kind !== parent) return `(${text})`;
  return text;
}

/**
 * Raw SQL on one line, so it can sit inside a YAML block scalar or a policy expression
 * whatever the author's formatting. The compiler refuses comments in raw rules, so
 * collapsing whitespace cannot change what the SQL means outside string literals.
 */
function oneLine(sql: string): string {
  return sql.trim().replace(/\s+/g, " ");
}
