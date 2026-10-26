import { UNACKNOWLEDGED_REJECTIONS_SQL } from "@samesight/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EncryptedStore } from "../store/db.ts";
import { clearStoredSession, storedSession } from "./stored-session.ts";

/**
 * Three ways to leave a session, and they are not interchangeable:
 *
 *   lockStore       Idle timeout. Forgets the key and closes the store, KEEPS the store
 *                   and the Supabase session. Needs no network; the unlock screen
 *                   reopens the same store, queue intact.
 *   signOutKeeping  Ends the Supabase session and locks the store. Unsynced writes
 *                   survive and upload after the same user signs in again.
 *   signOutAndWipe  DESTRUCTIVE. Purges the store (synced rows and the unsynced queue)
 *                   and its salt. Only after the caller checked `unsyncedCount` and,
 *                   when it is not zero, a confirmation that names the loss.
 */

export const SIGN_OUT_TIMEOUT_MS = 3000;

export interface SessionTarget {
  supabase: SupabaseClient;
  /** The `storageKey` the Supabase client was created with. */
  authStorageKey: string;
}

/**
 * End the Supabase session: revoke the refresh token when the network allows, and
 * always forget the session on this device. Never throws, and returns within
 * SIGN_OUT_TIMEOUT_MS: offline with an expired token, supabase-js retries the refresh
 * for many seconds and then returns without removing anything.
 */
export async function endSession({ supabase, authStorageKey }: SessionTarget): Promise<void> {
  const result = await Promise.race([
    supabase.auth.signOut({ scope: "local" }).catch((error: unknown) => ({ error })),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SIGN_OUT_TIMEOUT_MS)),
  ]);
  if (!result || result.error || storedSession(authStorageKey)) clearStoredSession(authStorageKey);
}

/** Idle lock: forget the key, close the store. Keeps the store, its salt and the session. */
export async function lockStore(store: EncryptedStore): Promise<void> {
  await store.lock().catch(() => {});
}

/** Sign out and keep the store: unsynced writes upload after the next sign-in. */
export async function signOutKeeping(store: EncryptedStore, target: SessionTarget): Promise<void> {
  await lockStore(store);
  await endSession(target);
}

/** DESTRUCTIVE: purge the store and its salt, then sign out. Check `unsyncedCount` first. */
export async function signOutAndWipe(store: EncryptedStore, target: SessionTarget, userId?: string): Promise<void> {
  await store.clearLocalData(userId).catch(() => {});
  await endSession(target);
}

/**
 * Local writes a wipe would destroy, consult before any: those not yet accepted by the
 * server, and refused writes the user has not acknowledged (the banner's records are the
 * only copy left on this device). Null when the queue cannot be read, which callers must
 * treat as "there may be unsynced work".
 */
export async function unsyncedCount(store: EncryptedStore): Promise<number | null> {
  const db = store.current();
  // No open database (closing, locked, or never opened): the queue cannot be read.
  if (!db) return null;
  let queued: number;
  try {
    const stats = await db.getUploadQueueStats(false);
    queued = stats?.count ?? 0;
  } catch {
    return null;
  }
  try {
    const [row] = await db.getAll<{ n: number }>(`SELECT count(*) AS n FROM (${UNACKNOWLEDGED_REJECTIONS_SQL})`);
    return queued + Number(row?.n ?? 0);
  } catch {
    // A schema without the RejectedWrite table has none to lose.
    return queued;
  }
}
