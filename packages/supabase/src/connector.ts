import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from "@powersync/common";
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyUploadError } from "./errors.ts";
import { type CrudOpPayload, type RejectedUpload, recordRejectedLocally } from "./rejected-writes.ts";

/** record_rejection accepts at most 100 entries per call. */
const RECORD_CHUNK = 100;
const UPLOAD_TIMEOUT_MS = 30_000;
/** Failed attempts at one batch before onStuck says so (it keeps retrying). */
const ATTEMPTS_BEFORE_STUCK = 8;

/** A batch held in the queue because discarding it would be worse (see `UploadOutcome`). */
export interface StuckUpload {
  status: number;
  code: string | null;
  message: string;
  opCount: number;
}

export interface SupabaseConnectorOptions {
  supabase: SupabaseClient;
  /** The PowerSync service endpoint. */
  powersyncUrl: string;
  /**
   * Called with a batch the server refused for good, before it is taken out of the
   * queue. It must persist before returning, and it may throw: then the batch stays
   * queued. Defaults to `recordRejectedLocally`, which needs `rejectedWriteTable` in
   * the schema.
   */
  onRejected?: (db: AbstractPowerSyncDatabase, info: RejectedUpload) => Promise<void> | void;
  /** Called when a batch is held instead of retried or rejected (HTTP 413, missing RPC). */
  onStuck?: (info: StuckUpload) => void;
  /** Called after a batch is applied, e.g. to clear a "held" notice. */
  onUploaded?: () => void;
  /**
   * Whether this device still holds a session, for example read from storage. When
   * `getSession()` finds none but this returns true (a stored session whose token
   * cannot be refreshed yet), credentials are retried instead of treated as signed out.
   */
  isSignedIn?: () => boolean;
  /**
   * The user whose local database this connector serves. When set, credentials and
   * uploads are refused (and retried later) while the Supabase session belongs to
   * anyone else, for example after another tab signed in as a different user: one
   * user's queued writes must never go up under another user's token, nor their rows
   * come down into this database. Null means no owner yet, which also refuses.
   */
  ownerId?: () => string | null;
  /** Names of the Postgres functions to call. */
  functions?: { applyBatch?: string; recordRejection?: string };
}

/**
 * PowerSync connector for Supabase: credentials from the Supabase session, and each
 * upload transaction sent as one `apply_batch` call, so it commits or fails as a unit
 * and RLS checks every row as the signed-in user.
 *
 * `transaction.complete()` removes the write from the device, so it runs only once the
 * write is resolved: applied, or refused for good and recorded locally first.
 */
export class SupabaseConnector implements PowerSyncBackendConnector {
  private readonly applyBatch: string;
  private readonly recordRejection: string;
  private refreshedForNoTenant = false;
  /** The batch being retried and how many times it failed, to notice one that never goes through. */
  private attempts: { id: number; count: number } | null = null;

