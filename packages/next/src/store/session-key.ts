/**
 * In-memory holder of the derived store key and the user it belongs to.
 *
 * The key is derived from the sign-in password (see kdf.ts) and held only in this
 * module variable: never in localStorage, sessionStorage, IndexedDB or OPFS. Only the
 * non-secret salt is persisted. Because the key is deterministic, the unlock screen can
 * derive it again offline after a reload, which is what lets the encrypted store
 * persist across reloads.
 *
 * The user id is kept with the key so each user on a shared device opens only their own
 * store and never touches another user's unsynced writes.
 */
interface HeldKey {
  userId: string;
  key: string;
}
let held: HeldKey | null = null;

/** Hold the derived key and its user in memory (after sign-in or a successful unlock). */
export function setSessionKey(userId: string, hex: string): void {
  held = { userId, key: hex };
}

/** The derived key, or null before sign-in or unlock. */
export function getSessionKey(): string | null {
  return held?.key ?? null;
}

/** The user the held key belongs to, or null. */
export function getSessionUserId(): string | null {
  return held?.userId ?? null;
}

/** True once a key is held in memory. */
export function hasSessionKey(): boolean {
  return held !== null;
}

/** Forget the key and its user (sign-out, idle lock, failed unlock). */
export function clearSessionKey(): void {
  held = null;
}
