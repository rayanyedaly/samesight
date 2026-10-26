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
    // postgrest-js turns some non-JSON 404s (a wrong URL, a proxy) into an empty success,
    // so require a 2xx as well before taking the batch out of the queue.
    const error =
      response.error ??
      (status >= 200 && status < 300 ? null : { code: "", message: `unexpected status ${status}` });
    if (!error) {
      this.refreshedForNoTenant = false;
      await transaction.complete();
      this.options.onUploaded?.();
      return;
    }

    const code = error.code || null;
    const outcome = classifyUploadError({ status, code });
    const label = `${this.applyBatch} failed (${code ?? status}): ${error.message}`;

    if (outcome === "reauth") {
      // A token without a tenant (28000) that a refresh did not fix: the user has no
      // membership. Hold and tell someone, rather than refreshing every few seconds.
      if (code === "28000" && this.refreshedForNoTenant) {
        this.options.onStuck?.({ status, code, message: error.message, opCount: ops.length });
        throw new Error(`${label}; held in the queue`);
      }
      this.refreshedForNoTenant = code === "28000";
      await this.options.supabase.auth.refreshSession().catch(() => {});
      throw new Error(`${label}; session refreshed, will retry`);
    }
    if (outcome === "stuck") {
      this.options.onStuck?.({ status, code, message: error.message, opCount: ops.length });
      throw new Error(`${label}; held in the queue`);
    }
    if (outcome === "retry") throw new Error(`${label}; will retry`);

    const info: RejectedUpload = { status, code, message: error.message, ops };
    // Deliberately not caught: if the local record fails, the batch stays queued.
    await (this.options.onRejected ?? recordRejectedLocally)(db, info);
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
