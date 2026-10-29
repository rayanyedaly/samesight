/**
 * Who receives a query's rows, for each stream query and sync rules data query: only the
 * row's owner, members of a group, whoever passes a role check, every user for the rows a
 * fixed filter picks, whichever rows a client asks for, or every user.
 *
 * It builds on the access analysis lint already does (access.ts): a query the token limits
 * is owner or group, and any other gets the audience its unscoped-query or client-scoped
 * verdict describes. Owner is claimed only where each row surely goes to one user: the user
 * id itself (auth.user_id(), request.user_id(), token_parameters.user_id) compared directly
 * with a column of the row, or of the one parent row it points at by key, in every OR
 * branch. A group is claimed only where the token is compared plainly with the row, in a
 * query whose tables are joined by equalities. Anything less certain gets the wider audience,
 * never the narrower.
 */

import { claimReads } from "../claims.ts";
import { outputTable } from "../sync/scope.ts";
import { sqlText, type Token } from "../sync/sql.ts";
import { bucketAccess, checksClaim, conditions, dataLimitedBy, filtered, fixedFiltered, limitsByToken, type ParameterQuery, parameterQuery, parameterSource, sides, streamAccess } from "./access.ts";
import { readsClient, readsToken, sources, tokens } from "./sql.ts";
import { closing, isName, literal, splitTop, sym, topLevel, unwrap, word } from "./tokens.ts";

export type Audience =
  /** Each row goes to exactly one user: the one whose id is in `column` of the output table, or, with parent, in parent.column of the one parent row it points at. */
  | { kind: "owner"; column: string; parent?: { table: string; column: string } }
  /** Rows go to users tied to them through something they share: a membership subquery or CTE, a token claim other than the user id (org_id = auth.parameter('org_id')), or a sync rules parameter query. `via` names it, short and as written: "a subquery on memberships", "with.my_orgs", "claim org_id", "parameters[1]". */
  | { kind: "group"; via: string }
  /** Rows go to whoever passes a check on who is asking (a role claim, an admin list), not tied to the row. */
  | { kind: "role" }
  /** A fixed filter (status = 'public', is_public) picks the rows; every user gets them. */
  | { kind: "fixed" }
  /** A client parameter picks the rows: any client can ask for any. */
  | { kind: "client" }
  /**
   * Nothing limits the rows: every user gets every row. Or, with mixed, the query reads the
   * token but ties no row to the user by it (owner_id IN (auth.user_id(), 'system'), a table
   * joined ON true): some rows, or all, reach every user, and no other lint finding fails it.
   */
  | { kind: "everyone"; mixed?: true };

/** Narrowest to widest. */
export const AUDIENCE_ORDER: Audience["kind"][] = ["owner", "group", "role", "fixed", "client", "everyone"];

type Owner = Extract<Audience, { kind: "owner" }>;
/** An audience tied to the row: its owner, or a group. */
type Tied = Extract<Audience, { kind: "owner" | "group" }>;
/** A table's one key column; undefined when its key has several columns, or none. */
type Key = (table: string) => string | undefined;

const rank = (a: Audience) => AUDIENCE_ORDER.indexOf(a.kind);

/** The widest of several (what a user can get through any of them). Owners named by different columns together are a group. */
export function widest(a: Audience[]): Audience {
  const top = a.reduce<Audience | undefined>((w, x) => (w === undefined || rank(x) > rank(w) ? x : w), undefined);
  if (top === undefined) throw new Error("widest needs at least one audience");
  return top.kind === "owner" || top.kind === "group" ? together(a.filter((x): x is Tied => x.kind === "owner" || x.kind === "group")) : top;
}

/** Several ties at once: the one they all are, or a group naming each. */
function together(a: Tied[]): Tied {
  const [first] = a;
  if (first && a.every((x) => same(x, first))) return first;
  return { kind: "group", via: [...new Set(a.map(named))].join(" or ") };
}

/** The narrowest of those a row must all meet, as AND terms; undefined when none ties it. */
function narrowest(a: (Tied | undefined)[]): Tied | undefined {
  return a.reduce<Tied | undefined>((n, x) => (x !== undefined && (n === undefined || rank(x) < rank(n)) ? x : n), undefined);
}

/** Whether two ties reach the same users. */
function same(x: Tied, y: Tied): boolean {
  if (x.kind === "group") return y.kind === "group" && x.via === y.via;
  if (y.kind === "group") return false;
  return x.column === y.column && x.parent?.table === y.parent?.table && x.parent?.column === y.parent?.column;
}

