/** Connections to the local database only, and transactions that never commit. */

import pg from "pg";
import { assertLocal } from "samesight/compiler";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export async function connectLocal(url: string): Promise<pg.Client> {
  assertLocal(url);
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  // The host pg actually resolved (URL, query parameters, PGHOST), in case they differ.
  if (!LOCAL_HOSTS.has(client.host)) throw new Error(`refusing to connect to ${client.host}: not this machine`);
  await client.connect();
  return client;
}

export class DatabaseBusy extends Error {}

/** 55P03 lock_not_available, 57014 query_canceled (the statement timeout), 40P01 deadlock_detected. */
export function isBusy(e: unknown): boolean {
  return e instanceof DatabaseBusy || ["55P03", "57014", "40P01"].includes((e as { code?: string }).code ?? "");
}

/**
 * Runs fn in a transaction that is always rolled back, whatever fn does. DDL inside it
 * takes exclusive locks, so it gives up after a few seconds of waiting rather than
 * stalling PowerSync or the app behind it.
 */
export async function rolledBack<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  let result: T;
  try {
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '60s'");
    result = await fn();
  } catch (e) {
    await client.query("rollback").catch(() => {});
    if (isBusy(e)) throw new DatabaseBusy(`the database is busy (${(e as Error).message}); try again`, { cause: e });
    throw e;
  }
  await client.query("rollback");
  return result;
}

export async function rows<T extends object>(client: pg.Client, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows;
}