  constructor(private readonly options: SupabaseConnectorOptions) {
    this.applyBatch = options.functions?.applyBatch ?? "apply_batch";
    this.recordRejection = options.functions?.recordRejection ?? "record_rejection";
  }

  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const { data, error } = await this.options.supabase.auth.getSession();
    // Offline with an expired token, supabase-js returns an error and no session while
    // keeping the stored one. Throw so PowerSync retries, rather than treating it as
    // signed out.
    if (error) throw error;
    if (!data.session) {
      if (this.options.isSignedIn?.()) throw new Error("Session cannot be refreshed yet");
      return null;
    }
    this.assertOwner(data.session.user?.id);
    return { endpoint: this.options.powersyncUrl, token: data.session.access_token };
  }

  private assertOwner(sessionUserId: string | undefined): void {
    if (!this.options.ownerId) return;
    const owner = this.options.ownerId();
    if (!owner || sessionUserId !== owner) {
      throw new Error("The session does not belong to this database's user; waiting");
    }
  }

  async uploadData(db: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await db.getNextCrudTransaction();
    if (!transaction) return;
    // The token checked here is the one sent: read again at request time, it could
    // already belong to a user another tab just signed in.
    let token: string | undefined;
    if (this.options.ownerId) {
      const { data } = await this.options.supabase.auth.getSession();
      this.assertOwner(data.session?.user?.id);
      token = data.session?.access_token;
    }
    const call = (fn: string, args: Record<string, unknown>) => {
      // A dead connection (a mobile network change) would otherwise hold the whole queue
      // until reload; an abort comes back as status 0, which retries.
      const request = this.options.supabase.rpc(fn, args).abortSignal(AbortSignal.timeout(UPLOAD_TIMEOUT_MS));
      return token ? request.setHeader("Authorization", `Bearer ${token}`) : request;
    };

    const ops: CrudOpPayload[] = transaction.crud.map((op) => ({
      op: op.op,
      table: op.table,
      id: op.id,
      data: op.opData ?? {},
    }));

    const response = await call(this.applyBatch, { ops });
    const { status } = response;
    if (!response.error && response.data === ops.length) {
      this.refreshedForNoTenant = false;
      this.attempts = null;
      await transaction.complete();
      this.options.onUploaded?.();
      return;
    }
    // apply_batch answers with the number of ops it applied. postgrest-js turns some 404s
    // (a wrong URL, a proxy, a service worker) into an empty success, so a 2xx without that
    // answer did not reach the database: hold the batch and say so.
    const error = response.error ?? {
      code: "",
      message:
        status >= 200 && status < 300
          ? `answered ${status} without confirming the ${ops.length} op(s); is the Supabase URL right, and is apply_batch current?`
          : `unexpected status ${status}`,
    };
    const unconfirmed = !response.error && status >= 200 && status < 300;

    const code = error.code || null;
    const outcome = unconfirmed ? "stuck" : classifyUploadError({ status, code, message: error.message });
    const label = `${this.applyBatch} failed (${code ?? status}): ${error.message}`;
    const stuck = () => this.options.onStuck?.({ status, code, message: error.message, opCount: ops.length });
    // A batch that keeps failing (a statement that always times out, a token the server
    // keeps refusing) is retried as before, but someone is told once it has failed a while.
    if (outcome === "retry" || outcome === "reauth") {
      const id = transaction.transactionId ?? -1;
      this.attempts = this.attempts?.id === id ? { id, count: this.attempts.count + 1 } : { id, count: 1 };
      if (this.attempts.count === ATTEMPTS_BEFORE_STUCK) stuck();
    }

    if (outcome === "reauth") {
      // A token without a tenant (28000) that a refresh did not fix: the user has no
      // membership. Hold and tell someone, rather than refreshing every few seconds.
      if (code === "28000" && this.refreshedForNoTenant) {
        stuck();
        throw new Error(`${label}; held in the queue`);
      }
      this.refreshedForNoTenant = code === "28000";
      await this.options.supabase.auth.refreshSession().catch(() => {});
      throw new Error(`${label}; session refreshed, will retry`);
    }
    if (outcome === "stuck") {
      stuck();
      throw new Error(`${label}; held in the queue`);
    }
    if (outcome === "retry") throw new Error(`${label}; will retry`);

    const info: RejectedUpload = { status, code, message: error.message, ops };
    // If the local record fails, the batch stays queued (rethrown), and someone is told: it
    // will fail the same way next time (a schema without the RejectedWrite table).
    try {
      await (this.options.onRejected ?? recordRejectedLocally)(db, info);
    } catch (e) {
      this.options.onStuck?.({ status, code, message: `refused, but could not be recorded locally: ${(e as Error).message}`, opCount: ops.length });
      throw e;
    }
    // Best effort: the server copy lets an admin see what failed across the team. The
    // local record is the one that matters, so a failure here is only logged.
    const rejections = ops.map((op) => ({ ...op, code, message: error.message, status }));
    for (let i = 0; i < rejections.length; i += RECORD_CHUNK) {
      try {
        const { error: recordError } = await call(this.recordRejection, {
          rejections: rejections.slice(i, i + RECORD_CHUNK),
        });
        if (recordError) console.warn(`${this.recordRejection} failed: ${recordError.message}`);
      } catch (e) {
        console.warn(`${this.recordRejection} failed`, e);
      }
    }
    await transaction.complete();
  }
}