/** How a tie names whom it reaches, as a group's `via`. */
const named = (x: Tied) => (x.kind === "group" ? x.via : x.parent ? `${x.parent.table}.${x.parent.column}` : x.column);

/** Plain words for output. */
export function audienceText(a: Audience): string {
  switch (a.kind) {
    case "owner":
      return a.parent ? `only the owner of its ${a.parent.table} row (${a.parent.table}.${a.parent.column})` : `only the row's owner (${a.column})`;
    case "group":
      return `members of the row's group, through ${a.via}`;
    case "role":
      return "whoever passes a role or claim check";
    case "fixed":
      return "every user, for rows a fixed filter picks";
    case "client":
      return "whichever rows a client asks for";
    case "everyone":
      return a.mixed ? "every user, for some rows or all (the token check does not tie rows to users)" : "every user";
  }
}

/**
 * How a condition ties rows to the user, read the way `limits` in access.ts reads it: some
 * AND term (the narrowest), or every OR branch (all of them together). Undefined when it
 * does not, or when NOT wraps it.
 */
function tie(condition: Token[], leaf: (term: Token[]) => Tied | undefined): Tied | undefined {
  const c = unwrap(condition);
  const ors = splitTop(c, (x) => word(x, "or"));
  if (ors.length > 1) {
    const each = ors.map((b) => tie(b, leaf));
    const ties = each.filter((x): x is Tied => x !== undefined);
    return ties.length === each.length ? together(ties) : undefined;
  }
  const ands = splitTop(c, (x) => word(x, "and"));
  if (ands.length > 1) return narrowest(ands.map((a) => tie(a, leaf)));
  if (word(c[0], "not")) return undefined;
  return leaf(c);
}

/** How a query's conditions (its WHERE and each inner join's ON, all of which hold) tie its rows to the user. */
const tied = (t: Token[], leaf: (term: Token[]) => Tied | undefined) => narrowest(conditions(t).map((c) => tie(c, leaf)));

/** The terms every row meets: a condition's top-level AND terms, through parentheses. */
function andTerms(condition: Token[]): Token[][] {
  const c = unwrap(condition);
  if (splitTop(c, (x) => word(x, "or")).length > 1) return [];
  const ands = splitTop(c, (x) => word(x, "and"));
  return ands.length > 1 ? ands.flatMap(andTerms) : [c];
}

/** The table a query sends, its alias, and each table it reads by alias. */
interface Scope {
  table: string;
  alias: string;
  aliases: Map<string, string>;
}

/** A query's scope as audit reads it; undefined for one audit refuses, such as an outer join. */
function scopeOf(sql: string): Scope | undefined {
  try {
    const o = outputTable(sql);
    return { table: o.table, alias: o.deviceTable, aliases: new Map(Object.entries(o.aliases)) };
  } catch {
    return undefined;
  }
}

/** A column as a side names it, alone or behind wrapping parentheses: owner_id, or l.owner_id with its alias. */
interface Column {
  alias?: string;
  column: string;
}

function columnOf(side: Token[]): Column | undefined {
  const x = unwrap(side);
  if (x.length === 1 && isName(x[0]) && !literal(x)) return { column: (x[0] as Token).text };
  if (x.length === 3 && isName(x[0]) && sym(x[1], ".") && isName(x[2])) return { alias: (x[0] as Token).text, column: (x[2] as Token).text };
  return undefined;
}

/** Whether a column is the sent table's own: qualified by its alias, or bare where the query reads no other table. */
const own = (c: Column, scope: Scope) => (c.alias === undefined ? scope.aliases.size === 1 : c.alias === scope.alias);

/** The two sides of a term's top-level =; not IN, which may test a set. */
function equality(term: Token[]): [Token[], Token[]] | undefined {
  const s = sides(term);
  return s && sym(term[s[0].length], "=") ? s : undefined;
}

/** The claim path of the user id. */
const isSub = (path: string[]) => path.length === 1 && path[0] === "sub";

/**
 * Whether a side is the requesting user's id and nothing else, as claimReads reads it
 * (auth.user_id(), request.user_id(), token_parameters.user_id, auth.parameter('sub')),
 * cast or in parentheses: not mixed with anything, nor given a fallback.
 */
