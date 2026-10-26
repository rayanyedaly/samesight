/**
 * Whether a query's rows are limited by a value, not merely whether the value appears in
 * it. `owner_id = auth.user_id() OR true` reads the token and limits nothing;
 * `auth.user_id() IS NOT NULL` checks a token is there and limits nothing either.
 *
 * A query's conditions are its WHERE and each INNER JOIN's ON, all of which must hold. A
 * condition limits rows by a value when some AND term does, or every OR branch does; a
 * term does when it compares (= or IN) something with the value, or reads a stream CTE or
 * IN (SELECT ...) subquery whose own conditions do. NOT, and anything else, does not.
 * A comparison with a fixed value (auth.parameter('role') = 'admin') counts: it is a role
 * gate, which decides who gets the rows.
 *
 * For sync rules, each bucket parameter is traced to the token, the client, or the rows of
 * its parameter query (themselves limited by the token, the client or neither), and a data
 * query is per-user when a parameter from the token limits it.
 */

import { type Token, tokenize } from "../sync/sql.ts";
import { readsClient, readsToken } from "./sql.ts";

const word = (t: Token | undefined, w: string) => t?.kind === "word" && t.text === w;
const sym = (t: Token | undefined, s: string) => t?.kind === "symbol" && t.text === s;
const isName = (t: Token | undefined) => t?.kind === "word" || t?.kind === "quoted";

/** Index of the parenthesis closing the one opened at `open`, or -1. */
function closing(t: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    if (sym(t[i], "(")) depth++;
    else if (sym(t[i], ")") && --depth === 0) return i;
  }
  return -1;
}

/** Indices of tokens at parenthesis depth 0. */
function topLevel(t: Token[]): number[] {
  const out: number[] = [];
  let depth = 0;
  t.forEach((x, i) => {
    if (sym(x, "(")) depth++;
    else if (sym(x, ")")) depth--;
    else if (depth === 0) out.push(i);
  });
  return out;
}

function splitTop(t: Token[], at: (x: Token) => boolean): Token[][] {
  const cuts = topLevel(t).filter((i) => at(t[i] as Token));
  const parts: Token[][] = [];
  let start = 0;
  for (const c of cuts) {
    parts.push(t.slice(start, c));
    start = c + 1;
  }
  parts.push(t.slice(start));
  return parts.filter((p) => p.length);
}

/** Without parentheses that wrap the whole expression. */
function unwrap(t: Token[]): Token[] {
  let x = t;
  while (sym(x[0], "(") && closing(x, 0) === x.length - 1) x = x.slice(1, -1);
  return x;
}

const CLAUSE_END = new Set(["join", "inner", "left", "right", "full", "cross", "where", "group", "order", "limit", "union"]);
const OUTER = new Set(["left", "right", "full", "outer"]);

/**
 * The conditions a SELECT's rows must all meet: the WHERE, and the ON of each inner JOIN.
 * An outer join's ON keeps every row of the other side, so it limits nothing.
 */
export function conditions(t: Token[]): Token[][] {
  const top = topLevel(t);
  const from = top.find((i) => word(t[i], "from")) ?? 0;
  const out: Token[][] = [];
  for (const i of top.filter((i) => i > from && (word(t[i], "on") || word(t[i], "where")))) {
    if (word(t[i], "on")) {
      const join = top.filter((j) => j < i && word(t[j], "join")).at(-1);
      const before = join === undefined ? undefined : t[join - 1];
      if (before?.kind === "word" && OUTER.has(before.text)) continue;
    }
    const end = top.find((j) => j > i && CLAUSE_END.has(t[j]?.kind === "word" ? (t[j] as Token).text : "") && !(word(t[i], "where") && word(t[j], "where")));
    out.push(t.slice(i + 1, end ?? t.length));
  }
  return out.filter((c) => c.length);
}

/** A term that limits rows by itself, given the gate for plain comparisons. */
export type Gate = (term: Token[]) => boolean;

