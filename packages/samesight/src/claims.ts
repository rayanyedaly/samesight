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
  | { kind: "column"; column: string; negated: boolean }
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
   * SQL functions to read through (one level): name as called (schema.name or name) to its
   * body as Postgres prints it. A zero-argument function whose body is one claim read is
   * read as that claim; any other listed function that reads the token is reported.
   */
  functions?: ReadonlyMap<string, string>;
}

/** Text that reads the token somewhere: for rules this cannot tokenize. */
const READS_TOKEN = /auth\s*\.\s*(jwt|uid|role|email|parameters?|user_id)\s*\(|request\s*\.\s*(jwt|user_id)\s*\(|token_parameters\s*\.|current_setting\s*\(\s*'request\.jwt/i;

const BOUNDARY = new Set(["and", "or", "not", "when", "then", "else", "end", "where", "select", "from", "on", "as"]);
/** Words a condition can stand right after or before (not select or as: a select list is no condition). */
const CONDITION_EDGE = new Set(["and", "or", "not", "when", "then", "else", "end", "where", "on"]);
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

/** A key path as an engine reads it. */
function keyPath(key: string, dialect: ClaimDialect, call: "parameter" | "arrow"): string[] {
  if (key.startsWith("$.")) return key.slice(2).split(".");
  if (dialect === "rules" && call === "arrow") return key.split(".");
  return [key];
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

/** The claim read starting at token i, before any keys or wrappers; undefined when none starts there. */
function startAt(t: Token[], i: number, dialect: ClaimDialect, options: ClaimOptions): Span | undefined {
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
    return { start: i, end: i + 5, path: keyPath(t[i + 4]?.text ?? "", dialect, "parameter"), casts: [] };
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
function functionCall(t: Token[], i: number, options: ClaimOptions): Span | undefined {
  if (!options.functions || !name(t[i])) return undefined;
  const qualified = sym(t[i + 1], ".") && name(t[i + 2]);
  const fn = qualified ? `${name(t[i])}.${name(t[i + 2])}` : (name(t[i]) as string);
  const open = qualified ? i + 3 : i + 1;
  if (!sym(t[open], "(") || !sym(t[open + 1], ")")) return undefined;
  const body = options.functions.get(fn);
  if (body === undefined) return undefined;
  const inner = wrapperRead(body);
  if (!inner) return undefined;
  return { start: i, end: open + 1, path: inner.path, casts: inner.casts, ...(inner.fallback !== undefined ? { fallback: inner.fallback } : {}) };
}

/**
 * The claim read a SQL function's body consists of, as Postgres prints it (select W;,
 * RETURN W, BEGIN ATOMIC SELECT W; END), or undefined when the body is anything else.
 */
export function wrapperRead(body: string): { path: string[]; casts: string[]; fallback?: ClaimValue } | undefined {
  let t: Token[];
  try {
    t = tokenize(body, { dialect: "postgres" });
  } catch {
    return undefined;
  }
  if (word(t[0], "begin") && word(t[1], "atomic")) t = t.slice(2);
  while (sym(t.at(-1), ";") || word(t.at(-1), "end")) t = t.slice(0, -1);
  if (word(t[0], "select") || word(t[0], "return")) t = t.slice(1);
  for (let i = 0; i < t.length; i++) {
    const span = startAt(t, i, "postgres", {});
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
      return JSON.parse(v) as ClaimValue;
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
      s.path.push(...keyPath(t[s.end + 2]?.text ?? "", dialect, "arrow"));
      s.end += 2;
      // Postgres prints the key with its type: -> 'app_metadata'::text.
      if (sym(t[s.end + 1], "::") && word(t[s.end + 2], "text")) s.end += 2;
      continue;
    }
    if ((sym(next, "->") || sym(next, "->>")) && t[s.end + 2]?.kind === "number") {
      return { ...s, end: s.end + 2, unsupported: "an array element (-> n)" };
    }
    if (sym(next, "#>") || sym(next, "#>>")) return { ...s, end: s.end + 2, unsupported: `a ${next?.text} path` };
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
      if (value !== undefined) {
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
    return { kind: "column", column: name(b.tokens[2]) as string, negated };
  }
  return { kind: "other", text: sqlText(side) };
}

/** What the read at span is compared with. */
function comparedWith(t: Token[], s: Span): Compared {
  const right = t[s.end + 1];
  const left = t[s.start - 1];
  // read IS [NOT] NULL / TRUE / FALSE
  if (word(right, "is")) {
    const negated = word(t[s.end + 2], "not");
    const v = t[s.end + (negated ? 3 : 2)];
    if (word(v, "null") || word(v, "true") || word(v, "false")) {
      return { kind: "literals", values: [word(v, "null") ? null : word(v, "true")], negated };
    }
  }
  // read [NOT] IN (...)
  const notIn = word(right, "not") && word(t[s.end + 2], "in");
  if (word(right, "in") || notIn) {
    const open = s.end + (notIn ? 3 : 2);
    if (sym(t[open], "(")) {
      const values = literalList(t.slice(open + 1, closing(t, open)));
      if (values) return { kind: "literals", values, negated: notIn };
    }
    return { kind: "other", text: sqlText(t.slice(s.end + 1, Math.max(s.end + 2, closing(t, open) + 1))) };
  }
  if (right?.kind === "symbol" && COMPARE.has(right.text)) {
    const negated = right.text !== "=";
    // = ANY (ARRAY[...]) / <> ALL (ARRAY[...]): how Postgres prints IN and NOT IN.
    if ((word(t[s.end + 2], "any") || word(t[s.end + 2], "all")) && sym(t[s.end + 3], "(") && word(t[s.end + 4], "array") && sym(t[s.end + 5], "[")) {
      let close = s.end + 5;
      let depth = 0;
      for (; close < t.length; close++) {
        if (sym(t[close], "[")) depth++;
        if (sym(t[close], "]") && --depth === 0) break;
      }
      const values = literalList(t.slice(s.end + 6, close));
      if (values) return { kind: "literals", values, negated };
      return { kind: "other", text: sqlText(t.slice(s.end + 1, closing(t, s.end + 3) + 1)) };
    }
    return classifySide(operand(t, s.end + 2, 1), negated);
  }
  if (left?.kind === "symbol" && COMPARE.has(left.text)) {
    return classifySide(operand(t, s.start - 2, -1), left.text !== "=");
  }
  // The read alone as a condition: true when it holds.
  const alone = (x: Token | undefined, edge: "(" | ")") => x === undefined || sym(x, edge) || sym(x, ";") || (x.kind === "word" && CONDITION_EDGE.has(x.text));
  if (alone(left, "(") && !(sym(left, "(") && callParen(t, s.start - 1)) && alone(right, ")")) return { kind: "literals", values: [true], negated: word(left, "not") };
  return { kind: "other", text: condition(t, s.start, s.end) };
}

/** Every claim read in one rule's SQL. */
export function claimReads(sql: string, dialect: ClaimDialect, options: ClaimOptions = {}): ClaimReads {
  let t: Token[];
  try {
    t = tokenize(sql, dialect === "postgres" ? { dialect: "postgres" } : {});
  } catch (e) {
    return READS_TOKEN.test(sql) ? { reads: [], unreadable: [{ text: sql, reason: (e as Error).message }] } : { reads: [], unreadable: [] };
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
            const path = (t[read.end + 2]?.text ?? "$").slice(2);
            const span = extend(t, { start: i, end: close, path: [...read.path, ...(path ? path.split(".") : [])], casts: [] }, dialect);
            reads.push(finish(t, span));
            i = span.end;
            continue;
          }
        }
      }
      // A listed function that reads the token but is not one claim read.
      const called = name(t[i]);
      if (called && options.functions) {
        const qualified = sym(t[i + 1], ".") && name(t[i + 2]) ? `${called}.${name(t[i + 2])}` : called;
        const body = options.functions.get(qualified);
        if (body !== undefined && READS_TOKEN.test(body) && !wrapperRead(body)) {
          unreadable.push({ text: qualified, reason: `calls ${qualified}, which reads the token in a way this cannot follow` });
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
    text: sqlText(t.slice(span.start, span.end + 1)),
  };
}

export type ClaimClass = "identity" | "shared" | "auth-state" | "app_metadata" | "user_metadata" | "hook" | "object";

const SHARED = new Set(["role", "aud", "iss"]);
const AUTH_STATE = new Set(["aal", "amr", "is_anonymous", "session_id", "email", "phone", "exp", "iat", "nbf", "jti"]);
const AUTH_APP = new Set(["provider", "providers"]);
const AUTH_USER = new Set(["email", "email_verified", "phone_verified", "sub"]);

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