function isUserId(side: Token[], dialect: "streams" | "rules"): boolean {
  const read = tokenRead(side, dialect);
  return read !== undefined && isSub(read.path);
}

/** The one token read a side is and nothing else (a claim or the user id, cast or in parentheses), with its path. */
function tokenRead(side: Token[], dialect: "streams" | "rules"): { path: string[] } | undefined {
  const text = sqlText(side);
  const { reads, unreadable } = claimReads(text, dialect);
  const [read] = reads;
  return reads.length === 1 && unreadable.length === 0 && read?.text === text && read.fallback === undefined ? read : undefined;
}

/**
 * Whether a term the access analysis counts as tying rows to the user does so plainly: a
 * value of the token compared (=) with a value of the row, or a value of the row IN the
 * token's own list or a set tied plainly. The access analysis also counts terms where the
 * token is only part of what is compared, whose rows can reach any user: a literal or a column
 * beside it in a list (owner_id IN (auth.user_id(), 'system')), a fallback without the token
 * (coalesce(auth.parameter('org_id'), 'public')), a CASE, or the comparison itself tested
 * again (owner_id = auth.user_id() IS NULL). Those tie nothing here, so the audience comes out
 * wider. A set (IN a subquery or stream CTE) is plain when its own rows are tied plainly.
 */
function plainTie(term: Token[], ctes: Map<string, string>, dialect: "streams" | "rules", seen = new Set<string>()): boolean {
  const top = topLevel(term);
  // = ... IS NULL, IS NOT TRUE, ISNULL: a test of the comparison, not the comparison.
  if (top.some((i) => word(term[i], "is") || word(term[i], "isnull") || word(term[i], "notnull"))) return false;
  if (term.some((x) => word(x, "case"))) return false;
  const token = (side: Token[]) => tokenValue(side, dialect);
  const at = top.find((i) => isIn(term, i));
  if (at === undefined) {
    const s = equality(term);
    return s !== undefined && ((token(s[0]) && rowValue(s[1])) || (token(s[1]) && rowValue(s[0])));
  }
  const left = term.slice(0, at);
  const rest = term.slice(at + 1);
  if (sym(rest[0], "(") && word(rest[1], "select") && closing(rest, 0) === rest.length - 1) return rowValue(left) && plainSet(rest.slice(1, -1), ctes, dialect, seen);
  const cte = rest.length === 1 && isName(rest[0]) ? ctesByName(ctes).get((rest[0] as Token).text.toLowerCase()) : undefined;
  if (cte) return rowValue(left) && plainCte(cte, ctes, dialect, seen);
  // A list of the token's own: org_id IN auth.parameter('org_ids').
  if (!sym(rest[0], "(")) return rowValue(left) && token(rest);
  if (closing(rest, 0) !== rest.length - 1) return false;
  // A list: owner_id IN (auth.user_id(), x) needs a value of the token in each item, and
  // auth.user_id() IN (owner_id, editor_id) a value of the row in each.
  const items = splitTop(rest.slice(1, -1), (x) => sym(x, ","));
  return token(left) ? items.every(rowValue) : rowValue(left) && items.every(token);
}

/** Comparisons and tests, which make a side a truth value rather than a value. */
const TESTS = new Set(["=", "<>", "!=", "<", ">", "<=", ">=", "~", "~*", "!~", "!~*"]);
const TEST_WORDS = new Set(["is", "isnull", "notnull", "in", "like", "ilike", "similar", "between", "and", "or", "not", "exists"]);

/** Whether a side is a value, with no comparison or test in it outside a subquery: not (owner_id = auth.user_id()). */
function valueOnly(side: Token[]): boolean {
  for (let i = 0; i < side.length; i++) {
    const x = side[i] as Token;
    if (sym(x, "(") && word(side[i + 1], "select")) {
      i = closing(side, i);
      if (i === -1) return false;
    } else if ((x.kind === "symbol" && TESTS.has(x.text)) || (x.kind === "word" && TEST_WORDS.has(x.text))) return false;
  }
  return true;
}

/** A value of the row: not a literal, and not the token or a client value. */
const rowValue = (side: Token[]) => side.length > 0 && !literal(side) && !readsToken(side) && !readsClient(side) && valueOnly(side);

