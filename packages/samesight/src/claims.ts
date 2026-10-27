/**
 * Which token claims a rule reads, and what it compares each with: what audit needs to
 * give its users the claims the rules read. It reads RLS policies as Postgres prints them
 * (pg_policies, function bodies) and sync streams and sync rules as written.
 *
 * It scans for claim reads rather than parsing whole expressions: a read is found where it
 * starts (auth.jwt(), auth.parameter('k'), request.jwt(), token_parameters.k, ...),
 * followed through -> / ->> keys, casts, wrapping parentheses, ( SELECT ... ) wrappers,
 * nullif and coalesce, then classified by its neighbour across =, <>, IN, = ANY (ARRAY[...])
 * and IS. Anything else around a read is kept as `other`, never guessed at; a rule this
 * cannot tokenize is reported as unreadable when it reads the token at all.
 *
 * Key paths follow each engine (checked against the PowerSync service): in sync streams,
 * auth.parameter('a.b') is the top-level key "a.b" and only a '$.a.b' path is nested; in
 * sync rules, request.jwt() ->> 'a.b' is nested; in Postgres a key is a key.
 */

import { type Token, sqlText, tokenize } from "./sync/sql.ts";
import { closing, sym, word } from "./lint/tokens.ts";

export type ClaimDialect = "streams" | "rules" | "postgres";
export type ClaimValue = string | number | boolean | null;

export type Compared =
  /** Fixed values; `negated` for <>, NOT IN, <> ALL and IS NOT. */
  | { kind: "literals"; values: ClaimValue[]; negated: boolean }
  /** A column, by its bare name. */
  | { kind: "column"; column: string; negated: boolean; qualifier?: string }
  /** Anything else around the read, as written. */
  | { kind: "other"; text: string };

export interface ClaimRead {
  /** JSON keys into the token payload: ["app_metadata", "role"]; [] is the whole token. */
  path: string[];
  /** Casts applied to the read, outermost last: ["uuid"], ["boolean"]. */
  casts: string[];
  compared: Compared;
  /** coalesce(read, x): the value used when the claim is absent, not a compared value. */
  fallback?: ClaimValue;
  /** Inside a subquery (EXISTS (SELECT ... FROM members m WHERE m.user_id = auth.uid())): a compared column is that table's, not the rule's. */
  inSubquery: boolean;
  /** The read as written, for reports. */
  text: string;
}

export interface Unreadable {
  text: string;
  reason: string;
}

export interface ClaimReads {
  reads: ClaimRead[];
  unreadable: Unreadable[];
}

export interface ClaimOptions {
  /**
   * SQL functions to read through (two levels): name as called (schema.name or name) to its
   * body as Postgres prints it, for any number of arguments. Overloads are keyed beside it as
   * name/min-max (max * for variadic), and a call is matched to them by its argument count.
   * A zero-argument function whose body is one claim read (or a call of another such
   * function) is read as that claim; any other listed function that reads the token is reported.
   */
  functions?: ReadonlyMap<string, string>;
}

/** Internal: how many wrappers deep a read is, 1 in a rule, 2 in a function it calls. */
interface ReadOptions extends ClaimOptions {
  depth?: number;
}

/** Wrappers read through: a rule's function, and one that function calls. */
const WRAPPER_LEVELS = 2;

/**
 * The listed keys a call of fn with argc arguments may run: its overloads whose range takes
 * argc when any are listed as name/min-max, else the name itself (any arity).
 */
function overloadsFor(fn: string, argc: number, functions: ReadonlyMap<string, string>): string[] {
  const ranged = [...functions.keys()].filter((k) => k.startsWith(`${fn}/`));
  if (!ranged.length) return functions.has(fn) ? [fn] : [];
  return ranged.filter((k) => {
    const [min, max] = k.slice(fn.length + 1).split("-");
    return argc >= Number(min) && (max === "*" || argc <= Number(max));
  });
}

/** Arguments in the call whose parenthesis opens at open: top-level commas, named ones included. */
function argCount(t: Token[], open: number): number {
  const close = closing(t, open);
  if (close === open + 1) return 0;
  let n = 1;
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    if (sym(t[i], "(") || sym(t[i], "[")) depth++;
    else if (sym(t[i], ")") || sym(t[i], "]")) depth--;
    else if (depth === 0 && sym(t[i], ",")) n++;
  }
  return n;
}

