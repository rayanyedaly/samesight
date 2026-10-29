/**
 * What a sync query sends to devices, column by column. PowerSync sends exactly what a data
 * query selects: * sends every column, AS names the column on the device, and an expression
 * sends its value (a json column whole, unless -> or ->> picks a key out). The exposure map
 * and the personal-columns rule start from this. The table is outputTable's, so a query it
 * refuses is refused here too, with its message.
 */

import { closing, isName, splitTop, sym, topLevel, unwrap, word } from "../lint/tokens.ts";
import { outputTable } from "./scope.ts";
import { sqlText, type Token, tokenize } from "./sql.ts";

export interface SentColumn {
  /**
   * The column's name on the device: the AS name, else the column's own name. An expression
   * with neither is named after its text, as PowerSync's streams compiler names it.
   */
  name: string;
  /** The output table's columns the value is read from, lowercased unless quoted (as Token text is): ["email"] for email, lower(email) or email::text; [] for a literal. */
  from: string[];
  /** Anything but a bare column, optionally cast: lower(email), a || b, data ->> 'phone', a literal. */
  derived: boolean;
  /** JSON keys read with -> or ->>, in order: data ->> 'phone' gives ["phone"]. Only keys written as strings. */
  jsonKeys: string[];
}

export interface QueryColumns {
  /** outputTable's table and deviceTable. */
  table: string;
  deviceTable: string;
  /** SELECT * or SELECT t.* (of the output table): every column of the table is sent, besides any listed. */
  star: boolean;
  /** The listed items, in order (not including the star). */
  columns: SentColumn[];
}

/** Words that are never a column, unless after a dot: CASE's, operators', literals, CAST's AS, substring's FROM and FOR. */
const KEYWORDS = new Set(["case", "when", "then", "else", "end", "and", "or", "not", "null", "true", "false", "as", "is", "in", "like", "distinct", "between", "from", "for"]);
/** Keywords an expression can end with, so a name after one is an alias: CASE ... END kind. */
const ENDS = new Set(["end", "null", "true", "false"]);

const keyword = (t: Token | undefined) => t?.kind === "word" && KEYWORDS.has(t.text);

/** The index after the parenthesis closing the one at `open`, or the end when none does. */
function after(t: Token[], open: number): number {
  const close = closing(t, open);
  return close === -1 ? t.length : close + 1;
}

/**
 * The index just past the type a cast names at `i` (text, varchar(10), double precision,
 * timestamp with time zone), or `i` when no type is there.
 */
function typeEnd(t: Token[], i: number): number {
  if (!isName(t[i])) return i;
  let j = i + 1;
  while (word(t[j], "precision") || word(t[j], "varying")) j++;
  if (sym(t[j], "(")) j = after(t, j);
  if ((word(t[j], "with") || word(t[j], "without")) && word(t[j + 1], "time") && word(t[j + 2], "zone")) j += 3;
  return j;
}

/** Index of the last top-level :: in `t`. */
const lastCast = (t: Token[]) => topLevel(t).filter((i) => sym(t[i], "::")).at(-1);

/**
 * An item's expression and the name it gives it: `x AS name`, or Postgres's implicit alias,
 * a name right after a whole expression (`lower(email) e`, `CASE ... END kind`).
 */
function named(item: Token[]): { expr: Token[]; alias?: string } {
  const as = topLevel(item).find((i) => word(item[i], "as"));
  if (as !== undefined) return { expr: item.slice(0, as), alias: isName(item[as + 1]) ? (item[as + 1] as Token).text : undefined };
  const last = item.at(-1);
  const prev = item.at(-2);
  // What comes before the name must end an expression: not an operator, a dot, or a keyword
  // that wants an operand; and the name must not be the last word of a cast's type.
  const ended = sym(prev, ")") || (prev !== undefined && prev.kind !== "symbol" && !(keyword(prev) && !ENDS.has(prev.text)));
  const cast = lastCast(item);
  if (isName(last) && !keyword(last) && ended && !(cast !== undefined && typeEnd(item, cast + 1) === item.length)) {
    return { expr: item.slice(0, -1), alias: (last as Token).text };
  }
  return { expr: item };
}