/**
 * A value read from the token, as is or through functions (lower(auth.user_id()),
 * coalesce(auth.parameter('acting_for'), auth.user_id())), with nothing that picks a value
 * without it: a fallback for a claim a token may lack, a CASE, or a column beside it in
 * COALESCE, GREATEST or LEAST. The user id is in every token, so its fallback is never used.
 */
function tokenValue(side: Token[], dialect: "streams" | "rules"): boolean {
  if (!readsToken(side) || readsClient(side) || !valueOnly(side) || side.some((x) => word(x, "case"))) return false;
  const { reads, unreadable } = claimReads(sqlText(side), dialect);
  if (unreadable.length || reads.some((r) => r.fallback !== undefined && !isSub(r.path))) return false;
  for (let i = 0; i < side.length; i++) {
    if (!(word(side[i], "coalesce") || word(side[i], "greatest") || word(side[i], "least")) || !sym(side[i + 1], "(")) continue;
    const end = closing(side, i + 1);
    const args = splitTop(side.slice(i + 2, end === -1 ? side.length : end), (x) => sym(x, ","));
    if (args.some(readsToken) && args.some((a) => !readsToken(a) && !literal(a))) return false;
  }
  return true;
}

/**
 * Whether every table a query reads is joined to the others by equalities every row meets
 * (todos JOIN lists ON todos.list_id = lists.id): a table joined ON true, or by a comma or
 * CROSS JOIN, lets a token compared with its column pick nothing of the others.
 */
function joinedUp(t: Token[]): boolean {
  const scope = scopeOf(sqlText(t));
  if (!scope) {
    // outputTable refuses a comma or CROSS JOIN; other refusals say nothing of the joins.
    const top = topLevel(t);
    const from = top.find((i) => word(t[i], "from"));
    const end = top.find((i) => from !== undefined && i > from && (word(t[i], "where") || word(t[i], "group") || word(t[i], "order") || word(t[i], "limit")));
    return from === undefined || !top.some((i) => i > from && (end === undefined || i < end) && (sym(t[i], ",") || word(t[i], "cross")));
  }
  const reached = new Set([scope.alias]);
  const edges = conditions(t)
    .flatMap(andTerms)
    .flatMap((term) => {
      const s = equality(term);
      const [a, b] = s ? [columnOf(uncast(s[0])), columnOf(uncast(s[1]))] : [];
      return a?.alias !== undefined && b?.alias !== undefined && a.alias !== b.alias ? [[a.alias, b.alias] as const] : [];
    });
  for (let grew = true; grew; ) {
    grew = false;
    for (const [a, b] of edges) {
      if (reached.has(a) === reached.has(b)) continue;
      reached.add(a);
      reached.add(b);
      grew = true;
    }
  }
  return [...scope.aliases.keys()].every((a) => reached.has(a));
}

/** Whether a set's rows are tied to the user plainly: by its own conditions, or by the stream CTE it reads. */
function plainSet(t: Token[], ctes: Map<string, string>, dialect: "streams" | "rules", seen: Set<string>): boolean {
  if (!joinedUp(t)) return false;
  const mark: Tied = { kind: "group", via: "" };
  if (tied(t, (term) => (limitsByToken(term, ctes) && plainTie(term, ctes, dialect, seen) ? mark : undefined)) !== undefined) return true;
  const from = topLevel(t).find((i) => word(t[i], "from"));
  const source = from === undefined ? undefined : t[from + 1];
  const cte = isName(source) ? ctesByName(ctes).get((source as Token).text.toLowerCase()) : undefined;
  return cte !== undefined && plainCte(cte, ctes, dialect, seen);
}

/** Whether a stream CTE's rows are tied plainly; a CTE that reads itself, round a loop, is not. */
function plainCte(cte: { name: string; sql: string }, ctes: Map<string, string>, dialect: "streams" | "rules", seen: Set<string>): boolean {
  const t = seen.has(cte.name) ? null : tokens(cte.sql);
  return t != null && plainSet(t, ctes, dialect, new Set([...seen, cte.name]));
}

/** The column a term compares with the user id: owner_id in owner_id = auth.user_id(). */
function userColumn(term: Token[], dialect: "streams" | "rules"): Column | undefined {
  const s = equality(term);
  if (!s) return undefined;
  if (isUserId(s[1], dialect)) return columnOf(s[0]);
  if (isUserId(s[0], dialect)) return columnOf(s[1]);
  return undefined;
}

