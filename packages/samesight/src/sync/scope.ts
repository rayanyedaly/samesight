/**
 * What a hand-written sync config sends: for each query, the table its rows land in.
 * Audit mode compares those tables, as each user's devices hold them, with what RLS
 * returns the same user. Only what a query's FROM and JOINs name is read; anything else
 * is refused, never guessed at.
 */

import type { Finding } from "../doctor.ts";
import { type Token, tokenize } from "./sql.ts";
import type { Stream } from "./streams.ts";

const isWord = (t: Token | undefined, w: string) => t?.kind === "word" && t.text === w;
const isName = (t: Token | undefined) => t?.kind === "word" || t?.kind === "quoted";
const sym = (t: Token | undefined, s: string) => t?.kind === "symbol" && t.text === s;

/** Words that end a join's ON condition: the next clause, understood or refused. */
const CLAUSE_END = new Set(["join", "inner", "left", "right", "full", "cross", "natural", "lateral", "where", "group", "order", "limit", "offset", "having", "union", "except", "intersect"]);

/** Words that end a table reference, so they are never read as its alias. */
const CLAUSE = new Set(["where", "join", "inner", "left", "right", "full", "cross", "on", "using", "group", "order", "limit"]);

interface TableRef {
  table: string;
  alias: string;
}

/** `[public.]name [[AS] alias]` at `i`; the reference and the index after it. */
function tableRef(tokens: Token[], i: number): { ref: TableRef; next: number } {
  let table: string | undefined;
  if (isName(tokens[i]) && sym(tokens[i + 1], ".") && isName(tokens[i + 2])) {
    if (tokens[i]?.text !== "public") throw new Error(`reads ${tokens[i]?.text}.${tokens[i + 2]?.text}, outside public`);
    table = tokens[i + 2]?.text;
    i += 3;
  } else if (isName(tokens[i]) && !(tokens[i]?.kind === "word" && CLAUSE.has(tokens[i]?.text ?? ""))) {
    table = tokens[i]?.text;
    i += 1;
  }
  if (!table) throw new Error(`names no table at "${tokens[i]?.text ?? "the end"}"`);
  let alias = table;
  if (isWord(tokens[i], "as") && isName(tokens[i + 1])) {
    alias = tokens[i + 1]?.text as string;
    i += 2;
  } else if (isName(tokens[i]) && !(tokens[i]?.kind === "word" && CLAUSE.has(tokens[i]?.text ?? ""))) {
    alias = tokens[i]?.text as string;
    i += 1;
  }
  return { ref: { table, alias }, next: i };
}

/** Index of the first token at paren depth 0 from `from` that matches. */
function topLevel(tokens: Token[], match: (t: Token, i: number) => boolean, from: number): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (sym(t, "(")) depth++;
    else if (sym(t, ")")) depth--;
    else if (depth === 0 && match(t, i)) return i;
  }
  return -1;
}

/**
 * The table one stream query's rows come from, the table they land in on the device (PowerSync
 * names it after an alias: `FROM documents d` sends rows of type d), and every table it reads.
 */
export function outputTable(sql: string): { table: string; deviceTable: string; reads: string[]; aliases: Record<string, string> } {
  const tokens = tokenize(sql);
  if (!isWord(tokens[0], "select")) throw new Error("does not start with SELECT");
  const from = topLevel(tokens, (t) => isWord(t, "from"), 1);
  if (from === -1) throw new Error("has no FROM");
  const first = tableRef(tokens, from + 1);
  const refs = [first.ref];
  let i = first.next;
  // [INNER] JOIN t [alias] ON ..., up to the next top-level clause: any other one is refused below.
  while (i < tokens.length && !isWord(tokens[i], "where")) {
    if (isWord(tokens[i], "inner")) i++;
    if (!isWord(tokens[i], "join")) throw new Error(`has "${tokens[i]?.text}" after the tables; only [INNER] JOIN ... ON and WHERE are understood`);
    const joined = tableRef(tokens, i + 1);
    if (!isWord(tokens[joined.next], "on")) throw new Error(`joins ${joined.ref.table} without ON`);
    refs.push(joined.ref);
    const end = topLevel(tokens, (t) => t.kind === "word" && CLAUSE_END.has(t.text), joined.next + 1);
    i = end === -1 ? tokens.length : end;
  }
  const projection = tokens.slice(1, from);
  // Which table's rows: the qualifier of `x.*`, or of every qualified column; a bare * only without joins.
  const qualifiers = new Set<string>();
  projection.forEach((t, n) => {
    if (isName(t) && sym(projection[n + 1], ".")) qualifiers.add(t.text);
  });
  const bareStar = projection.some((t, n) => sym(t, "*") && !sym(projection[n - 1], "."));
  let out: TableRef | undefined;
  if (refs.length === 1 && !qualifiers.size) out = first.ref;
  else if (bareStar && refs.length > 1) throw new Error("selects * across a join; name the table, as in t.*");
  else if (qualifiers.size === 1) {
    const q = [...qualifiers][0];
    out = refs.find((r) => r.alias === q);
    if (!out) throw new Error(`selects from ${q}, which its FROM does not name`);
  } else throw new Error("selects columns of more than one table");
  if (refs.length > 1) {
    // In a join, an unqualified name could be another table's column, sent with this table's rows.
    // AS and the alias after it name the device column, not a source column.
    const bare = projection.find(
      (t, n) =>
        isName(t) && !isWord(t, "as") && !sym(projection[n - 1], ".") && !sym(projection[n + 1], ".") && !sym(projection[n + 1], "(") && !isWord(projection[n - 1], "as"),
    );
    if (bare) throw new Error(`selects ${bare.text} without its table in a join; qualify it, as in ${out.alias}.${bare.text}`);
  }
  return { table: out.table, deviceTable: out.alias, reads: [...new Set(refs.map((r) => r.table))], aliases: Object.fromEntries(refs.map((r) => [r.alias, r.table])) };
}

