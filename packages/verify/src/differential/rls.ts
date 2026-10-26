/**
 * What RLS lets a user read, the way PostgREST asks: inside a transaction that is rolled
 * back, `set local role authenticated` and the token's claims in `request.jwt.claims`.
 * `prepare` runs first, as the connecting role, in the same transaction; the mutation
 * test uses it to swap in a mutant policy that never commits.
 */

import type pg from "pg";
import { ident } from "samesight/compiler";
import { rolledBack, rows } from "../db.ts";

export type RlsRows = Map<string, Record<string, unknown>>;

export const rowKey = (table: string, id: string) => `${table}\u0000${id}`;

/** What RLS returns each set of claims, in one transaction: `prepare` runs once, then each reader in turn. */
export async function readAsUsers(
  client: pg.Client,
  readers: Record<string, unknown>[],
  tables: string[],
  prepare?: (client: pg.Client) => Promise<void>,
): Promise<RlsRows[]> {
  return rolledBack(client, async () => {
    if (prepare) await prepare(client);
    const out: RlsRows[] = [];
    for (const claims of readers) {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      const seen: RlsRows = new Map();
      for (const table of tables) {
        for (const r of await rows<{ row: Record<string, unknown> }>(client, `select row_to_json(t) as row from public.${ident(table)} t`)) {
          seen.set(rowKey(table, String(r.row.id)), r.row);
        }
      }
      await client.query("reset role");
      out.push(seen);
    }
    return out;
  });
}