/** A term comparing the user id with a column of the sent row itself. */
function ownColumn(term: Token[], scope: Scope, dialect: "streams" | "rules"): Owner | undefined {
  const c = userColumn(term, dialect);
  return c && own(c, scope) ? { kind: "owner", column: c.column } : undefined;
}

/**
 * A row owned through the parent row its column points at. When the parent's owner column
 * is its key, the column holds the user id itself; when the parent is the row itself (its
 * key points at it), the parent's owner column is the row's.
 */
function owned(column: string, table: string, parent: { table: string; column: string }, key: Key): Owner {
  const k = key(parent.table);
  if (parent.column === k) return { kind: "owner", column };
  if (parent.table === table && column === k) return { kind: "owner", column: parent.column };
  return { kind: "owner", column, parent };
}

/** Stream CTEs by lowercased name, as access.ts resolves them, with the name as written. */
const ctesByName = (ctes: Map<string, string>) => new Map([...ctes].map(([name, sql]) => [name.toLowerCase(), { name, sql }]));

/** IN, and not NOT IN. */
const isIn = (t: Token[], i: number) => word(t[i], "in") && !word(t[i - 1], "not");

/**
 * The owner a parent's column compared with the user id names, when the parent is joined
 * by its key to a column of the sent row (todos JOIN lists ON todos.list_id = lists.id WHERE
 * lists.owner_id = auth.user_id()). The key equality must hold for every row: a top-level
 * AND term of the WHERE or an inner join's ON. Audit reads only inner joins.
 */
function joined(c: Column, query: Token[], scope: Scope, ctes: Map<string, string>, key: Key): Owner | undefined {
  const table = c.alias === undefined || c.alias === scope.alias ? undefined : scope.aliases.get(c.alias);
  // A joined CTE holds whatever it selects, under no key.
  const k = table === undefined || ctesByName(ctes).has(table.toLowerCase()) ? undefined : key(table);
  if (table === undefined || k === undefined) return undefined;
  const parentKey = (x: Column | undefined) => x?.alias === c.alias && x?.column === k;
  for (const term of conditions(query).flatMap(andTerms)) {
    const s = equality(term);
    if (!s) continue;
    const [a, b] = [columnOf(s[0]), columnOf(s[1])];
    const child = parentKey(a) ? b : parentKey(b) ? a : undefined;
    if (child?.alias === scope.alias) return owned(child.column, scope.table, { table, column: c.column }, key);
  }
  return undefined;
}

/**
 * The table and owner column of a set of keys of the user's own rows: SELECT id FROM lists
 * WHERE owner_id = auth.user_id(). It selects that table's key alone, so each value is one
 * row's, and every OR branch gives the same owner column, so that row is the user's.
 */
function ownKeys(t: Token[], sql: string, ctes: Map<string, string>, key: Key): { table: string; column: string } | undefined {
  const scope = scopeOf(sql);
  // A set read from a CTE holds whatever the CTE selects, not a table's keys.
  if (!scope || ctesByName(ctes).has(scope.table.toLowerCase())) return undefined;
  const from = topLevel(t).find((i) => word(t[i], "from"));
  const items = splitTop(t.slice(word(t[1], "distinct") || word(t[1], "all") ? 2 : 1, from), (x) => sym(x, ","));
  const item = items.length === 1 ? (items[0] as Token[]) : [];
  const as = topLevel(item).find((i) => word(item[i], "as"));
  const c = columnOf(as === undefined ? item : item.slice(0, as));
  if (!c || !own(c, scope) || c.column !== key(scope.table)) return undefined;
  const owner = tied(t, (term) => ownColumn(term, scope, "streams"));
  return owner?.kind === "owner" ? { table: scope.table, column: owner.column } : undefined;
}

/** The owner a term names by picking the sent row's column IN the keys of the user's own rows of a table: a subquery, or a stream CTE. */
function picked(term: Token[], scope: Scope, ctes: Map<string, string>, key: Key): Owner | undefined {
  const at = topLevel(term).find((i) => isIn(term, i));
  if (at === undefined) return undefined;
  const c = columnOf(term.slice(0, at));
  const rest = term.slice(at + 1);
  if (!c || !own(c, scope)) return undefined;
  let set: { t: Token[]; sql: string } | undefined;
  if (sym(rest[0], "(") && word(rest[1], "select") && closing(rest, 0) === rest.length - 1) {
    const t = rest.slice(1, -1);
    set = { t, sql: sqlText(t) };
  } else if (rest.length === 1 && isName(rest[0])) {
    const cte = ctesByName(ctes).get((rest[0] as Token).text.toLowerCase());
    const t = cte && tokens(cte.sql);
    if (cte && t) set = { t, sql: cte.sql };
  }
  const parent = set && ownKeys(set.t, set.sql, ctes, key);
  return parent && owned(c.column, scope.table, parent, key);
}

