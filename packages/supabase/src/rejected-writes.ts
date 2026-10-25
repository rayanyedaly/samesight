import { type AbstractPowerSyncDatabase, column, Table } from "@powersync/common";

/**
 * Local-only record of writes the server refused for good, captured just before the
 * connector takes them out of the upload queue. Add it to your schema as
 * `RejectedWrite: rejectedWriteTable`.
 *
 * `localOnly` matters in both directions: it must not sync down (it is this device's
 * record of its own failures), and it must not upload, or a refused write would be
 * followed by an endless loop of failures about failures. The server keeps its own copy
 * through `record_rejection`; this one exists so the content is in front of the person
 * who wrote it, even while offline.
 */
export const rejectedWriteTable = new Table(
  {
    resourceType: column.text,
    resourceId: column.text,
    opType: column.text,
    /** The op payload, JSON-encoded: the only copy of what the write carried. */
    payload: column.text,
    httpStatus: column.integer,
    reasonCode: column.text,
    reasonMessage: column.text,
    rejectedAt: column.text,
    /** Set locally when the person has seen it. Rows are never deleted. */
    acknowledgedAt: column.text,
  },
  { localOnly: true },
);

/** One op of an upload, as sent to `apply_batch`. */
export interface CrudOpPayload {
  op: string;
  table: string;
  id: string;
  data: Record<string, unknown>;
}

/** A batch the server permanently refused, handed over before it is discarded. */
export interface RejectedUpload {
  status: number;
  /** Postgres or PostgREST error code, where there was one. */
  code: string | null;
  message: string;
  ops: CrudOpPayload[];
}

/** A local `RejectedWrite` row, as a query returns it. */
export interface RejectedWriteRow {
  id: string;
  resourceType: string;
  resourceId: string;
  opType: string;
  payload: string;
  httpStatus: number;
  reasonCode: string;
  reasonMessage: string;
  rejectedAt: string;
  acknowledgedAt: string | null;
}

/** Rejections the person has not acknowledged yet, newest first. */
export const UNACKNOWLEDGED_REJECTIONS_SQL =
  "SELECT * FROM RejectedWrite WHERE acknowledgedAt IS NULL ORDER BY rejectedAt DESC, id";

/**
 * A v4 UUID on every runtime: `crypto.randomUUID` where it exists, `getRandomValues`
 * where only that is polyfilled (React Native), and Math.random as a last resort. This
 * runs right before a refused write is discarded, and a throw here would leave the
 * queue stuck on that write forever; a weak id on a local-only row costs far less.
 */
export function localUuid(): string {
  const c = (
    globalThis as {
      crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);

  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Persist a refused batch into the local-only RejectedWrite table, one row per op.
 *
 * The connector awaits this before discarding the batch, and lets it throw: if the
 * record cannot be written, the batch stays queued. A stuck queue can be recovered; a
 * write that silently ceased to exist cannot.
 */
export async function recordRejectedLocally(db: AbstractPowerSyncDatabase, info: RejectedUpload): Promise<void> {
  const at = new Date().toISOString();
  await db.writeTransaction(async (tx) => {
    for (const op of info.ops) {
      await tx.execute(
        `INSERT INTO RejectedWrite
           (id, resourceType, resourceId, opType, payload, httpStatus, reasonCode, reasonMessage, rejectedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          localUuid(),
          op.table,
          op.id,
          op.op,
          JSON.stringify(op.data ?? {}),
          info.status,
          info.code ?? "UNKNOWN",
          info.message,
          at,
        ],
      );
    }
  });
}

/**
 * Mark a rejected write as seen. The only change offered: it never deletes the row,
 * because "I have read this" and "this never happened" are different claims.
 */
export async function acknowledgeRejection(db: AbstractPowerSyncDatabase, id: string): Promise<void> {
  await db.execute("UPDATE RejectedWrite SET acknowledgedAt = ? WHERE id = ?", [new Date().toISOString(), id]);
}