/** Every public table a query names after FROM or JOIN, at any depth (subqueries included). */
export function tablesNamed(sql: string): string[] {
  const tokens = tokenize(sql);
  const out = new Set<string>();
  tokens.forEach((t, n) => {
    if (!isWord(t, "from") && !isWord(t, "join")) return;
    const next = tokens[n + 1];
    if (!isName(next)) return;
    if (sym(tokens[n + 2], ".") && isName(tokens[n + 3])) {
      if (next?.text === "public") out.add(tokens[n + 3]?.text as string);
    } else out.add(next?.text as string);
  });
  return [...out];
}

/**
 * Records that devices hold `table` rows under `deviceTable` in `names` (device name to source
 * table); throws when that name already holds another table's rows, which no one could tell apart.
 */
export function holdAs(names: Map<string, string>, o: { table: string; deviceTable: string }): void {
  const known = names.get(o.deviceTable);
  if (known !== undefined && known !== o.table) {
    throw new Error(`sends ${o.table} rows as ${o.deviceTable}, a name devices already hold ${known} rows under; rows of the two could not be told apart`);
  }
  names.set(o.deviceTable, o.table);
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface AuditScope {
  /** Tables some stream sends to devices. */
  synced: string[];
  /** Tables the stream queries read, synced or not. */
  reads: string[];
  /** Each table name devices hold, with the synced table its rows come from (the same name unless aliased). */
  deviceTables: Record<string, string>;
  findings: Finding[];
}

/**
 * The synced tables of a sync config's streams (or bucket definitions, read as streams),
 * with a finding per unreadable query or unchecked stream.
 */
export function auditScope(streams: Stream[], kind: "streams" | "bucket definitions" = "streams"): AuditScope {
  const check = kind === "streams" ? "streams" : "sync rules";
  const synced = new Set<string>();
  const reads = new Set<string>();
  const deviceTables = new Map<string, string>();
  const findings: Finding[] = [];
  let queries = 0;
  for (const s of streams) {
    if (!s.autoSubscribe) {
      // A device holds its rows only once the app subscribes, with parameters this run cannot know.
      findings.push({ status: "warn", check, detail: `${s.name} is not auto_subscribe, so no device here subscribes to it and its rows are not compared` });
      continue;
    }
    // Tables the stream's CTEs read (memberships, shares) get rows too, so those branches are exercised.
    for (const [name, sql] of s.ctes) {
      try {
        for (const r of tablesNamed(sql)) reads.add(r);
      } catch (e) {
        findings.push({ status: "fail", check, detail: `${s.name} ${kind === "streams" ? `with.${name}` : name} ${(e as Error).message}: ${sql}` });
      }
    }
    for (const q of s.queries) {
      try {
        const o = outputTable(q.sql);
        holdAs(deviceTables, o);
        synced.add(o.table);
        for (const r of [...o.reads, ...tablesNamed(q.sql)]) reads.add(r);
        queries++;
      } catch (e) {
        findings.push({ status: "fail", check, detail: `${s.name} ${q.label} ${(e as Error).message}: ${q.sql}` });
      }
    }
  }
  if (!findings.length) {
    findings.push({ status: "ok", check, detail: `${count(streams.length, kind === "streams" ? "stream" : "bucket definition")}, ${count(queries, "query", "queries")}, sending ${[...synced].sort().join(", ") || "nothing"}` });
  }
  if (!synced.size && !findings.some((f) => f.status === "fail")) findings.push({ status: "fail", check, detail: `no ${kind === "streams" ? "stream" : "bucket definition"} sends any table` });
  return { synced: [...synced].sort(), reads: [...reads].sort(), deviceTables: Object.fromEntries([...deviceTables].sort()), findings };
}
