/**
 * Salt for the password-derived store key. It is not secret: it makes the derived key
 * deterministic (the same password reopens the same store) and blocks precomputation.
 *
 * Kept per user (`<prefix>.kdf.v1.<userId>.salt`), matching the per-user store file, so
 * on a shared device one user's sign-in never re-salts, and so orphans, another user's
 * store. Stored in localStorage so it lives exactly as long as the store does
 * (sessionStorage would vanish with the tab and orphan the store), and removed with
 * that user's store when they sign out and discard it.
 */
const SALT_BYTES = 16;
const saltKey = (prefix: string, userId: string) => `${prefix}.kdf.v1.${userId}.salt`;

function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Sign-in path: the user's existing salt, or 16 new random bytes, persisted. */
export function getOrCreateSalt(prefix: string, userId: string): Uint8Array {
  const existing = peekSalt(prefix, userId);
  if (existing) return existing;
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  localStorage.setItem(saltKey(prefix, userId), b64encode(salt));
  return salt;
}

/** Unlock path: the user's existing salt only. A new salt would never reopen the store. */
export function peekSalt(prefix: string, userId: string): Uint8Array | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(saltKey(prefix, userId));
  return raw ? b64decode(raw) : null;
}

/** True when an encrypted store exists (or existed) for this user on this device. */
export function storeExists(prefix: string, userId: string): boolean {
  return peekSalt(prefix, userId) !== null;
}

/** Discarding the store: drop the salt so the next sign-in starts a fresh store. */
export function clearSalt(prefix: string, userId: string): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(saltKey(prefix, userId));
}