/** Whether a condition limits rows: some AND term, or every OR branch, passes the gate. */
export function limits(condition: Token[], gate: Gate): boolean {
  const c = unwrap(condition);
  const ors = splitTop(c, (x) => word(x, "or"));
  if (ors.length > 1) return ors.every((b) => limits(b, gate));
  const ands = splitTop(c, (x) => word(x, "and"));
  if (ands.length > 1) return ands.some((a) => limits(a, gate));
  if (word(c[0], "not")) return false;
  return gate(c);
}

/** Whether a query's rows are limited: any of its conditions does. */
export function queryLimits(t: Token[], gate: Gate): boolean {
  return conditions(t).some((c) => limits(c, gate));
}

/** Has = or IN at its own top level. */
const compares = (term: Token[]) => topLevel(term).some((i) => sym(term[i], "=") || word(term[i], "in"));

const LITERALS = new Set(["true", "false", "null"]);
const literal = (side: Token[]) => side.length > 0 && side.every((x) => x.kind === "string" || x.kind === "number" || x.kind === "symbol" || (x.kind === "word" && LITERALS.has(x.text)));

/** A comparison with a fixed value on one side: status = 'public', role IN ('a', 'b'). */
const fixed: Gate = (term) => {
  const at = topLevel(term).find((i) => sym(term[i], "=") || word(term[i], "in"));
  return at !== undefined && (literal(term.slice(0, at)) || literal(term.slice(at + 1)));
};

/** `a.x = b.y`: a join between two tables, which picks no rows by itself. */
const joins: Gate = (term) => {
  const at = topLevel(term).find((i) => sym(term[i], "="));
  if (at === undefined) return false;
  const qualifier = (side: Token[]) => (side.length === 3 && isName(side[0]) && sym(side[1], ".") && isName(side[2]) ? (side[0] as Token).text : undefined);
  const a = qualifier(term.slice(0, at));
  const b = qualifier(term.slice(at + 1));
  return a !== undefined && b !== undefined && a !== b;
};

/** Whether anything filters a query's rows, if only fixed values: a join does not count. */
export function filtered(sql: string, ctes: Map<string, string> = new Map()): boolean {
  const t = parse(sql);
  if (!t) return false;
  const parsed = new Map([...ctes].map(([name, s]) => [name.toLowerCase(), parse(s)]));
  const gate: Gate = through(
    (term) => compares(term) && !joins(term),
    (name) => (parsed.has(name) ? queryLimits(parsed.get(name) ?? [], gate) : undefined),
  );
  return queryLimits(t, gate);
}

/**
 * A gate that follows IN (SELECT ...) and IN cte into the rows they select, and asks
 * `base` of any other term. `cte` answers for a stream CTE's name, undefined for others.
 */
function through(base: Gate, cte: (name: string) => boolean | undefined): Gate {
  const gate: Gate = (term) => {
    for (const i of topLevel(term).filter((i) => word(term[i], "in"))) {
      const next = term[i + 1];
      if (sym(next, "(") && word(term[i + 2], "select")) {
        const end = closing(term, i + 1);
        return queryLimits(term.slice(i + 2, end === -1 ? term.length : end), gate);
      }
      const named = isName(next) ? cte((next as Token).text.toLowerCase()) : undefined;
      if (named !== undefined) return named;
    }
    return base(term);
  };
  return gate;
}

/** The gate for a value: a comparison involving it, followed through CTEs and subqueries. */
export function valueGate(reads: (term: Token[]) => boolean, cte: (name: string) => boolean | undefined = () => undefined): Gate {
  return through((term) => compares(term) && reads(term), cte);
}

const readsAny = (term: Token[]) => readsToken(term) || readsClient(term);

/** How a stream query's rows are limited: by the token, by the token or the client. */
export function streamAccess(sql: string, ctes: Map<string, string>): { token: boolean; tokenOrClient: boolean } | null {
  const t = parse(sql);
  if (!t) return null;
  const cteLimits = (reads: (term: Token[]) => boolean) => {
    const parsed = new Map([...ctes].map(([name, s]) => [name.toLowerCase(), parse(s)]));
    return (name: string) => (parsed.has(name) ? queryLimits(parsed.get(name) ?? [], valueGate(reads)) : undefined);
  };
  return {
    token: queryLimits(t, valueGate(readsToken, cteLimits(readsToken))),
    tokenOrClient: queryLimits(t, valueGate(readsAny, cteLimits(readsAny))),
  };
}

