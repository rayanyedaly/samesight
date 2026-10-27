import { ident } from "../emit/expr.ts";

/**
 * Just enough of the stream SQL dialect to check gates: a tokenizer, the projection,
 * the table, and the WHERE clause split into its top-level AND terms. Anything it does
 * not recognise is reported as unreadable, never guessed at.
 */

export interface Token {
  kind: "word" | "quoted" | "string" | "number" | "symbol";
  /** Words are lowercased (Postgres folds them); quoted names keep their case. */
  text: string;
}

/** Longest first, so "->>" wins over "->". */
const SYMBOLS = ["->>", "<>", "!=", "<=", ">=", "->", "||", "::", "(", ")", ",", ".", "=", "<", ">", "*", "+", "-"];
/** Characters Postgres builds operators from (~~ for LIKE, @>, ?, #>>, ...). */
const OPERATOR = /^[+\-*/<>=~!@#%^&|?]+/;

export interface TokenizeOptions {
  /**
   * "postgres" also reads what Postgres prints for policies and function bodies: [ and ]
   * (ARRAY['a'::text]), any operator, and ; ending a statement. The default reads stream
   * SQL only and refuses those.
   */
  dialect?: "sync" | "postgres";
}

export function tokenize(sql: string, options: TokenizeOptions = {}): Token[] {
  const postgres = options.dialect === "postgres";
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (/\s/.test(ch)) {
      i++;
    } else if (sql.startsWith("--", i)) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      let text = "";
      for (;;) {
        if (j >= sql.length) throw new Error(`unclosed ${ch} in: ${sql}`);
        if (sql[j] === ch && sql[j + 1] === ch) {
          text += ch;
          j += 2;
        } else if (sql[j] === ch) break;
        else text += sql[j++];
      }
      out.push(ch === "'" ? { kind: "string", text } : { kind: "quoted", text });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i)) as RegExpExecArray;
      // E'..', U&'..', B'..', X'..': prefixed literals with escapes this tokenizer does not model.
      if (sql[i + m[0].length] === "'" || sql[i + m[0].length] === "&") throw new Error(`has a prefixed literal (${m[0]}${sql[i + m[0].length]}) that cannot be read safely`);
      out.push({ kind: "word", text: m[0].toLowerCase() });
      i += m[0].length;
    } else if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(sql.slice(i)) as RegExpExecArray;
      out.push({ kind: "number", text: m[0] });
      i += m[0].length;
    } else if (postgres && "[];".includes(ch)) {
      out.push({ kind: "symbol", text: ch });
      i++;
    } else if (postgres && OPERATOR.test(sql.slice(i)) && !sql.startsWith("/*", i)) {
      const op = (OPERATOR.exec(sql.slice(i)) as RegExpExecArray)[0];
      out.push({ kind: "symbol", text: op });
      i += op.length;
    } else {
      // Only the operators stream SQL uses; anything else (block comments, $ quoting, ;) is refused.
      const op = SYMBOLS.find((s) => sql.startsWith(s, i));
      if (!op || sql.startsWith("/*", i)) throw new Error(`has "${sql.slice(i, i + 2)}", which this check does not read`);
      out.push({ kind: "symbol", text: op });
      i += op.length;
    }
  }
  return out;
}

/**
 * A term in a canonical spelling, single-spaced: words lowercased, quoted names quoted
 * only when they must be (so "id" and id agree, and "tenantId" stays one name).
 */
export function render(tokens: Token[]): string {
  return tokens.map((t) => (t.kind === "string" ? `'${t.text.replaceAll("'", "''")}'` : t.kind === "quoted" ? ident(t.text) : t.text)).join(" ");
}

const KEYWORDS = new Set(["select", "from", "where", "and", "or", "not", "in", "is", "on", "as"]);

/** Tokens back to SQL as a person writes it: auth.parameter('x'), a, b, x::text. */
export function sqlText(tokens: Token[]): string {
  let out = "";
  let prev: Token | undefined;
  for (const t of tokens) {
    const text = render([t]);
    const tight = (p: Token | undefined, x: Token) =>
      (x.kind === "symbol" && [")", ",", ".", "::"].includes(x.text)) ||
      (p?.kind === "symbol" && ["(", ".", "::"].includes(p.text)) ||
      (x.kind === "symbol" && x.text === "(" && (p?.kind === "quoted" || (p?.kind === "word" && !KEYWORDS.has(p.text))));
    out += !prev || tight(prev, t) ? text : ` ${text}`;
    prev = t;
  }
  return out;
}