/** Text that reads the token somewhere: for rules this cannot tokenize. */
const READS_TOKEN = /auth\s*\.\s*(jwt|uid|role|email|parameters?|user_id)\s*\(|request\s*\.\s*(jwt|user_id)\s*\(|token_parameters\s*\.|current_setting\s*\(\s*'request\.jwt/i;

const BOUNDARY = new Set(["and", "or", "not", "when", "then", "else", "end", "where", "select", "from", "on", "as"]);
/** Words a condition can stand right after or before (not select or as: a select list is no condition). */
const CONDITION_EDGE = new Set(["and", "or", "not", "when", "then", "else", "end", "where", "on"]);
/** Words a condition can start right after: then and else start a CASE result value, not a condition. */
const LEFT_EDGE = new Set(["and", "or", "not", "where", "on"]);
/** Words a condition can end right before. */
const RIGHT_EDGE = new Set(["and", "or", "then", "else", "end", "when", "from", "group", "order", "limit"]);
const COMPARE = new Set(["=", "<>", "!="]);
const MULTI_WORD_TYPE = new Set(["varying", "precision", "with", "without", "time", "zone"]);

const isString = (t: Token | undefined) => t?.kind === "string";
const name = (t: Token | undefined) => (t?.kind === "word" || t?.kind === "quoted" ? t.text : undefined);

/** Whether the parenthesis at i opens a function call's arguments: lower( , not AND ( . */
function callParen(t: Token[], i: number): boolean {
  const before = t[i - 1];
  return name(before) !== undefined && !(before?.kind === "word" && (CONDITION_EDGE.has(before.text) || before.text === "in" || before.text === "select"));
}

/** The whole condition around tokens start..end, up to AND, OR, a comma or an unbalanced parenthesis. */
function condition(t: Token[], start: number, end: number): string {
  const edge = (x: Token) => sym(x, ",") || sym(x, ";") || (x.kind === "word" && (CONDITION_EDGE.has(x.text) || x.text === "select" || x.text === "from"));
  let a = start;
  for (let depth = 0; a > 0; a--) {
    const x = t[a - 1] as Token;
    if (sym(x, ")")) depth++;
    else if (sym(x, "(")) {
      if (depth > 0) depth--;
      else if (!callParen(t, a - 1)) break;
    } else if (depth === 0 && edge(x)) break;
  }
  let b = end;
  for (let depth = 0; b < t.length - 1; b++) {
    const x = t[b + 1] as Token;
    if (sym(x, "(")) depth++;
    else if (sym(x, ")")) {
      if (depth > 0) depth--;
      // The closing parenthesis of a call the condition started inside belongs to it.
      else if (!callParen(t, closingOpen(t, b + 1)) || closingOpen(t, b + 1) < a) break;
    } else if (depth === 0 && edge(x)) break;
  }
  return sqlText(t.slice(a, b + 1));
}

/** The index of the parenthesis that the one at close closes. */
function closingOpen(t: Token[], close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (sym(t[i], ")")) depth++;
    else if (sym(t[i], "(") && --depth === 0) return i;
  }
  return -1;
}

/** A key path as an engine reads it; null for an array element or quoted key, which this does not follow. */
function keyPath(key: string, dialect: ClaimDialect, call: "parameter" | "arrow"): string[] | null {
  if (dialect === "postgres") return [key];
  const parts = key.startsWith("$.") ? key.slice(2).split(".") : dialect === "rules" && call === "arrow" ? key.split(".") : [key];
  return parts.some((p) => p === "" || /[[\]"*]/.test(p)) ? null : parts;
}

const PATH_UNSUPPORTED = "an array element or quoted key in a JSON path";

/** Whether the token at i sits inside a ( SELECT ... FROM ... ) subquery. */
function inSubquery(t: Token[], i: number): boolean {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (sym(t[j], ")")) depth++;
    else if (sym(t[j], "(")) {
      if (depth > 0) depth--;
      else if (word(t[j + 1], "select")) {
        // A FROM at this level between the SELECT and the read: the read is in the subquery's WHERE.
        let d = 0;
        for (let k = j + 2; k < i; k++) {
          if (sym(t[k], "(")) d++;
          else if (sym(t[k], ")")) d--;
          else if (d === 0 && word(t[k], "from")) return true;
        }
      }
    }
  }
  return false;
}

/** Whether the WHEN at i belongs to a CASE with no operand (CASE WHEN cond THEN ...), whose WHENs take conditions. */
function searchedCase(t: Token[], i: number): boolean {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (sym(t[j], ")")) depth++;
    else if (sym(t[j], "(")) {
      if (depth-- === 0) return false;
    } else if (depth === 0 && word(t[j], "case")) return word(t[j + 1], "when");
  }
  return false;
}

/** Whether a condition can start right after the token at i. */
function leftEdge(t: Token[], i: number): boolean {
  const x = t[i];
  return x === undefined || (sym(x, "(") && !callParen(t, i)) || sym(x, ";") || (x.kind === "word" && LEFT_EDGE.has(x.text)) || (word(x, "when") && searchedCase(t, i));
}

/** Whether a condition can end right before the token at i. */
function rightEdge(t: Token[], i: number): boolean {
  const x = t[i];
  return x === undefined || sym(x, ")") || sym(x, ";") || (x.kind === "word" && RIGHT_EDGE.has(x.text));
}

interface Span {
  start: number;
  /** Inclusive. */
  end: number;
  path: string[];
  casts: string[];
  fallback?: ClaimValue;
  /** A form this reader does not follow: the read is reported, never guessed at. */
  unsupported?: string;
}

/** Token reads other than the user id: a helper that reads only auth.uid() tells users apart by id alone. */
const READS_CLAIMS = /auth\s*\.\s*(jwt|role|email|parameters?)\s*\(|request\s*\.\s*jwt\s*\(|token_parameters\s*\.|current_setting\s*\(\s*'request\.jwt/i;

/**
 * The functions a body calls, as Postgres resolves names: an unquoted name folded to lower
 * case, a quoted one kept as written, schema.name when qualified. A body that does not
 * tokenize (plpgsql's := and the like) is scanned with its comments and strings removed.
 */
export function callsIn(body: string): string[] {
  const out = new Set<string>();
  let t: Token[] | undefined;
  try {
    t = tokenize(body, { dialect: "postgres" });
  } catch {
    t = undefined;
  }
  if (t) {
    for (let i = 0; i < t.length; i++) {
      const a = t[i];
      if (!a || (a.kind !== "word" && a.kind !== "quoted") || sym(t[i - 1], ".")) continue;
      if (sym(t[i + 1], ".") && name(t[i + 2]) && sym(t[i + 3], "(")) out.add(`${a.text}.${name(t[i + 2])}`);
      else if (sym(t[i + 1], "(") && !(a.kind === "word" && NOT_CALLS.has(a.text))) out.add(a.text);
    }
    return [...out];
  }
  const text = codeOnly(body);
  const part = `("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
  const unquote = (x: string) => (x.startsWith('"') ? x.slice(1, -1).replace(/""/g, '"') : x.toLowerCase());
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9_$".])${part}(?:\\s*\\.\\s*${part})?\\s*\\(`, "g"))) {
    // A keyword before a parenthesis is no call; a quoted name ("if") is one.
    if (m[2] === undefined && !(m[1] as string).startsWith('"') && NOT_CALLS.has((m[1] as string).toLowerCase())) continue;
    out.add(m[2] === undefined ? unquote(m[1] as string) : `${unquote(m[1] as string)}.${unquote(m[2])}`);
  }
  return [...out];
}


/** Keywords Postgres writes before a parenthesis that are no function: EXISTS (...), IN (...). */
const NOT_CALLS = new Set(["exists", "in", "any", "all", "some", "array", "values", "row", "filter", "over", "if", "elsif", "while", "and", "or", "not", "when", "then", "else", "case", "select", "from", "where", "on", "using", "return", "returning", "into", "as", "cast", "coalesce", "nullif", "greatest", "least"]);

/**
 * A plpgsql body with its comments and string literals blanked, in one pass, so a quote or
 * comment marker inside one never hides code: '...' with '' escapes, E'...' with backslash
 * escapes, -- and /* *\/ comments, and $tag$...$tag$ strings (SQL in one, run by EXECUTE, is
 * dynamic SQL, which no reader of the body can follow).
 */
export function codeOnly(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const rest = body.slice(i);
    if (rest.startsWith("--")) {
      const end = body.indexOf("\n", i);
      i = end === -1 ? body.length : end;
      out += " ";
    } else if (rest.startsWith("/*")) {
      const end = body.indexOf("*/", i + 2);
      i = end === -1 ? body.length : end + 2;
      out += " ";
    } else if (/^[eE]'/.test(rest) && !/[A-Za-z0-9_$]/.test(body[i - 1] ?? "")) {
      // E'...': a backslash escapes the next character, and '' is a quote too.
      let j = i + 2;
      while (j < body.length && !(body[j] === "'" && body[j + 1] !== "'")) j += body[j] === "\\" || body[j] === "'" ? 2 : 1;
      i = j + 1;
      out += "''";
    } else if (rest.startsWith('"')) {
      // A quoted name stays as written ("getOrg"), and a quote or -- inside it starts nothing.
      let j = i + 1;
      while (j < body.length && !(body[j] === '"' && body[j + 1] !== '"')) j += body[j] === '"' ? 2 : 1;
      out += body.slice(i, j + 1);
      i = j + 1;
    } else if (rest.startsWith("'")) {
      let j = i + 1;
      while (j < body.length && !(body[j] === "'" && body[j + 1] !== "'")) j += body[j] === "'" ? 2 : 1;
      i = j + 1;
      out += "''";
    } else {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
      if (tag && !/[A-Za-z0-9_]/.test(body[i - 1] ?? "")) {
        const end = body.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? body.length : end + tag[0].length;
        out += "''";
      } else {
        out += body[i];
        i++;
      }
    }
  }
  return out;
}

/** The listed functions a call may run: schema.name exactly; a bare name, any schema's (search_path decides). */
function callees(call: string, functions: ReadonlyMap<string, string>): string[] {
  if (call.includes(".")) return functions.has(call) ? [call] : [];
  return [...functions.keys()].filter((k) => k === call || k.endsWith(`.${call}`));
}

/** Whether a listed function's body reads the token (or, with READS_CLAIMS, a claim other than the user id), itself or through other listed functions. */
function readsTokenThrough(fn: string, functions: ReadonlyMap<string, string>, seen = new Set<string>(), reads = READS_TOKEN): boolean {
  const body = functions.get(fn);
  if (body === undefined || seen.has(fn)) return false;
  seen.add(fn);
  if (reads.test(body)) return true;
  return callsIn(body).some((call) => callees(call, functions).some((other) => readsTokenThrough(other, functions, seen, reads)));
}

/** The claim read starting at token i, before any keys or wrappers; undefined when none starts there. */
function startAt(t: Token[], i: number, dialect: ClaimDialect, options: ReadOptions): Span | undefined {
  const call = (schema: string, fn: string) => word(t[i], schema) && sym(t[i + 1], ".") && word(t[i + 2], fn) && sym(t[i + 3], "(");
  const empty = (open: number) => sym(t[open + 1], ")");
  if (dialect === "postgres") {
    if (call("auth", "jwt") && empty(i + 3)) return { start: i, end: i + 4, path: [], casts: [] };
    if (call("auth", "uid") && empty(i + 3)) return { start: i, end: i + 4, path: ["sub"], casts: [] };
    if (call("auth", "role") && empty(i + 3)) return { start: i, end: i + 4, path: ["role"], casts: [] };
    if (call("auth", "email") && empty(i + 3)) return { start: i, end: i + 4, path: ["email"], casts: [] };
    if (word(t[i], "current_setting") && sym(t[i + 1], "(") && isString(t[i + 2])) {
      const close = closing(t, i + 1);
      const setting = t[i + 2]?.text ?? "";
      if (setting === "request.jwt.claims") return { start: i, end: close, path: [], casts: [] };
      if (setting.startsWith("request.jwt.claim.")) {
        return { start: i, end: close, path: [setting.slice("request.jwt.claim.".length)], casts: [], unsupported: "the legacy request.jwt.claim.* setting" };
      }
    }
    const fn = functionCall(t, i, options);
    if (fn) return fn;
    return undefined;
  }
  if (call("auth", "parameter") && isString(t[i + 4]) && sym(t[i + 5], ")")) {
    const path = keyPath(t[i + 4]?.text ?? "", dialect, "parameter");
    return path ? { start: i, end: i + 5, path, casts: [] } : { start: i, end: i + 5, path: [], casts: [], unsupported: PATH_UNSUPPORTED };
  }
  if (call("auth", "parameters") && empty(i + 3)) return { start: i, end: i + 4, path: [], casts: [] };
  if ((call("auth", "user_id") || call("request", "user_id")) && empty(i + 3)) return { start: i, end: i + 4, path: ["sub"], casts: [] };
  if (call("request", "jwt") && empty(i + 3)) return { start: i, end: i + 4, path: [], casts: [] };
  if (word(t[i], "token_parameters") && sym(t[i + 1], ".") && name(t[i + 2])) {
    const key = name(t[i + 2]) as string;
    return { start: i, end: i + 2, path: key === "user_id" ? ["sub"] : ["parameters", key], casts: [] };
  }
  return undefined;
}

/** A call of a listed zero-argument function whose body is one claim read. */
function functionCall(t: Token[], i: number, options: ReadOptions): Span | undefined {
  if (!options.functions || !name(t[i])) return undefined;
  const qualified = sym(t[i + 1], ".") && name(t[i + 2]);
  const fn = qualified ? `${name(t[i])}.${name(t[i + 2])}` : (name(t[i]) as string);
  const open = qualified ? i + 3 : i + 1;
  if (!sym(t[open], "(") || !sym(t[open + 1], ")")) return undefined;
  const [key, ...more] = overloadsFor(fn, 0, options.functions);
  const body = key === undefined || more.length ? undefined : options.functions.get(key);
  if (body === undefined) return undefined;
  const depth = options.depth ?? 1;
  const inner = wrapperRead(body, depth < WRAPPER_LEVELS ? options.functions : undefined, depth + 1);
  if (!inner) return undefined;
  return { start: i, end: open + 1, path: inner.path, casts: inner.casts, ...(inner.fallback !== undefined ? { fallback: inner.fallback } : {}) };
}

/**
 * The claim read a SQL function's body consists of, as Postgres prints it (select W;,
 * RETURN W, BEGIN ATOMIC SELECT W; END), or undefined when the body is anything else. With
 * `functions`, W may also be a call of a listed zero-argument function that is one read.
 */
export function wrapperRead(body: string, functions?: ReadonlyMap<string, string>, depth = 1): { path: string[]; casts: string[]; fallback?: ClaimValue } | undefined {
  let t: Token[];
  try {
    t = tokenize(body, { dialect: "postgres" });
  } catch {
    return undefined;
  }
  if (word(t[0], "begin") && word(t[1], "atomic")) t = t.slice(2);
  while (sym(t.at(-1), ";") || word(t.at(-1), "end")) t = t.slice(0, -1);
  if (word(t[0], "select") || word(t[0], "return")) t = t.slice(1);
  // Postgres prints a BEGIN ATOMIC select list with its column alias: SELECT ... AS bool.
  if (word(t.at(-2), "as") && name(t.at(-1))) t = t.slice(0, -2);
  for (let i = 0; i < t.length; i++) {
    const span = startAt(t, i, "postgres", functions ? { functions, depth } : {});
    if (!span) continue;
    const read = extend(t, span, "postgres");
    return read.start === 0 && read.end === t.length - 1 && !read.unsupported
      ? { path: read.path, casts: read.casts, ...(read.fallback !== undefined ? { fallback: read.fallback } : {}) }
      : undefined;
  }
  return undefined;
}

/** After `::` at i, the type's tokens: one name (schema-qualified), multi-word names, (n) modifiers, [] suffixes. */
function typeAt(t: Token[], i: number): { type: string; end: number } | undefined {
  let j = i;
  const parts: string[] = [];
  const first = name(t[j]);
  if (!first) return undefined;
  parts.push(first);
  if (sym(t[j + 1], ".") && name(t[j + 2])) {
    parts.push(".", name(t[j + 2]) as string);
    j += 2;
  }
  while (t[j + 1]?.kind === "word" && MULTI_WORD_TYPE.has(t[j + 1]?.text ?? "")) parts.push(" ", (t[++j] as Token).text);
  if (sym(t[j + 1], "(")) j = closing(t, j + 1);
  while (sym(t[j + 1], "[") && sym(t[j + 2], "]")) {
    parts.push("[]");
    j += 2;
  }
  return { type: parts.join(""), end: j };
}

/** A literal value from a single token, typed by the casts after it. */
function literalValue(tok: Token, casts: string[]): ClaimValue | undefined {
  let v: ClaimValue | undefined;
  if (tok.kind === "string") v = tok.text;
  else if (tok.kind === "number") v = Number(tok.text);
  else if (word(tok, "true")) v = true;
  else if (word(tok, "false")) v = false;
  else if (word(tok, "null")) v = null;
  if (v === undefined) return undefined;
  const cast = casts.at(-1)?.toLowerCase();
  if (typeof v === "string" && (cast === "json" || cast === "jsonb")) {
    try {
      const parsed: unknown = JSON.parse(v);
      // An object or array is no single value to give a user.
      return parsed !== null && typeof parsed === "object" ? undefined : (parsed as ClaimValue);
    } catch {
      return v;
    }
  }
  if (typeof v === "string" && cast && /^(int[248]?|integer|bigint|smallint|numeric|real|double precision|float[48]?|decimal)$/.test(cast)) {
    const n = Number(v);
    return Number.isNaN(n) ? v : n;
  }
  if (typeof v === "string" && (cast === "boolean" || cast === "bool")) return v === "true" || v === "t" ? true : v === "false" || v === "f" ? false : v;
  return v;
}

/** Follows a read through keys, casts and wrappers as far as they go. */
function extend(t: Token[], span: Span, dialect: ClaimDialect): Span {
  const s = { ...span, casts: [...span.casts], path: [...span.path] };
  for (;;) {
    const next = t[s.end + 1];
    if ((sym(next, "->") || sym(next, "->>")) && isString(t[s.end + 2])) {
      const keys = keyPath(t[s.end + 2]?.text ?? "", dialect, "arrow");
      if (!keys) return { ...s, end: s.end + 2, unsupported: PATH_UNSUPPORTED };
      // A cast before a key was the object's (current_setting(...)::jsonb -> 'k'), not the claim's.
      s.casts = [];
      s.path.push(...keys);
      s.end += 2;
      // Postgres prints the key with its type: -> 'app_metadata'::text.
      if (sym(t[s.end + 1], "::") && word(t[s.end + 2], "text")) s.end += 2;
      continue;
    }
    if ((sym(next, "->") || sym(next, "->>")) && t[s.end + 2]?.kind === "number") {
      return { ...s, end: s.end + 2, unsupported: "an array element (-> n)" };
    }
    if (sym(next, "#>") || sym(next, "#>>")) return { ...s, end: s.end + 2, unsupported: `a ${next?.text} path` };
    if (sym(next, "[")) return { ...s, end: s.end + 1, unsupported: "a [ ] subscript" };
    // CAST(read AS type)
    if (sym(t[s.start - 1], "(") && word(t[s.start - 2], "cast") && word(next, "as")) {
      const type = typeAt(t, s.end + 2);
      if (type && closing(t, s.start - 1) === type.end + 1) {
        s.casts.push(type.type);
        s.start -= 2;
        s.end = type.end + 1;
        continue;
      }
    }
    if (sym(next, "::")) {
      const type = typeAt(t, s.end + 2);
      if (!type) return s;
      s.casts.push(type.type);
      s.end = type.end;
      continue;
    }
    // Parentheses wrapping exactly the read; not a call's, as in lower(read).
    if (sym(t[s.start - 1], "(") && sym(next, ")") && closing(t, s.start - 1) === s.end + 1 && !callParen(t, s.start - 1)) {
      s.start -= 1;
      s.end += 1;
      continue;
    }
    // ( SELECT read [AS alias] ), with no FROM: the read itself.
    if (word(t[s.start - 1], "select") && sym(t[s.start - 2], "(")) {
      const close = closing(t, s.start - 2);
      const aliasEnd = word(next, "as") && name(t[s.end + 2]) ? s.end + 2 : s.end;
      if (close === aliasEnd + 1) {
        s.start -= 2;
        s.end = close;
        continue;
      }
    }
    // nullif(read, '') and coalesce(read, x): the read, with x when it is absent.
    if (sym(t[s.start - 1], "(") && (word(t[s.start - 2], "nullif") || word(t[s.start - 2], "coalesce")) && sym(next, ",")) {
      const close = closing(t, s.start - 1);
      const arg = t.slice(s.end + 2, close);
      const casts: string[] = [];
      let argEnd = 0;
      while (sym(arg[argEnd + 1], "::")) {
        const type = typeAt(arg, argEnd + 2);
        if (!type) break;
        casts.push(type.type);
        argEnd = type.end;
      }
      const value = arg[0] && argEnd === arg.length - 1 ? literalValue(arg[0], casts) : undefined;
      // nullif(read, '') only: any other value it blanks out changes what the read compares with.
      if (value !== undefined && (word(t[s.start - 2], "coalesce") || value === "")) {
        if (word(t[s.start - 2], "coalesce")) s.fallback = value;
        s.start -= 2;
        s.end = close;
        continue;
      }
    }
    return s;
  }
}

/** The operand of a comparison from `from`, walking by `step` until a boundary at its depth. */
function operand(t: Token[], from: number, step: 1 | -1): Token[] {
  const out: Token[] = [];
  let depth = 0;
  for (let i = from; i >= 0 && i < t.length; i += step) {
    const x = t[i] as Token;
    const opens = sym(x, step === 1 ? "(" : ")");
    const closes = sym(x, step === 1 ? ")" : "(");
    if (closes && depth === 0) break;
    if (depth === 0 && (sym(x, ",") || sym(x, ";") || (x.kind === "word" && BOUNDARY.has(x.text)) || (x.kind === "symbol" && COMPARE.has(x.text)))) break;
    if (opens) depth++;
    if (closes) depth--;
    if (step === 1) out.push(x);
    else out.unshift(x);
  }
  return out;
}

/** Without wrapping parentheses and casts: (org_id)::text is org_id. */
function bare(side: Token[]): { tokens: Token[]; casts: string[] } {
  let x = side;
  const casts: string[] = [];
  for (;;) {
    if (sym(x[0], "(") && closing(x, 0) === x.length - 1) {
      x = x.slice(1, -1);
      continue;
    }
    // A trailing cast: find the last top-level :: and the type after it.
    let at = -1;
    let depth = 0;
    x.forEach((tok, i) => {
      if (sym(tok, "(")) depth++;
      else if (sym(tok, ")")) depth--;
      else if (depth === 0 && sym(tok, "::")) at = i;
    });
    if (at > 0) {
      const type = typeAt(x, at + 1);
      if (type && type.end === x.length - 1) {
        casts.unshift(type.type);
        x = x.slice(0, at);
        continue;
      }
    }
    return { tokens: x, casts };
  }
}

/** A list of literals: 'a', 'b'::text, ... (from IN (...) or ARRAY[...]). */
function literalList(items: Token[]): ClaimValue[] | undefined {
  const values: ClaimValue[] = [];
  let depth = 0;
  let current: Token[] = [];
  const flush = () => {
    const b = bare(current);
    const v = b.tokens.length === 1 ? literalValue(b.tokens[0] as Token, b.casts) : undefined;
    current = [];
    if (v === undefined) return false;
    values.push(v);
    return true;
  };
  for (const x of items) {
    if (sym(x, "(") || sym(x, "[")) depth++;
    if (sym(x, ")") || sym(x, "]")) depth--;
    if (depth === 0 && sym(x, ",")) {
      if (!flush()) return undefined;
    } else current.push(x);
  }
  return current.length && !flush() ? undefined : values;
}

/**
 * The elements of ARRAY[...] filling t[from..close), as Postgres prints IN: ARRAY['a'::text],
 * or, for a cast list, (ARRAY['a'::character varying])::text[]. Undefined for anything else.
 */
function arrayList(t: Token[], from: number, close: number): { from: number; to: number } | undefined {
  let a = from;
  let b = close - 1;
  // (ARRAY[...])::type[]: drop the cast after the parentheses, then the parentheses.
  if (sym(t[a], "(") && closing(t, a) < b) {
    const end = closing(t, a);
    if (!sym(t[end + 1], "::")) return undefined;
    const type = typeAt(t, end + 2);
    if (!type || type.end !== b) return undefined;
    a += 1;
    b = end - 1;
  } else if (sym(t[a], "(") && closing(t, a) === b) {
    a += 1;
    b -= 1;
  }
  if (!word(t[a], "array") || !sym(t[a + 1], "[") || !sym(t[b], "]")) return undefined;
  let depth = 0;
  for (let i = a + 1; i <= b; i++) {
    if (sym(t[i], "[")) depth++;
    if (sym(t[i], "]") && --depth === 0 && i !== b) return undefined;
  }
  return { from: a + 2, to: b };
}

/** What one side of a comparison is. */
function classifySide(side: Token[], negated: boolean): Compared {
  const b = bare(side);
  if (b.tokens.length === 1) {
    const v = literalValue(b.tokens[0] as Token, b.casts);
    if (v !== undefined) return { kind: "literals", values: [v], negated };
    const n = name(b.tokens[0]);
    if (n) return { kind: "column", column: n, negated };
  }
  if (b.tokens.length === 2 && sym(b.tokens[0], "-") && b.tokens[1]?.kind === "number") {
    return { kind: "literals", values: [-Number(b.tokens[1].text)], negated };
  }
  // alias.column (not a call: no parenthesis follows).
  if (b.tokens.length === 3 && name(b.tokens[0]) && sym(b.tokens[1], ".") && name(b.tokens[2])) {
    return { kind: "column", column: name(b.tokens[2]) as string, negated, qualifier: name(b.tokens[0]) as string };
  }
  return { kind: "other", text: sqlText(side) };
}

/** What the read at span is compared with. */
function comparedWith(t: Token[], s: Span): Compared {
  const right = t[s.end + 1];
  const left = t[s.start - 1];
  const other = (): Compared => ({ kind: "other", text: condition(t, s.start, s.end) });
  const flip = (c: Compared, from: number, to: number): Compared => (c.kind !== "other" && negatedAround(t, from, to) ? { ...c, negated: !c.negated } : c);

  if (leftEdge(t, s.start - 1)) {
    // read IS [NOT] NULL / TRUE / FALSE
    if (word(right, "is")) {
      const negated = word(t[s.end + 2], "not");
      const at = s.end + (negated ? 3 : 2);
      const v = t[at];
      if ((word(v, "null") || word(v, "true") || word(v, "false")) && rightEdge(t, at + 1)) {
        return flip({ kind: "literals", values: [word(v, "null") ? null : word(v, "true")], negated }, s.start, at);
      }
      return other();
    }
    // read [NOT] IN (...)
    const notIn = word(right, "not") && word(t[s.end + 2], "in");
    if (word(right, "in") || notIn) {
      const open = s.end + (notIn ? 3 : 2);
      const close = sym(t[open], "(") ? closing(t, open) : -1;
      const values = close > 0 && rightEdge(t, close + 1) ? literalList(t.slice(open + 1, close)) : undefined;
      return values ? flip({ kind: "literals", values, negated: notIn }, s.start, close) : other();
    }
    if (right?.kind === "symbol" && COMPARE.has(right.text)) {
      const negated = right.text !== "=";
      // = ANY (ARRAY[...]) / <> ALL (ARRAY[...]): how Postgres prints IN and NOT IN.
      if ((word(t[s.end + 2], "any") || word(t[s.end + 2], "all")) && sym(t[s.end + 3], "(")) {
        const close = closing(t, s.end + 3);
        const list = arrayList(t, s.end + 4, close);
        // = ANY is IN and <> ALL is NOT IN; = ALL and <> ANY over several values are neither.
        const inLike = (right.text === "=") === word(t[s.end + 2], "any");
        if (list && !inLike) return other();
        if (list) {
          const values = rightEdge(t, close + 1) ? literalList(t.slice(list.from, list.to)) : undefined;
          return values ? flip({ kind: "literals", values, negated }, s.start, close) : other();
        }
      }
      const side = operand(t, s.end + 2, 1);
      if (!rightEdge(t, s.end + 2 + side.length)) return other();
      return flip(classifySide(side, negated), s.start, s.end + 1 + side.length);
    }
  }
  if (left?.kind === "symbol" && COMPARE.has(left.text) && rightEdge(t, s.end + 1)) {
    const side = operand(t, s.start - 2, -1);
    const from = s.start - 1 - side.length;
    if (!leftEdge(t, from - 1)) return other();
    return flip(classifySide(side, left.text !== "="), from, s.end);
  }
  // The read alone as a condition: true when it holds.
  if (leftEdge(t, s.start - 1) && rightEdge(t, s.end + 1)) return { kind: "literals", values: [true], negated: negatedAround(t, s.start, s.end) };
  return other();
}

/**
 * Whether what wraps the condition t[from..to] negates it, walking outwards: NOT before it,
 * parentheses around it, and a parenthesised condition compared with a boolean, as Postgres
 * prints them: ((read = 'x') = false), ((read = 'x') IS NOT TRUE), (NOT ((read = 'x') IS FALSE)).
 * Negations compose. IS NOT TRUE and IS NOT FALSE also hold when the read is null, which the
 * run's user without the claim covers.
 */
function negatedAround(t: Token[], from: number, to: number): boolean {
  let negated = false;
  let a = from;
  let b = to;
  let grouped = false;
  for (;;) {
    if (word(t[a - 1], "not")) {
      negated = !negated;
      a -= 1;
      grouped = false;
      continue;
    }
    if (sym(t[a - 1], "(") && closing(t, a - 1) === b + 1 && !callParen(t, a - 1)) {
      a -= 1;
      b += 1;
      grouped = true;
      continue;
    }
    // Only a parenthesised condition: Postgres prints every comparison of one that way.
    if (!grouped) return negated;
    const before = t[a - 1];
    const lhs = t[a - 2];
    // false = (read = 'x'): the boolean on the left.
    // Not x IS false = (...), which compares (x IS FALSE) with the condition.
    if (before?.kind === "symbol" && ["=", "<>", "!="].includes(before.text) && (word(lhs, "true") || word(lhs, "false")) && !sym(t[a - 3], ".") && !word(t[a - 3], "is") && !word(t[a - 3], "not")) {
      if ((before.text === "=") === word(lhs, "false")) negated = !negated;
      a -= 2;
      grouped = false;
      continue;
    }
    const op = t[b + 1];
    const v = t[b + 2];
    // (read = 'x') IS [NOT] DISTINCT FROM true/false: a null-safe = / <>.
    const distinct = word(op, "is") && (word(v, "distinct") || (word(v, "not") && word(t[b + 3], "distinct")));
    if (distinct) {
      const not = word(v, "not");
      const at = b + (not ? 4 : 3);
      const value = t[at + 1];
      if (!word(t[at], "from") || !(word(value, "true") || word(value, "false"))) return negated;
      // IS NOT DISTINCT FROM is =, IS DISTINCT FROM is <>.
      if (not === word(value, "false")) negated = !negated;
      b = at + 1;
      grouped = false;
      continue;
    }
    if (op?.kind === "symbol" && ["=", "<>", "!="].includes(op.text) && (word(v, "true") || word(v, "false"))) {
      if ((op.text === "=") === word(v, "false")) negated = !negated;
      b += 2;
    } else if (word(op, "is") && (word(v, "true") || word(v, "false"))) {
      if (word(v, "false")) negated = !negated;
      b += 2;
    } else if (word(op, "is") && word(v, "not") && (word(t[b + 3], "true") || word(t[b + 3], "false"))) {
      if (word(t[b + 3], "true")) negated = !negated;
      b += 3;
    } else return negated;
    grouped = false;
  }
}

/** Every claim read in one rule's SQL. */
export function claimReads(sql: string, dialect: ClaimDialect, options: ClaimOptions = {}): ClaimReads {
  let t: Token[];
  try {
    t = tokenize(sql, dialect === "postgres" ? { dialect: "postgres" } : {});
  } catch (e) {
    return READS_TOKEN.test(sql) ? { reads: [], unreadable: [{ text: sql, reason: `cannot be read (${(e as Error).message})` }] } : { reads: [], unreadable: [] };
  }
  const reads: ClaimRead[] = [];
  const unreadable: Unreadable[] = [];
  for (let i = 0; i < t.length; i++) {
    const begin = startAt(t, i, dialect, options);
    if (!begin) {
      // json_extract(read, '$.a.b'): the read's path, then the JSON path.
      if (word(t[i], "json_extract") && sym(t[i + 1], "(")) {
        const close = closing(t, i + 1);
        const inner = startAt(t, i + 2, dialect, options);
        if (inner) {
          const read = extend(t, inner, dialect);
          if (sym(t[read.end + 1], ",") && isString(t[read.end + 2]) && read.end + 3 === close && (t[read.end + 2]?.text ?? "").startsWith("$")) {
            const jsonPath = t[read.end + 2]?.text ?? "$";
            const keys = jsonPath === "$" ? [] : keyPath(jsonPath, dialect, "parameter");
            const span = extend(
              t,
              keys && !read.unsupported
                ? { start: i, end: close, path: [...read.path, ...keys], casts: [] }
                : { start: i, end: close, path: [], casts: [], unsupported: read.unsupported ?? PATH_UNSUPPORTED },
              dialect,
            );
            if (span.unsupported) unreadable.push({ text: sqlText(t.slice(span.start, span.end + 1)), reason: `reads ${span.unsupported}` });
            else reads.push(finish(t, span));
            i = span.end;
            continue;
          }
        }
      }
      // A call of a listed function that reads the token, which was not read as one claim above
      // (it takes arguments, or its body is more than one read): reported, never skipped.
      const called = name(t[i]);
      if (called && options.functions) {
        const qualified = sym(t[i + 1], ".") && name(t[i + 2]) ? `${called}.${name(t[i + 2])}` : called;
        const open = qualified === called ? i + 1 : i + 3;
        const run = sym(t[open], "(") ? overloadsFor(qualified, argCount(t, open), options.functions) : [];
        const reading = run.filter((k) => readsTokenThrough(k, options.functions as ReadonlyMap<string, string>));
        if (reading.length) {
          const claims = reading.some((k) => readsTokenThrough(k, options.functions as ReadonlyMap<string, string>, new Set(), READS_CLAIMS));
          if (claims && run.length > 1) {
            // Several overloads take this many arguments: which one runs is Postgres's choice by type.
            unreadable.push({ text: qualified, reason: `calls ${qualified}, one of whose overloads reads the token` });
          } else if (claims) {
            unreadable.push({ text: qualified, reason: `calls ${qualified}, which reads the token in a way this cannot follow` });
          } else {
            // A helper that reads only the user id (is_member(org_id) over auth.uid()): it tells
            // users apart, the way an owner rule does, and needs no claim audit could set.
            const read = finish(t, { start: i, end: closing(t, open), path: ["sub"], casts: [] });
            reads.push({ ...read, compared: { kind: "other", text: read.text } });
          }
          i = open;
        }
      }
      continue;
    }
    const span = extend(t, begin, dialect);
    if (span.unsupported) {
      unreadable.push({ text: sqlText(t.slice(span.start, span.end + 1)), reason: `reads ${span.unsupported}` });
    } else {
      reads.push(finish(t, span));
    }
    i = span.end;
  }
  return { reads, unreadable };
}

function finish(t: Token[], span: Span): ClaimRead {
  return {
    path: span.path,
    casts: span.casts,
    compared: comparedWith(t, span),
    ...(span.fallback !== undefined ? { fallback: span.fallback } : {}),
    inSubquery: inSubquery(t, span.start),
    text: sqlText(t.slice(span.start, span.end + 1)),
  };
}

export type ClaimClass = "identity" | "shared" | "auth-state" | "app_metadata" | "user_metadata" | "hook" | "object";

const SHARED = new Set(["role", "aud", "iss"]);
const AUTH_STATE = new Set(["aal", "amr", "is_anonymous", "session_id", "email", "phone", "exp", "iat", "nbf", "jti"]);
const AUTH_APP = new Set(["provider", "providers"]);
const AUTH_USER = new Set(["email", "email_verified", "phone_verified", "sub"]);

/** Every claim key classify calls auth-state: what Supabase Auth sets about a sign-in. */
export const AUTH_STATE_KEYS: readonly string[] = [...AUTH_STATE, ...[...AUTH_APP].map((k) => `app_metadata.${k}`), ...[...AUTH_USER].map((k) => `user_metadata.${k}`)];

/** The auth-state key a path reads: its top key, or metadata.key; undefined when it is no auth-state read. */
export function authStateKey(path: readonly string[]): string | undefined {
  if (classify(path) !== "auth-state") return undefined;
  const [top, key] = path;
  return top === "app_metadata" || top === "user_metadata" ? `${top}.${key}` : top;
}

/**
 * Who puts a claim in the token, and so whether audit can give it to its users:
 * Auth itself (identity, shared, auth-state), audit through the admin API (app_metadata,
 * user_metadata), a custom access token hook (any other top-level key), or nobody one can
 * set as a value (the whole token or a whole metadata object: object).
 */
export function classify(path: readonly string[]): ClaimClass {
  const [top, key] = path;
  if (top === undefined) return "object";
  if (top === "sub" && path.length === 1) return "identity";
  if (SHARED.has(top) && path.length === 1) return "shared";
  if (AUTH_STATE.has(top)) return "auth-state";
  if (top === "app_metadata" || top === "user_metadata") {
    if (key === undefined) return "object";
    if ((top === "app_metadata" ? AUTH_APP : AUTH_USER).has(key)) return "auth-state";
    return top;
  }
  return "hook";
}
