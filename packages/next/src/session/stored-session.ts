import type { Session } from "@supabase/supabase-js";

/**
 * Read supabase-js's persisted session directly from localStorage.
 *
 * Offline with an expired access token, `auth.getSession()` retries the refresh for
 * many seconds and then returns no session while keeping the stored one, so the person
 * would look signed out although nothing signed them out. The stored session is still
 * the right answer to "who is using this device", which is all the store needs to know.
 * Pass the `storageKey` the Supabase client was created with.
 */
export function storedSession(storageKey: string): Session | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session> | null;
    if (!parsed?.access_token || !parsed.refresh_token || !parsed.user?.id) return null;
    return parsed as Session;
  } catch {
    return null;
  }
}

/**
 * Forget the session on this device without the network. `auth.signOut()` offline with
 * an expired token returns early without removing it, so a sign-out has to finish here.
 */
export function clearStoredSession(storageKey: string): void {
  if (typeof localStorage === "undefined") return;
  for (const key of [storageKey, `${storageKey}-user`, `${storageKey}-code-verifier`]) {
    localStorage.removeItem(key);
  }
}