export type Source = "token" | "client" | "rows";

export interface ParameterQuery {
  /** Each bucket parameter it gives, and where its value comes from. */
  parameters: Map<string, Source>;
  /** What limits the rows it selects, when it reads a table. */
  rows: "token" | "client" | "nothing";
}

/** Where each bucket parameter of a sync rules parameter query comes from. */
export function parameterQuery(sql: string): ParameterQuery | null {
  const t = parse(sql);
  if (!t) return null;
  const end = topLevel(t).find((i) => word(t[i], "from") || word(t[i], "where"));
  const items = splitTop(t.slice(1, end ?? t.length), (x) => sym(x, ","));
  const parameters = new Map<string, Source>();
  for (const item of items) {
    const as = topLevel(item).find((i) => word(item[i], "as"));
    const name = as !== undefined ? item[as + 1] : item.at(-1);
    if (!isName(name)) continue;
    parameters.set((name as Token).text.toLowerCase(), readsToken(item) ? "token" : readsClient(item) ? "client" : "rows");
  }
  const rows = queryLimits(t, valueGate(readsToken)) ? "token" : queryLimits(t, valueGate(readsAny)) ? "client" : "nothing";
  return { parameters, rows };
}

/** Whether a bucket parameter's value is the requesting user's own (token) or the client's. */
export function parameterSource(p: ParameterQuery, name: string): "token" | "client" | "nobody" {
  const source = p.parameters.get(name);
  if (source === "token" || (source === "rows" && p.rows === "token")) return "token";
  if (source === "client" || (source === "rows" && p.rows === "client")) return "client";
  return "nobody";
}

/** The bucket parameters a term reads: bucket.x. */
function bucketNames(term: Token[]): string[] {
  return term.flatMap((x, i) => (word(x, "bucket") && sym(term[i + 1], ".") && isName(term[i + 2]) ? [(term[i + 2] as Token).text.toLowerCase()] : []));
}

/** Whether a data query's rows are limited by bucket parameters that `accept` takes. */
export function dataLimitedBy(sql: string, accept: (name: string) => boolean): boolean {
  const t = parse(sql);
  return t !== null && queryLimits(t, (term) => compares(term) && bucketNames(term).some(accept));
}

export interface BucketAccess {
  /** Parameter queries whose bucket parameters, as the data queries use them, are not the user's own. */
  loose: { label: string; sql: string; via: "client" | "nobody" }[];
  /** Data queries no bucket parameter limits: every user the bucket reaches gets all their rows. */
  open: { label: string; sql: string }[];
  /** Every parameter query admits only users who pass a fixed check, such as a role. */
  roleGated: boolean;
}

/**
 * How a sync rules bucket's rows reach users. A data query limited by bucket parameters is
 * per-user under a parameter query when one the token decides limits it; when only client
 * values, or nobody's, do, that parameter query is loose. Unreadable queries are left out.
 */
export function bucketAccess(parameters: Map<string, string>, data: { label: string; sql: string }[]): BucketAccess {
  const params = [...parameters].map(([label, sql]) => ({ label, sql, p: parameterQuery(sql) }));
  const readable = data.filter((d) => parse(d.sql) !== null);
  const bound = readable.filter((d) => dataLimitedBy(d.sql, () => true));
  const loose: BucketAccess["loose"] = [];
  for (const { label, sql, p } of params) {
    if (!p) continue;
    const failing = bound.filter((d) => !dataLimitedBy(d.sql, (n) => parameterSource(p, n) === "token"));
    if (!failing.length) continue;
    const client = failing.every((d) => dataLimitedBy(d.sql, (n) => parameterSource(p, n) !== "nobody"));
    loose.push({ label, sql, via: client ? "client" : "nobody" });
  }
  const roleGated =
    params.length > 0 &&
    params.every(({ sql, p }) => {
      const t = parse(sql);
      return p?.rows === "token" && t !== null && queryLimits(t, fixed);
    });
  return { loose, open: readable.filter((d) => !bound.includes(d)), roleGated };
}

function parse(sql: string): Token[] | null {
  try {
    return tokenize(sql);
  } catch {
    return null;
  }
}
