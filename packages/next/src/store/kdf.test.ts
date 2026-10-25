import { describe, expect, it } from "vitest";
import { deriveStoreKey } from "./kdf";

// The key must be deterministic from password and salt: that is what lets the unlock
// screen reopen the same encrypted store offline. A random or salt-independent key
// would either break unlocking or make the encryption pointless.
const salt = (n: number) => new Uint8Array(16).fill(n);

describe("deriveStoreKey (PBKDF2)", () => {
  it("is deterministic: the same password and salt give the same 64-hex key", async () => {
    const a = await deriveStoreKey("hunter2", salt(1));
    const b = await deriveStoreKey("hunter2", salt(1));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a different salt gives a different key", async () => {
    expect(await deriveStoreKey("hunter2", salt(1))).not.toBe(await deriveStoreKey("hunter2", salt(2)));
  });

  it("a different password gives a different key", async () => {
    expect(await deriveStoreKey("hunter2", salt(1))).not.toBe(await deriveStoreKey("hunter3", salt(1)));
  });
});
