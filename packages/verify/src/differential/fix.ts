/**
 * The fix a leak most likely needs, for one narrow case only: one stream query sent the row,
 * one permissive policy refused it, and that policy is nothing but `column = auth.uid()`,
 * a filter the query lacks. The suggestion is the query with that filter added, and it is
 * made only when the amended query, run for the user, no longer returns the row. Anything
 * wider (joins, OR, subqueries, CTEs, sync rules, several policies) gets no suggestion: a
 * wrong fix is worse than none.
 */

import type pg from "pg";
import { claimReads, ident, outputTable, type Stream, type Token, tokenize } from "samesight/compiler";
import { rolledBack, rows } from "../db.ts";
import { toPostgres } from "../mutate/explain.ts";
import type { RowReport } from "../report.ts";
import { candidates } from "./attribute.ts";

/** At most this many rows get a suggestion: a counterexample is small. */
const MAX_ROWS = 10;

/** Words that make a query too wide for the rule: it then suggests nothing. (NOT binds tighter than AND, so it may stay.) */
const WIDE = new Set(["join", "or", "union", "intersect", "except", "order", "limit", "group", "having", "with"]);

export type Fix = NonNullable<RowReport["fix"]>;

/** The column a policy compares with the user id, when that comparison is all it is. */
export function ownerColumn(qual: string): string | undefined {
  const found = claimReads(qual, "postgres");
  const [read, ...more] = found.reads;
  if (!read || more.length || found.unreadable.length) return undefined;
  if (read.path.join(".") !== "sub" || read.casts.length || read.inSubquery || read.compared.kind !== "column" || read.compared.negated || read.compared.qualifier) return undefined;
  const column = read.compared.column;
  // Nothing else: `col = auth.uid()` either way round, with Supabase's `(select auth.uid() as uid)` wrap.
  const shape = tokenize(qual)
    .filter((t) => !(t.kind === "symbol" && (t.text === "(" || t.text === ")")))
    .map((t) => (t.kind === "quoted" || t.kind === "word" ? t.text : t.kind === "symbol" ? t.text : `\0${t.kind}`))
    .join(" ")
    .replace(/select auth \. uid as uid/g, "auth . uid");
  return shape === `${column} = auth . uid` || shape === `auth . uid = ${column}` ? column : undefined;
}

/** The query with the owner filter added, or undefined when the query is too wide for the rule. */
export function suggestFix(query: { label: string; sql: string }, ctes: ReadonlyMap<string, string>, policy: { name: string; qual: string }, table: string): (Fix & { sql: string }) | undefined {
  const column = ownerColumn(policy.qual);
  if (!column) return undefined;
  let tokens: Token[];
  try {
    tokens = tokenize(query.sql);
    if (outputTable(query.sql).table !== table) return undefined;
  } catch {
    return undefined;
  }
  const words = tokens.filter((t) => t.kind === "word").map((t) => t.text);
  if (words.some((w) => WIDE.has(w)) || words.filter((w) => w === "select").length !== 1) return undefined;
  const cteNames = new Set([...ctes.keys()].map((c) => c.toLowerCase()));
  if (words.some((w) => cteNames.has(w))) return undefined;
  const found = claimReads(query.sql, "streams");
  if (found.unreadable.length) return undefined;
  // It filters on the column already: the leak is elsewhere.
  if (found.reads.some((r) => r.compared.kind === "column" && r.compared.column === column)) return undefined;
  const add = `${words.includes("where") ? "AND" : "WHERE"} ${ident(column)} = auth.user_id()`;
  return {
    query: query.label,
    add,
    why: `${query.label} has no ${column} filter, which policy "${policy.name}" has`,
    sql: `${query.sql.trim().replace(/;$/, "")} ${add}`,
  };
}

/**
 * Sets `fix` on each leak the rule covers, once the amended query, run for the user, no
 * longer returns the row (and the query as it is does). Never throws.
 */
export async function likelyFixes(client: pg.Client, sync: { kind: string; streams: Stream[] }, reports: RowReport[], claimsOf: (userId: string) => Record<string, unknown> | undefined): Promise<void> {
  if (sync.kind !== "streams") return;
  for (const r of reports.filter((x) => x.kind === "leak").slice(0, MAX_ROWS)) {
    const [sent, ...others] = r.sentBy;
    const permissive = (r.policies ?? []).filter((p) => p.permissive);
    const [policy] = permissive;
    if (!sent?.sql || !sent.query || others.length || permissive.length !== 1 || policy?.verdict !== "refuses") continue;
    if (r.policies?.some((p) => !p.permissive && p.verdict === "refuses")) continue;
    // An identical query in another stream shares its bucket and sends the row too: fixing one would leave the other.
    const same = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (candidates(sync.streams, r.table).filter((c) => same(c.sql) === same(sent.sql as string)).length > 1) continue;
    const stream = sync.streams.find((s) => s.name === sent.stream);
    const claims = claimsOf(r.user.id);
    if (!stream || !claims) continue;
    try {
      const [row] = await rows<{ qual: string | null }>(
        client,
        `select pg_catalog.pg_get_expr(p.polqual, p.polrelid) as qual from pg_catalog.pg_policy p
           join pg_catalog.pg_class c on c.oid = p.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = $1 and p.polname = $2`,
        [r.table, policy.name],
      );
      if (!row?.qual) continue;
      const fix = suggestFix({ label: sent.query, sql: sent.sql }, stream.ctes, { name: policy.name, qual: row.qual }, r.table);
      if (!fix) continue;
      const ctes = Object.fromEntries(stream.ctes);
      const returns = async (sql: string) => (await rows(client, `select 1 from (${toPostgres(sql, ctes, claims)}) q where q.id::text = $1 limit 1`, [r.id])).length > 0;
      const confirmed = await rolledBack(client, async () => {
        await client.query("set transaction read only");
        return (await returns(sent.sql as string)) && !(await returns(fix.sql));
      });
      if (confirmed) r.fix = { query: fix.query, add: fix.add, why: fix.why };
    } catch {
      // No suggestion: a query or policy it cannot run.
    }
  }
}
