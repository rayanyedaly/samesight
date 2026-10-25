import {
  type AbstractPowerSyncDatabase,
  type PowerSyncBackendConnector,
  type PowerSyncCredentials,
  UpdateType,
} from "@powersync/web";
import { env } from "../env";
import { storedSession, supabase } from "../supabase";
import { isPermanent } from "./upload-errors";

// Columns the server sets (identity, defaults, triggers). Never sent, so a stale local
// value cannot be rejected or overwrite the server's.
const SERVER_OWNED = ["seq", "createdAt", "updatedAt"];

type Outcome = { error: { code?: string; message: string } | null; status: number; data?: unknown[] | null };

function withoutServerOwned(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const out = { ...data };
  for (const column of SERVER_OWNED) delete out[column];
  return out;
}

/**
 * Phase 1 connector, adapted from PowerSync's Supabase demo: credentials come from the
 * Supabase session; uploads go row by row through supabase-js.
 *
 * Known gaps, closed by @samesight/supabase in Phase 2: a transaction is not applied
 * atomically, and a permanently rejected write is logged and dropped instead of being
 * kept and shown.
 */
export class FieldbookConnector implements PowerSyncBackendConnector {
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const { data, error } = await supabase().auth.getSession();
    if (error) throw error;
    if (!data.session) {
      // Signed in on this device but the token cannot be refreshed yet (offline):
      // throw so PowerSync keeps retrying, instead of stopping as if signed out.
      if (storedSession()) throw new Error("Session cannot be refreshed yet");
      return null;
    }
    return { endpoint: env.powersyncUrl, token: data.session.access_token };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    for (const op of transaction.crud) {
      const table = supabase().from(op.table);
      let result: Outcome;
      switch (op.op) {
        case UpdateType.PUT: {
          // Fieldbook writes PUT only for new rows, so a conflict is a replay: skip it
          // (ON CONFLICT DO NOTHING). An upsert that updates would need UPDATE on every
          // column, including id and tenantId, which clients are not granted.
          const record = { ...withoutServerOwned(op.opData), id: op.id };
          result = await table.upsert(record, { onConflict: "id", ignoreDuplicates: true });
          break;
        }
        // RLS hides rows the caller may not change, and PostgREST then reports success
        // with 0 rows. Ask for the ids back so a hidden row counts as a rejection.
        case UpdateType.PATCH:
          result = await table.update(withoutServerOwned(op.opData)).eq("id", op.id).select("id");
          break;
        case UpdateType.DELETE:
          result = await table.delete().eq("id", op.id).select("id");
          break;
      }

      // A DELETE that finds nothing is done (it may be a retry after a lost response).
      const hidden =
        op.op === UpdateType.PATCH && !result.error && Array.isArray(result.data) && result.data.length === 0;
      if (hidden || (result.error && isPermanent(result.status))) {
        // Phase 1 only: dropped, and the rest of the transaction still goes up.
        // Phase 2 keeps it in a dead-letter table and shows it.
        const reason = hidden ? "row not found or not writable" : result.error;
        console.error("Write rejected by the server; discarding it", op.toJSON(), reason);
        continue;
      }
      if (result.error) {
        // Network failure or a temporary server error: PowerSync retries later.
        const code = result.error.code || String(result.status || "network");
        throw new Error(`Upload failed (${code}): ${result.error.message}`);
      }
    }

    await transaction.complete();
  }
}
