/**
 * Which sync mutant sent a row. Bucket names cannot say: PowerSync applies auth.parameter()
 * conditions per request, so mutants that differ only there share one bucket, named after
 * whichever stream came first. Instead each mutant query is run in Postgres for the user,
 * with the token's values in place of auth.parameter() and auth.user_id(), and its CTEs as
 * subqueries. A mutant explains a leaked row when its own query returns it.
 */

import type pg from "pg";
import { ident, parseQuery, sqlText, type Token, tokenize } from "samesight/compiler";
import { rolledBack, rows } from "../db.ts";
import type { SyncMutant } from "./mutants.ts";

const quote = (v: unknown) => (v === null || v === undefined ? "null" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);

/** A stream query as Postgres SQL for one user's claims; throws on a construct it does not translate. */
export function toPostgres(sql: string, ctes: Record<string, string>, claims: Record<string, unknown>, depth = 0): string {
  if (depth > 4) throw new Error("CTEs nest too deeply");
  const tokens = tokenize(sql);
  const out: Token[] = [];
  const raw: string[] = [];
  const flush = () => {
    if (out.length) raw.push(sqlText(out.splice(0)));
  };
  const word = (i: number, w: string) => tokens[i]?.kind === "word" && tokens[i]?.text === w;
  const sym = (i: number, s: string) => tokens[i]?.kind === "symbol" && tokens[i]?.text === s;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (word(i, "auth") && sym(i + 1, ".") && word(i + 2, "parameter") && sym(i + 3, "(") && tokens[i + 4]?.kind === "string" && sym(i + 5, ")")) {
      flush();
      raw.push(quote(claims[tokens[i + 4]?.text ?? ""]));
      i += 5;
    } else if (word(i, "auth") && sym(i + 1, ".") && word(i + 2, "user_id") && sym(i + 3, "(") && sym(i + 4, ")")) {
      flush();
      raw.push(quote(claims.sub));
      i += 4;
    } else if (word(i, "auth") || word(i, "subscription") || word(i, "connection") || word(i, "request")) {
      throw new Error(`uses ${t.text}.${tokens[i + 2]?.text ?? ""}, which this check cannot evaluate`);
    } else if (word(i - 1, "from") && (t.kind === "quoted" || t.kind === "word") && !sym(i + 1, ".")) {
      flush();
      raw.push(`public.${ident(t.text)}`);
    } else if (word(i - 1, "in") && t.kind === "word" && Object.keys(ctes).some((c) => c.toLowerCase() === t.text)) {
      flush();
      const name = Object.keys(ctes).find((c) => c.toLowerCase() === t.text) as string;
      raw.push(`(${toPostgres(ctes[name] as string, ctes, claims, depth + 1)})`);
    } else out.push(t);
  }
  flush();
  return raw.join(" ");
}

export interface Sent {
  /**
   * "Table\u0000id" of every row the mutant's queries return for the user, with the columns sent
   * for it: true when a query returning it projects every column, else the union of the
   * names projected by the queries that return it.
   */
  rows: Map<string, true | Set<string>>;
}

/** What the mutant's queries send one user, evaluated as the connecting role (RLS bypassed), never committed. */
export async function sentBy(client: pg.Client, m: SyncMutant, claims: Record<string, unknown>): Promise<Sent> {
  const sent: Sent = { rows: new Map() };
  await rolledBack(client, async () => {
    await client.query("set transaction read only");
    for (const sql of m.queries) {
      const q = parseQuery(sql);
      const projected = q.projection === "*" ? true : new Set([...q.projectedNames]);
      for (const r of await rows<{ id: string }>(client, `select q.id::text as id from (${toPostgres(sql, m.ctes, claims)}) q`)) {
        const key = `${q.table}\u0000${r.id}`;
        const before = sent.rows.get(key);
        sent.rows.set(key, before === true || projected === true ? true : new Set([...(before ?? []), ...projected]));
      }
    }
  });
  return sent;
}
