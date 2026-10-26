/**
 * Whether a query's rows are limited by a value, not merely whether the value appears in
 * it. `owner_id = auth.user_id() OR true` reads the token and limits nothing;
 * `auth.user_id() IS NOT NULL` checks a token is there and limits nothing either.
 *
 * A query's conditions are its WHERE and each INNER JOIN's ON, all of which must hold. A
 * condition limits rows by a value when some AND term does, or every OR branch does; a
 * term does when it compares (= or IN) a row with the value, or reads a stream CTE or
 * IN (SELECT ...) subquery whose own conditions do. NOT, and anything else, does not. The
 * value compared with a literal or with itself picks no row by who is asking: a token claim
 * against a literal (a role) is a claim check, which rules report apart, and a claim every
 * ordinary signed-in Supabase user passes (role or aud = 'authenticated', is_anonymous =
 * false) checks nothing.
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
    const end = top.find((j) => j > i && CLAUSE_END.has(t[j]?.kind === "word" ? (t[j] as Token).text : "") && !sym(t[j + 1], "(") && !(word(t[i], "where") && word(t[j], "where")));
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

/** IN, and not NOT IN, which keeps every row but some. */
const isIn = (t: Token[], i: number) => word(t[i], "in") && !word(t[i - 1], "not");

/** The two sides of a term's top-level = or IN; undefined when it has neither. */
function sides(term: Token[]): [Token[], Token[]] | undefined {
  const at = topLevel(term).find((i) => sym(term[i], "=") || isIn(term, i));
  return at === undefined ? undefined : [term.slice(0, at), term.slice(at + 1)];
}

const LITERALS = new Set(["true", "false", "null"]);
/**
 * A fixed value: a side that names no column and reads no token or client value. 'a', 1,
 * true, ('a', 'b'), 'a'::text, CAST('a' AS text), lower('A'): its words are only literals,
 * function names, type names and CAST's AS.
 */
function literal(side: Token[]): boolean {
  if (!side.length || readsAny(side)) return false;
  return side.every((t, i) => {
    if (t.kind === "quoted") return false;
    if (t.kind !== "word") return true;
    return LITERALS.has(t.text) || t.text === "cast" || t.text === "as" || sym(side[i + 1], "(") || sym(side[i - 1], "::") || word(side[i - 1], "as");
  });
}

function readsAny(term: Token[]): boolean {
  return readsToken(term) || readsClient(term);
}

/**
 * A row compared with a value `reads` finds: owner_id = auth.user_id(). The value compared
 * with a literal, with itself or with another token or client value picks no row: any
 * client can send its own user id as a parameter.
 */
const matches =
  (reads: (t: Token[]) => boolean): Gate =>
  (term) => {
    const s = sides(term);
    return s !== undefined && s.some((side, i) => reads(side) && !literal(s[1 - i] as Token[]) && !reads(s[1 - i] as Token[]) && !readsAny(s[1 - i] as Token[]));
  };

/** A fixed value on exactly one side: status = 'public', role IN ('a', 'b'). */
const fixed: Gate = (term) => {
  const s = sides(term);
  return s !== undefined && literal(s[0]) !== literal(s[1]);
};

/** A column alone as a condition: users.is_admin. Not `true`. */
const flag: Gate = (term) =>
  (term.length === 1 && isName(term[0]) && !LITERALS.has((term[0] as Token).text)) || (term.length === 3 && isName(term[0]) && sym(term[1], ".") && isName(term[2]));

/** Claims every ordinary signed-in Supabase user's token carries, with the value they all have. */
const EVERY_TOKEN: [RegExp, Set<string>][] = [
  [/^(\$\.)?(role|aud)$/, new Set(["authenticated"])],
  [/^(\$\.)?is_anonymous$/, new Set(["false"])],
];

/** A check every ordinary signed-in Supabase user passes: role or aud = 'authenticated', is_anonymous = false. */
export const everyToken: Gate = (term) => {
  const s = sides(term);
  if (!s || !readsToken(term)) return false;
  return EVERY_TOKEN.some(([claim, values]) => topClaim(term, claim) && s.some((side) => literal(side) && side.some((x) => (x.kind === "string" || x.kind === "word") && values.has(x.text))));
};

/**
 * Whether a term reads a top-level claim of the token by that name: auth.parameter('role'),
 * auth.parameters() ->> 'role', request.jwt() ->> 'role', or the path '$.role'. Not
 * app_metadata ->> 'role', which the app sets.
 */
function topClaim(t: Token[], claim: RegExp): boolean {
  return t.some((x, i) => {
    if (x.kind !== "string" || !claim.test(x.text)) return false;
    if (x.text.startsWith("$.")) return true;
    if (sym(t[i - 1], "(") && word(t[i - 2], "parameter")) return true;
    return (sym(t[i - 1], "->>") || sym(t[i - 1], "->")) && sym(t[i - 2], ")") && sym(t[i - 3], "(") && (word(t[i - 4], "parameters") || word(t[i - 4], "jwt"));
  });
}

/** A token claim checked against a fixed value, such as a role, that not every token passes. */
const claimCheck: Gate = (term) => fixed(term) && readsToken(term) && !readsClient(term) && !everyToken(term);

/**
 * A gate that follows IN (SELECT ...) and IN cte into the rows they select, and asks
 * `base` of any other term. `cte` answers for a stream CTE's name, undefined for others.
 * The token on the left (auth.user_id() IN (SELECT user_id FROM admins)) checks who is
 * asking, not which rows: it counts only for a gate that takes checks (`checks`).
 */
