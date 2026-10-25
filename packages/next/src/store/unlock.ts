import type { EncryptedStore } from "./db";
import { deriveStoreKey } from "./kdf";
import { getOrCreateSalt, peekSalt } from "./kdf-salt";
import { clearSessionKey, setSessionKey } from "./session-key";

/**
 * Sign-in: derive the store key from the password (creating this user's salt on their
 * first sign-in on this device) and hold it in memory. This is the one moment the
 * plain password is available in the browser.
 */
export async function deriveAndHoldKey(store: EncryptedStore, userId: string, password: string): Promise<void> {
  const salt = getOrCreateSalt(store.prefix, userId);
  setSessionKey(userId, await deriveStoreKey(password, salt));
}

export type UnlockResult = "ok" | "wrong" | "recover";

/**
 * Unlock after a reload: derive the key from the password and this user's existing
 * salt, then trial-open the store, entirely offline.
 *  - "ok":      the store opened and stays open.
 *  - "wrong":   wrong password; the store is untouched and the key dropped.
 *  - "recover": the store will not open for a reason other than the key (a schema
 *               change, corruption); the caller offers an explicit reset. Never a wipe.
 *
 * A password changed on another device keeps unlocking this device with the old one
 * until the next sign-in here.
 */
export async function tryUnlock(store: EncryptedStore, userId: string, password: string): Promise<UnlockResult> {
  const salt = peekSalt(store.prefix, userId);
  if (!salt) return "wrong";
  setSessionKey(userId, await deriveStoreKey(password, salt));
  if (!(await store.open())) {
    clearSessionKey();
    return "wrong";
  }
  const probe = await store.probe();
  if (probe === "ok") return "ok";
  await store.close();
  clearSessionKey();
  return probe === "wrong-key" ? "wrong" : "recover";
}