/**
 * The owner a term of a stream query names: the user id compared with a column of the sent
 * row, or of a parent row joined by its key, or the row picked from the keys of the user's
 * own parent rows.
 */
function ownerTerm(term: Token[], query: Token[], scope: Scope, ctes: Map<string, string>, key: Key): Owner | undefined {
  const c = userColumn(term, "streams");
  if (!c) return picked(term, scope, ctes, key);
  return own(c, scope) ? { kind: "owner", column: c.column } : joined(c, query, scope, ctes, key);
}

/**
 * What ties a term's rows to the user, short and as written: the table of the subquery or
 * the CTE it reads (as the access analysis follows IN), the claim it reads, or else the
 * column it compares the user id with.
 */
function via(term: Token[], ctes: Map<string, string>): string {
  const byName = ctesByName(ctes);
  for (const i of topLevel(term).filter((i) => isIn(term, i))) {
    const next = term[i + 1];
    if (sym(next, "(") && word(term[i + 2], "select")) {
      const end = closing(term, i + 1);
      const sub = term.slice(i + 2, end === -1 ? term.length : end);
      const from = topLevel(sub).find((j) => word(sub[j], "from"));
      const first = from === undefined ? undefined : word(sub[from + 1], "public") && sym(sub[from + 2], ".") ? sub[from + 3] : sub[from + 1];
      if (!isName(first)) return "a subquery";
      const cte = byName.get((first as Token).text.toLowerCase());
      return cte ? `with.${cte.name}` : `a subquery on ${(first as Token).text}`;
    }
    const cte = isName(next) ? byName.get((next as Token).text.toLowerCase()) : undefined;
    if (cte) return `with.${cte.name}`;
  }
  const s = sides(term);
  const at = s ? s.findIndex(readsToken) : -1;
  if (!s || at === -1) return "the token";
  const { reads } = claimReads(sqlText(s[at] as Token[]), "streams");
  const claim = reads.find((r) => !isSub(r.path));
  if (claim) return claim.path.length ? `claim ${claim.path.join(".")}` : "the token";
  return reads.length ? sqlText(s[1 - at] as Token[]) : "the token";
}

/**
 * A query of several SELECTs (UNION, INTERSECT, EXCEPT): the access analysis reads all their
 * conditions as one query's, as if each row met them all, so it is not read here.
 */
const compound = (t: Token[]) => topLevel(t).some((i) => word(t[i], "union") || word(t[i], "intersect") || word(t[i], "except"));

const keyOf =
  (keys?: (table: string) => string[] | undefined): Key =>
  (table) => {
    const k = keys?.(table) ?? ["id"];
    return k.length === 1 ? k[0] : undefined;
  };

/**
 * Who receives a stream query's rows: keys gives the key columns of a table (default ["id"]),
 * from the migrations when known. Null when the query, or a CTE it reads, cannot be read (the
 * rules leave those to unreadable-query too), or when it is compound.
 */
export function streamAudience(sql: string, ctes: Map<string, string>, keys?: (table: string) => string[] | undefined): Audience | null {
  const t = tokens(sql);
  if (!t || compound(t)) return null;
  const read = sources(t);
  if ([...ctes].some(([name, cte]) => read.has(name.toLowerCase()) && !tokens(cte))) return null;
  const access = streamAccess(sql, ctes);
  if (!access) return null;
  // As unscoped-query and client-scoped see it: a check every token passes is no check at all.
  if (!access.token) {
    if (access.tokenOrClient) return { kind: "client" };
    if (access.claim) return { kind: "role" };
    if (access.filtered || access.filteredOrClaim) return { kind: "fixed" };
    return { kind: "everyone" };
  }
  const key = keyOf(keys);
  const scope = scopeOf(sql);
  const joined = joinedUp(t);
  // A term ties the rows where the access analysis says so, which also refuses sets a UNION
  // widens or a client value fills; then it names an owner, or else a group, when it ties
  // them plainly in a query whose tables are joined up.
  const leaf = (term: Token[]): Tied | undefined => {
    if (!limitsByToken(term, ctes)) return undefined;
    const owner = scope && ownerTerm(term, t, scope, ctes, key);
    if (owner) return owner;
    return joined && plainTie(term, ctes, "streams") ? { kind: "group", via: via(term, ctes) } : undefined;
  };
  // The token is read, but no term ties the rows plainly (owner_id IN (auth.user_id(),
  // 'system')): some rows may reach every user, so say so rather than guess narrower.
  return tied(t, leaf) ?? { kind: "everyone", mixed: true };
}

