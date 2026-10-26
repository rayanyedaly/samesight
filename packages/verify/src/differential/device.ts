/**
 * A headless device: @powersync/node with an empty client schema, so every synced row
 * lands untyped and nothing is dropped for want of a column. Rows are read per bucket
 * from the oplog, so a row can be traced to the stream that sent it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema, SyncStreamConnectionMethod } from "@powersync/common";
import { PowerSyncDatabase } from "@powersync/node";

export interface DeviceRow {
  table: string;
  id: string;
  data: Record<string, unknown>;
  /** Each stream whose buckets sent this row (the part of the bucket name before "|"), with the columns it sent. */
  sources: { stream: string; columns: string[] }[];
}

/** One oplog entry, with its bucket's name. */
export interface Op {
  bucket: string;
  row_type: string;
  row_id: string;
  /** Null once the row has left the bucket. */
  data: string | null;
}

/**
 * "3#inspector|1[...]" -> "inspector", and a sync rules bucket "user_lists[\"...\"]" ->
 * "user_lists". PowerSync names a bucket shared by identical queries after the first stream.
 */
export function streamOfBucket(name: string): string {
  const afterVersion = name.includes("#") ? name.slice(name.indexOf("#") + 1) : name;
  return afterVersion.split(/[|[]/)[0] ?? afterVersion;
}

/** Connects with `token`, waits for the first complete sync, and returns every row the device holds. */
export async function syncOnce(endpoint: string, token: string, timeoutMs = 60_000): Promise<DeviceRow[]> {
  const dir = mkdtempSync(join(tmpdir(), "samesight-device-"));
  const db = new PowerSyncDatabase({ schema: new Schema({}), database: { dbFilename: "device.db", dbLocation: dir } });
  try {
    await db.connect(
      { fetchCredentials: async () => ({ endpoint, token }), uploadData: async () => {} },
      { connectionMethod: SyncStreamConnectionMethod.HTTP },
    );
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    try {
      await db.waitForFirstSync({ signal: timeout.signal });
    } finally {
      clearTimeout(timer);
    }
    if (timeout.signal.aborted) {
      // waitForFirstSync only waits: why it never finished (an expired token, a broken config) is in the status.
      const cause = db.currentStatus.dataFlowStatus.downloadError;
      throw new Error(`no complete sync from ${endpoint} within ${timeoutMs / 1000}s${cause ? `: ${cause.message}` : ""}`);
    }
    return rowsFromOps(
      await db.getAll<Op>(
        `select b.name as bucket, o.row_type, o.row_id, o.data
           from ps_oplog o join ps_buckets b on b.id = o.bucket
          where b.name <> '$local'`,
      ),
    );
  } finally {
    await db.disconnectAndClear().catch(() => {});
    await db.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Folds the oplog into rows: each row once, with every column any bucket sent, and which stream sent which. */
export function rowsFromOps(ops: Op[]): DeviceRow[] {
  const byKey = new Map<string, DeviceRow>();
  for (const op of ops) {
    if (op.data === null) continue;
    const key = `${op.row_type}\u0000${op.row_id}`;
    const data = JSON.parse(op.data) as Record<string, unknown>;
    const stream = streamOfBucket(op.bucket);
    const row = byKey.get(key);
    const source = { stream, columns: Object.keys(data) };
    if (!row) byKey.set(key, { table: op.row_type, id: op.row_id, data, sources: [source] });
    else {
      // The same row from several buckets: keep every column any of them sent.
      Object.assign(row.data, data);
      const known = row.sources.find((x) => x.stream === stream);
      if (known) known.columns = [...new Set([...known.columns, ...source.columns])];
      else row.sources.push(source);
    }
  }
  return [...byKey.values()];
}