function through(base: Gate, cte: (name: string) => boolean | undefined, checks = false): Gate {
  const gate: Gate = (term) => {
    for (const i of topLevel(term).filter((i) => isIn(term, i))) {
      const next = term[i + 1];
      const set = sym(next, "(") && word(term[i + 2], "select");
      const named = !set && isName(next) ? cte((next as Token).text.toLowerCase()) : undefined;
      if (!set && named === undefined) continue;
      // Not a row on the left (the token, a client value, 'admin'): a check on who is asking.
      const left = term.slice(0, i);
      if (readsAny(left) || literal(left)) return checks;
      if (named !== undefined) return named;
      const end = closing(term, i + 1);
      const sub = term.slice(i + 2, end === -1 ? term.length : end);
      // A subquery that reads a CTE: SELECT org_id FROM mine.
      const from = topLevel(sub).find((j) => word(sub[j], "from"));
      const source = from !== undefined && isName(sub[from + 1]) ? cte((sub[from + 1] as Token).text.toLowerCase()) : undefined;
      return source === true || queryLimits(sub, gate);
    }
    return base(term);
  };
  return gate;
}

/** Whether `base` limits a query's rows, followed through its stream CTEs and subqueries. */
function limitedBy(t: Token[], ctes: Map<string, string>, base: Gate, checks = false): boolean {
  const parsed = new Map([...ctes].map(([name, s]) => [name.toLowerCase(), parse(s)]));
  // A CTE that reads itself, directly or round a loop, limits nothing the second time.
  const open = new Set<string>();
  const cte = (name: string) => {
    if (!parsed.has(name)) return undefined;
    if (open.has(name)) return false;
    open.add(name);
    try {
      return queryLimits(parsed.get(name) ?? [], gate);
    } finally {
      open.delete(name);
    }
  };
  const gate: Gate = through(base, cte, checks);
  return queryLimits(t, gate);
}

/** The gate for a value: a row compared with it, followed through subqueries. */
export function valueGate(reads: (term: Token[]) => boolean): Gate {
  return through(matches(reads), () => undefined);
}

/**
 * A row's own column against a fixed value, or a row compared with a token or client value.
 * A token or client value against a literal checks who is asking, not which rows.
 */
const filters: Gate = (term) => (fixed(term) && !readsAny(term)) || matches(readsAny)(term);

/** Whether anything filters a query's rows: a fixed value or a row compared with a value. A join does not. */
export function filtered(sql: string, ctes: Map<string, string> = new Map()): boolean {
  const t = parse(sql);
  return t !== null && limitedBy(t, ctes, filters);
}

export interface StreamAccess {
  /** A row compared with a token value limits it: each user gets their own. */
  token: boolean;
  /** A row compared with a token or client value limits it. */
  tokenOrClient: boolean;
  /** A per-user comparison, or a check on who is asking (a role claim, membership of a list) limits it. */
  claim: boolean;
  /** Anything filters it, fixed values included. */
  filtered: boolean;
  /** Each OR branch is a filter or a check on who is asking: public rows for all, every row for admins. */
  filteredOrClaim: boolean;
}

/** How a stream query's rows are limited; see StreamAccess. */
export function streamAccess(sql: string, ctes: Map<string, string>): StreamAccess | null {
  const t = parse(sql);
  if (!t) return null;
  return {
    token: limitedBy(t, ctes, matches(readsToken)),
    tokenOrClient: limitedBy(t, ctes, matches(readsAny)),
    claim: limitedBy(t, ctes, (term) => matches(readsToken)(term) || claimCheck(term), true),
    filtered: limitedBy(t, ctes, filters),
    filteredOrClaim: limitedBy(t, ctes, (term) => filters(term) || claimCheck(term), true),
  };
}

/** Whether a sync rules parameter query checks who is asking (a role claim): it gives its buckets to whoever passes. */
export function checksClaim(sql: string): boolean {
  const t = parse(sql);
  return t !== null && queryLimits(t, claimCheck);
}

/** Whether a query checks a claim every ordinary signed-in Supabase user passes, anywhere in its conditions. */
export function checksEveryToken(sql: string): boolean {
  const t = parse(sql);
  const leaves = (c: Token[]): Token[][] => {
    const x = unwrap(c);
    const parts = splitTop(x, (y) => word(y, "or") || word(y, "and"));
    return parts.length > 1 ? parts.flatMap(leaves) : [x];
  };
  return t !== null && conditions(t).flatMap(leaves).some(everyToken);
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
  // SELECT * names no parameters (PowerSync wants them named); leave it to PowerSync.
  if (items.some((item) => item.length === 1 && sym(item[0], "*"))) return null;
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
  return t !== null && queryLimits(t, matches((side) => bucketNames(side).some(accept)));
}

export interface BucketAccess {
  /** Parameter queries whose bucket parameters, as the data queries use them, are not the user's own. */
  loose: { label: string; sql: string; via: "client" | "nobody" }[];
  /** Data queries no bucket parameter limits: every user the bucket reaches gets all their rows. */
  open: { label: string; sql: string }[];
  /** No data query uses bucket parameters, and every parameter query is a gate that admits a role. */
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
  // A parameter query that gives no bucket parameters only decides who gets the bucket: a
  // gate. It admits a role when it checks, besides who is asking, a fixed value of their own
  // row (is_admin = true) or a claim of their token, and no client value.
  const roleGated =
    params.length > 0 &&
    bound.length === 0 &&
    params.every(({ sql, p }) => {
      const t = parse(sql);
      if (!p || !t || p.parameters.size > 0) return false;
      if (p.rows === "token") return queryLimits(t, (term) => (fixed(term) && !readsClient(term) && !everyToken(term)) || flag(term));
      return queryLimits(t, (term) => claimCheck(term) || (flag(term) && readsToken(term)));
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