export interface ParsedQuery {
  table: string;
  /** "*", or the projected expressions in canonical spelling. */
  projection: "*" | string[];
  /** Names (columns or otherwise) the projection mentions. */
  projectedNames: Set<string>;
  /** Top-level AND terms; one term when the WHERE has a top-level OR. Empty without WHERE. */
  terms: string[];
  /** Names used as `IN name` in the WHERE: CTE references. */
  inRefs: string[];
}

const isWord = (t: Token | undefined, w: string) => t?.kind === "word" && t.text === w;
const isName = (t: Token | undefined) => t?.kind === "word" || t?.kind === "quoted";

export function parseQuery(sql: string): ParsedQuery {
  const tokens = tokenize(sql);
  if (!isWord(tokens[0], "select")) throw new Error("does not start with SELECT");
  const from = topLevelIndex(tokens, (t) => isWord(t, "from"), 1);
  if (from === -1) throw new Error("has no FROM");
  const projectionTokens = tokens.slice(1, from);
  const items = splitTopLevel(projectionTokens, (t) => t.kind === "symbol" && t.text === ",");
  // Any star (*, "T".*) projects every column.
  const star = projectionTokens.some((t) => t.kind === "symbol" && t.text === "*");

  let i = from + 1;
  let table: string | undefined;
  if (isName(tokens[i]) && tokens[i + 1]?.text === "." && isName(tokens[i + 2])) {
    if (tokens[i]?.text !== "public") throw new Error(`reads ${tokens[i]?.text}.${tokens[i + 2]?.text}, outside public`);
    table = tokens[i + 2]?.text;
    i += 3;
  } else if (isName(tokens[i])) {
    table = tokens[i]?.text;
    i += 1;
  }
  if (!table) throw new Error("names no table after FROM");
  let terms: string[] = [];
  let inRefs: string[] = [];
  if (i < tokens.length) {
    if (!isWord(tokens[i], "where")) throw new Error(`has "${tokens[i]?.text}" after the table; only WHERE is understood`);
    const where = tokens.slice(i + 1);
    // An AND inside BETWEEN or CASE is not a conjunction; refuse rather than split it wrongly.
    for (const word of ["between", "case"]) {
      if (where.some((t) => isWord(t, word))) throw new Error(`uses ${word.toUpperCase()}, which this check does not read`);
    }
    inRefs = where.flatMap((t, n) => {
      const next = where[n + 1];
      const after = where[n + 2];
      const ends = !after || isWord(after, "and") || isWord(after, "or") || (after.kind === "symbol" && after.text === ")");
      return isWord(t, "in") && isName(next) && ends ? [(next as Token).text] : [];
    });
    const hasOr = topLevelIndex(where, (t) => isWord(t, "or"), 0) !== -1;
    terms = (hasOr ? [where] : splitTopLevel(where, (t) => isWord(t, "and"))).map(render);
  }
  return {
    table,
    projection: star ? "*" : items.map(render),
    projectedNames: new Set(projectionTokens.filter(isName).map((t) => t.text)),
    terms,
    inRefs,
  };
}

function topLevelIndex(tokens: Token[], match: (t: Token) => boolean, from: number): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind === "symbol" && t.text === "(") depth++;
    else if (t.kind === "symbol" && t.text === ")") depth--;
    else if (depth === 0 && match(t)) return i;
  }
  return -1;
}

function splitTopLevel(tokens: Token[], match: (t: Token) => boolean): Token[][] {
  const parts: Token[][] = [];
  let start = 0;
  for (;;) {
    const at = topLevelIndex(tokens, match, start);
    if (at === -1) break;
    parts.push(tokens.slice(start, at));
    start = at + 1;
  }
  parts.push(tokens.slice(start));
  return parts.filter((p) => p.length > 0);
}
