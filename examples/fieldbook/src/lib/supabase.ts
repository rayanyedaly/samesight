import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

// Fixed so the provider can read the stored session; the default derives from the host.
export const AUTH_STORAGE_KEY = "fieldbook-auth";

let client: SupabaseClient | undefined;

// Browser-only client. The session lives in localStorage, so a signed-in user can
// reopen the app offline.
export function supabase(): SupabaseClient {
  client ??= createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY },
  });
  return client;
}
