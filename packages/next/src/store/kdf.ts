/**
 * Password-derived key for the encrypted local store.
 *
 * The store's encryption key is derived from the user's sign-in password with WebCrypto
 * PBKDF2, in the browser, and never persisted. Deriving it from the password rather
 * than generating a random key is what lets the store survive a reload and stay
 * encrypted: after a reload the key is gone from memory, but the unlock screen derives
 * the same key again, offline, from the same password and the stored salt.
 *
 * PBKDF2 is built into every browser, so the unlock path needs no extra asset to cache
 * or load offline. Password strength is enforced where it belongs, at Supabase Auth.
 * `PBKDF2_ITERATIONS` is versioned so it can be raised over time.
 */

// OWASP 2023 floor for PBKDF2-HMAC-SHA256: about 150 to 300 ms on a low-end device.
export const PBKDF2_ITERATIONS = 600_000;
const KEY_BITS = 256;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Derive the 64-character hex store key from a password and salt (PBKDF2-HMAC-SHA256). */
export async function deriveStoreKey(password: string, salt: Uint8Array): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    material,
    KEY_BITS,
  );
  return toHex(new Uint8Array(bits));
}