/** `*`, or `t.*`: outputTable has made sure t is the output table's alias. */
const isStar = (x: Token[]) => (x.length === 1 && sym(x[0], "*")) || (x.length === 3 && isName(x[0]) && sym(x[1], ".") && sym(x[2], "*"));

/** The column a bare `c` or `t.c` reads, in parentheses or not. */
function column(expr: Token[]): Token | undefined {
  const x = unwrap(expr);
  if (x.length === 1 && isName(x[0]) && !keyword(x[0])) return x[0];
  if (x.length === 3 && isName(x[0]) && sym(x[1], ".") && isName(x[2])) return x[2];
  return undefined;
}

/** Whether an expression is a bare column, cast or not: c, t.c, c::text, CAST(c AS text). */
function plain(expr: Token[]): boolean {
  const x = unwrap(expr);
  if (column(x)) return true;
  const cast = lastCast(x);
  if (cast !== undefined) return isName(x[cast + 1]) && typeEnd(x, cast + 1) === x.length && plain(x.slice(0, cast));
  if (word(x[0], "cast") && sym(x[1], "(") && closing(x, 1) === x.length - 1) {
    const inner = x.slice(2, -1);
    const as = topLevel(inner).find((i) => word(inner[i], "as"));
    return as !== undefined && isName(inner[as + 1]) && typeEnd(inner, as + 1) === inner.length && plain(inner.slice(0, as));
  }
  return false;
}

/** The output table's columns an expression reads, without their qualifier, and the JSON keys it picks out. */
function reads(expr: Token[], alias: string): { from: string[]; jsonKeys: string[] } {
  const from = new Set<string>();
  const jsonKeys: string[] = [];
  for (let i = 0; i < expr.length; i++) {
    const t = expr[i] as Token;
    const next = expr[i + 1];
    if (sym(t, "(") && word(next, "select")) {
      // A subquery's names are its own tables' columns (and PowerSync refuses one here).
      i = after(expr, i) - 1;
    } else if (sym(t, "::") || word(t, "as")) {
      // A cast's type, after :: or inside CAST(x AS type): the item's own AS is already cut off.
      i = typeEnd(expr, i + 1) - 1;
    } else if ((sym(t, "->") || sym(t, "->>")) && next?.kind === "string") {
      jsonKeys.push(next.text);
    } else if (isName(t) && sym(next, ".")) {
      // outputTable refuses any other qualifier, and any column of another table in a join.
      if (t.text !== alias) throw new Error(`reads ${t.text}.${expr[i + 2]?.text}, not a column of ${alias}`);
    } else if (isName(t) && !sym(next, "(") && (sym(expr[i - 1], ".") || !keyword(t))) {
      // Not a function's name; a keyword only after a dot (t.end), where it is a column.
      from.add(t.text);
    }
  }
  return { from: [...from], jsonKeys };
}

/**
 * The columns a sync query sends, as devices get them. Throws exactly when outputTable does,
 * with its message.
 */
export function sentColumns(sql: string): QueryColumns {
  const { table, deviceTable } = outputTable(sql);
  const t = tokenize(sql);
  // outputTable has found this top-level FROM.
  const from = topLevel(t).find((i) => word(t[i], "from")) as number;
  // DISTINCT, DISTINCT ON (...) and ALL pick rows, not columns.
  let start = 1;
  if (word(t[1], "all")) start = 2;
  else if (word(t[1], "distinct")) start = word(t[2], "on") && sym(t[3], "(") ? after(t, 3) : 2;
  let star = false;
  const columns: SentColumn[] = [];
  for (const item of splitTop(t.slice(start, from), (x) => sym(x, ","))) {
    const { expr, alias } = named(item);
    if (isStar(expr)) {
      star = true;
      continue;
    }
    const read = reads(expr, deviceTable);
    // Without AS, a bare column keeps its name. PowerSync's streams compiler (edition 3) names
    // anything else after its text as written, and warns; sync rules refuse it ("alias is
    // required"). This is that text in canonical spelling.
    columns.push({ name: alias ?? column(expr)?.text ?? sqlText(expr), from: read.from, derived: !plain(expr), jsonKeys: read.jsonKeys });
  }
  return { table, deviceTable, star, columns };
}