/** An owner parameter: the user id itself, or the key of a table whose rows it selects are the user's own. */
type OwnerParameter = "user" | { table: string; column: string };

/** The bucket parameters of a parameter query that each name one user. */
function ownerParameters(sql: string, p: ParameterQuery, key: Key): Map<string, OwnerParameter> {
  const out = new Map<string, OwnerParameter>();
  const t = tokens(sql);
  if (!t) return out;
  const scope = scopeOf(sql);
  const rows = scope && tied(t, (term) => ownColumn(term, scope, "rules"));
  const end = topLevel(t).find((i) => word(t[i], "from") || word(t[i], "where"));
  const seen = new Set<string>();
  for (const item of splitTop(t.slice(1, end), (x) => sym(x, ","))) {
    // Named as parameterQuery names them; a name given twice is neither's.
    const as = topLevel(item).find((i) => word(item[i], "as"));
    const name = as !== undefined ? item[as + 1] : item.at(-1);
    if (!isName(name)) continue;
    const n = (name as Token).text.toLowerCase();
    if (seen.has(n)) {
      out.delete(n);
      continue;
    }
    seen.add(n);
    if (parameterSource(p, n) !== "token") continue;
    const value = as !== undefined ? item.slice(0, as) : item;
    const c = columnOf(value);
    if (isUserId(value, "rules")) out.set(n, "user");
    else if (scope && c && own(c, scope) && c.column === key(scope.table) && rows?.kind === "owner") out.set(n, { table: scope.table, column: rows.column });
  }
  return out;
}

/**
 * Whether a data query and its parameter query tie rows to the user plainly: the data query
 * compares a row's value (=) with a bucket parameter the token decides, and that parameter is
 * a token value with no CASE (SELECT token_parameters.user_id AS uid), or a column of rows the
 * parameter query ties plainly (SELECT org_id FROM members WHERE user_id = token_parameters.user_id).
 * owner_id IN (bucket.uid, 'system'), or a parameter query reading
 * owner_id IN (token_parameters.user_id, 'system'), may reach every user.
 */
function plainBucket(data: Token[], parameterSql: string, p: ParameterQuery): boolean {
  const pt = tokens(parameterSql);
  if (!pt) return false;
  const end = topLevel(pt).find((i) => word(pt[i], "from") || word(pt[i], "where"));
  const plain = new Set<string>();
  const rowsTied = p.rows === "token" && plainSet(pt, new Map(), "rules", new Set());
  for (const item of splitTop(pt.slice(1, end), (x) => sym(x, ","))) {
    const as = topLevel(item).find((i) => word(item[i], "as"));
    const name = as !== undefined ? item[as + 1] : item.at(-1);
    if (!isName(name)) continue;
    const n = (name as Token).text.toLowerCase();
    const value = as !== undefined ? item.slice(0, as) : item;
    const source = p.parameters.get(n);
    // A value of the token, with no fallback or CASE that may pick something else; or a column of rows tied plainly.
    if ((source === "token" && tokenValue(value, "rules")) || (source === "rows" && rowsTied && columnOf(uncast(value)) !== undefined)) plain.add(n);
  }
  const mark: Tied = { kind: "group", via: "" };
  // A row compared (=) with the parameter alone; not with it IN a list beside a literal, nor a test of the comparison.
  const leaf = (term: Token[]): Tied | undefined => {
    const s = equality(term);
    if (!s || topLevel(term).some((i) => word(term[i], "is"))) return undefined;
    const [a, b] = [bucketParameter(uncast(s[0])), bucketParameter(uncast(s[1]))];
    const row = (side: Token[]) => !literal(side) && !side.some((x) => word(x, "bucket"));
    return (a !== undefined && plain.has(a) && row(s[1])) || (b !== undefined && plain.has(b) && row(s[0])) ? mark : undefined;
  };
  return tied(data, leaf) !== undefined;
}

