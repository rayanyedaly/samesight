/**
 * What lint rules ask of a query's SQL, answered on tokens so that words inside string
 * literals and quoted names never count. A query the tokenizer cannot read gives null;
 * the rules skip it, and unreadable-query reports it.
 */

import type { SyncConfig } from "../sync/config.ts";
import { outputTable } from "../sync/scope.ts";
import { type Token, tokenize } from "../sync/sql.ts";

export function tokens(sql: string): Token[] | null {
  try {
    return tokenize(sql);
  } catch {
    return null;
  }
}

const word = (t: Token | undefined, w: string) => t?.kind === "word" && t.text === w;
const sym = (t: Token | undefined, s: string) => t?.kind === "symbol" && t.text === s;
/** `object.member(` or, with `call` false, `object.member`. */
const member = (t: Token[], i: number, object: string, members: string[], call = true) =>
  word(t[i], object) && sym(t[i + 1], ".") && members.some((m) => word(t[i + 2], m)) && (!call || sym(t[i + 3], "("));

/**
 * Reads who is asking from the verified token: auth.user_id(), auth.parameter(s)() in
 * streams; request.user_id(), request.jwt(), token_parameters.x in sync rules.
 */
export function readsToken(t: Token[]): boolean {
  return t.some(
    (_, i) =>
      member(t, i, "auth", ["user_id", "parameter", "parameters"]) ||
      member(t, i, "request", ["user_id", "jwt"]) ||
      (word(t[i], "token_parameters") && sym(t[i + 1], ".")),
  );
}

/**
 * Reads what the client sent: subscription and connection parameters in streams,
 * request.parameters() and user_parameters.x in sync rules. A client sends anything.
 */
export function readsClient(t: Token[]): boolean {
  return t.some(
    (_, i) =>
      member(t, i, "subscription", ["parameter", "parameters"]) ||
      member(t, i, "connection", ["parameter", "parameters"]) ||
      member(t, i, "request", ["parameters"]) ||
      (word(t[i], "user_parameters") && sym(t[i + 1], ".")),
  );
}

/**
 * Reads the token's user_metadata, which Supabase users set on themselves: the claim named
 * in a string ('user_metadata', as auth.parameter() and -> take it) or after
 * token_parameters.
 */
export function readsUserMetadata(t: Token[]): boolean {
  return t.some(
    (x, i) => (x.kind === "string" && x.text === "user_metadata") || (word(x, "user_metadata") && sym(t[i - 1], ".") && word(t[i - 2], "token_parameters")),
  );
}

/** Reads a bucket parameter (bucket.x), as a sync rules data query must to be per-user. */
export function readsBucket(t: Token[]): boolean {
  return t.some((_, i) => word(t[i], "bucket") && sym(t[i + 1], "."));
}

/** Has a WHERE anywhere: a query without one sends every row of its table. */
export function hasWhere(t: Token[]): boolean {
  return t.some((x) => word(x, "where"));
}

/** Names after IN that are not a parenthesised list: the CTEs a stream query reads. */
export function inNames(t: Token[]): string[] {
  return t.flatMap((x, i) => (word(x, "in") && (t[i + 1]?.kind === "word" || t[i + 1]?.kind === "quoted") ? [(t[i + 1] as Token).text.toLowerCase()] : []));
}

/** The table a query sends, for messages; "its table" when the query is not one audit reads. */
export function tableOf(sql: string): string {
  try {
    return outputTable(sql).table;
  } catch {
    return "its table";
  }
}

/**
 * Each table the config sends to devices, with the first query that sends it. Queries
 * audit cannot read are left out (unreadable-query reports them). Names are as Postgres
 * resolves them, so they match a migration's.
 */
export function sentTables(config: SyncConfig): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of config.streams) {
    for (const q of s.queries) {
      try {
        const { table } = outputTable(q.sql);
        if (!out.has(table)) out.set(table, q.sql);
      } catch {}
    }
  }
  return out;
}
