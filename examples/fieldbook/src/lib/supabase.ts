import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

// Fixed so storedSession() can read it; the default is derived from the URL's host.
const AUTH_STORAGE_KEY = "fieldbook-auth";

let client: SupabaseClient | undefined;

// Browser-only client. The session lives in localStorage, so a signed-in user can
// reopen the app offline.
export function supabase(): SupabaseClient {
  client ??= createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY },
  });
  return client;
}

/**
 * The session supabase-js keeps in storage, even when its access token has expired.
 *
 * Offline with an expired token, getSession() returns null because it cannot refresh,
 * but the stored session (and its refresh token) stays until an explicit sign-out or a
 * refresh the server rejects. Fieldbook keeps such a user signed in on this device:
 * their local data stays usable, and sync resumes once the token can be refreshed.
 */
export function storedSession(): Session | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    const session = raw ? (JSON.parse(raw) as Partial<Session>) : null;
    return session?.access_token && session.refresh_token && session.user?.id ? (session as Session) : null;
  } catch {
    return null;
  }
}

/**
 * Forgets the session on this device without supabase-js. Its signOut() first loads the
 * session, and offline with an expired token that load fails, so it returns the error
 * without removing anything.
 */
export function clearStoredSession(): void {
  for (const key of [AUTH_STORAGE_KEY, `${AUTH_STORAGE_KEY}-user`, `${AUTH_STORAGE_KEY}-code-verifier`]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage unavailable: nothing was stored either.
    }
  }
}
