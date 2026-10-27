/**
 * Which stream query sent a row a device should not have. The device knows only the stream
 * (the bucket's name, which streams sharing a bucket share too), so each query that sends
 * the row's table is run in Postgres for the user, as mutate/explain.ts runs mutants: the
 * token's values in place of auth.parameter() and auth.user_id(), CTEs as subqueries, read
 * only and rolled back. A query explains the row when it returns it. Runs while the dataset
 * is still in the database.
 */

import type pg from "pg";
import { outputTable, type Stream } from "samesight/compiler";
import { rolledBack, rows } from "../db.ts";
import { toPostgres } from "../mutate/explain.ts";
import type { RowReport } from "../report.ts";

/** At most this many rows are put down to their queries: a counterexample is small. */
const MAX_ROWS = 10;

/** The queries of auto-subscribed streams whose rows land in `table`, with their stream. */
export function candidates(streams: Stream[], table: string): { stream: Stream; label: string; sql: string }[] {
  return streams.flatMap((stream) =>
    !stream.autoSubscribe
      ? []
      : stream.queries.flatMap((q) => {
          try {
            return outputTable(q.sql).table === table ? [{ stream, label: q.label, sql: q.sql }] : [];
          } catch {
            return [];
          }
        }),
  );
}

/**
 * Puts each sent row down to the stream queries that send it to its user: the one query of
 * the streams the device named when there is one, else those that return it when run for
 * the user. A row no query can be run for keeps the streams the device named. Never throws.
 */
export async function sendingQueries(client: pg.Client, streams: Stream[], reports: RowReport[], claimsOf: (userId: string) => Record<string, unknown> | undefined): Promise<void> {
  for (const r of reports.filter((x) => x.sentBy.length).slice(0, MAX_ROWS)) {
    const all = candidates(streams, r.table);
    const named = all.filter((c) => r.sentBy.some((x) => x.stream === c.stream.name));
    if (named.length === 1) {
      const [c] = named as [(typeof named)[number]];
      r.sentBy = [{ stream: c.stream.name, query: c.label, sql: c.sql }];
      continue;
    }
    const claims = claimsOf(r.user.id);
    if (!claims) continue;
    const senders: RowReport["sentBy"] = [];
    try {
      await rolledBack(client, async () => {
        await client.query("set transaction read only");
        for (const c of all) {
          let sql: string;
          try {
            sql = toPostgres(c.sql, Object.fromEntries(c.stream.ctes), claims);
          } catch {
            continue;
          }
          // Each in a savepoint: one that errors (a cast the data refuses) leaves the others.
          await client.query("savepoint q");
          try {
            const found = await rows(client, `select 1 from (${sql}) q where q.id::text = $1 limit 1`, [r.id]);
            if (found.length) senders.push({ stream: c.stream.name, query: c.label, sql: c.sql });
            await client.query("release savepoint q");
          } catch {
            await client.query("rollback to savepoint q");
          }
        }
      });
    } catch {
      continue;
    }
    if (senders.length) r.sentBy = senders;
  }
}