/** A value without the casts after it: bucket.org_id::text is bucket.org_id; bucket.org_id::text || 'x' stays. */
function uncast(side: Token[]): Token[] {
  const x = unwrap(side);
  const at = topLevel(x).find((i) => sym(x[i], "::"));
  const type = (y: Token) => isName(y) || y.kind === "number" || [":", "::", "(", ")", ",", "[", "]"].some((c) => sym(y, c));
  return at !== undefined && x.slice(at).every(type) ? x.slice(0, at) : x;
}

/** The bucket parameter a side is and nothing else: bucket.list_id. */
function bucketParameter(side: Token[]): string | undefined {
  const x = unwrap(side);
  return x.length === 3 && word(x[0], "bucket") && sym(x[1], ".") && isName(x[2]) ? (x[2] as Token).text.toLowerCase() : undefined;
}

/** A data query term comparing a column of its row with an owner parameter: owner_id = bucket.user_id. */
function bucketOwner(term: Token[], scope: Scope, owners: Map<string, OwnerParameter>, key: Key): Owner | undefined {
  const s = equality(term);
  if (!s) return undefined;
  const pairs: [Token[], Token[]][] = [s, [s[1], s[0]]];
  for (const [side, other] of pairs) {
    const c = columnOf(side);
    const parameter = bucketParameter(other);
    const o = parameter === undefined ? undefined : owners.get(parameter);
    if (!c || !o || !own(c, scope)) continue;
    return o === "user" ? { kind: "owner", column: c.column } : owned(c.column, scope.table, o, key);
  }
  return undefined;
}

/**
 * For each data query label of one sync rules bucket: the audience through each parameter
 * query, or one entry with via "no parameter query". Data queries that cannot be read, or
 * are compound, are left out, as the rules leave the first to unreadable-query; through a
 * parameter query that cannot be read, or is compound, every user, since its buckets could
 * go to anyone.
 */
export function bucketAudiences(
  parameters: Map<string, string>,
  data: { label: string; sql: string }[],
  keys?: (table: string) => string[] | undefined,
): Map<string, { via: string; audience: Audience }[]> {
  const key = keyOf(keys);
  const queries = [...parameters].map(([label, sql]) => {
    const t = tokens(sql);
    const p = t && !compound(t) ? parameterQuery(sql) : null;
    // A gate that gives no parameters admits a role: the bucket goes to whoever passes it.
    return { label, sql, p, owners: p ? ownerParameters(sql, p, key) : new Map<string, OwnerParameter>(), role: bucketAccess(new Map([[label, sql]]), data).roleGated };
  });
  const out = new Map<string, { via: string; audience: Audience }[]>();
  for (const d of data) {
    const t = tokens(d.sql);
    if (!t || compound(t)) continue;
    // Rows no bucket parameter limits reach every user the bucket does: those its fixed filters allow, or all.
    const open = !dataLimitedBy(d.sql, () => true);
    const all: Audience = filtered(d.sql) ? { kind: "fixed" } : { kind: "everyone" };
    if (!queries.length) {
      out.set(d.label, [{ via: "no parameter query", audience: all }]);
      continue;
    }
    const reach = ({ label, sql, p, owners, role }: (typeof queries)[number]): Audience => {
      if (!p) return { kind: "everyone" };
      if (open) return role ? { kind: "role" } : all;
      if (dataLimitedBy(d.sql, (n) => parameterSource(p, n) === "token")) {
        const scope = scopeOf(d.sql);
        const owner = scope && tied(t, (term) => bucketOwner(term, scope, owners, key));
        if (owner?.kind === "owner") return owner;
        // As for streams: the rows reach a group only where both queries tie them plainly.
        return plainBucket(t, sql, p) ? { kind: "group", via: label } : { kind: "everyone", mixed: true };
      }
      if (dataLimitedBy(d.sql, (n) => parameterSource(p, n) !== "nobody")) return { kind: "client" };
      if (checksClaim(sql)) return { kind: "role" };
      // A claim every user shares gives every user the same bucket, whatever filters its rows.
      if (fixedFiltered(sql) && ![...p.parameters.values()].includes("shared")) return { kind: "fixed" };
      return { kind: "everyone" };
    };
    out.set(d.label, queries.map((q) => ({ via: q.label, audience: reach(q) })));
  }
  return out;
}
