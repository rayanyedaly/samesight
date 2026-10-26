import { beforeEach, describe, expect, it, vi } from "vitest";

// The unlock path must never wipe the store when it fails to open: that would destroy
// unsynced offline writes. The key derivation and salt are mocked so the store's probe
// result can be driven directly.
vi.mock("./kdf.ts", () => ({ deriveStoreKey: vi.fn(async () => "deadbeef") }));
vi.mock("./kdf-salt.ts", () => ({
  peekSalt: vi.fn(() => new Uint8Array(16)),
  getOrCreateSalt: vi.fn(() => new Uint8Array(16)),
}));

import type { EncryptedStore } from "./db.ts";
import { getSessionKey } from "./session-key.ts";
import { tryUnlock } from "./unlock.ts";

const store = {
  prefix: "app",
  open: vi.fn(async () => ({}) as never),
  probe: vi.fn(),
  close: vi.fn(async () => {}),
  wipe: vi.fn(async () => {}),
  clearLocalData: vi.fn(async () => {}),
  lock: vi.fn(async () => {}),
} as unknown as EncryptedStore & {
  probe: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  wipe: ReturnType<typeof vi.fn>;
  clearLocalData: ReturnType<typeof vi.fn>;
};

describe("tryUnlock never wipes unsynced data", () => {
  beforeEach(() => vi.clearAllMocks());

  it("wrong key: 'wrong', drops the key, closes but does not wipe", async () => {
    store.probe.mockResolvedValue("wrong-key");
    expect(await tryUnlock(store, "user-1", "bad")).toBe("wrong");
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(store.wipe).not.toHaveBeenCalled();
    expect(store.clearLocalData).not.toHaveBeenCalled();
    expect(getSessionKey()).toBeNull();
  });

  it("unopenable (schema change, corruption): 'recover', still no wipe", async () => {
    store.probe.mockResolvedValue("unopenable");
    expect(await tryUnlock(store, "user-1", "pw")).toBe("recover");
    expect(store.wipe).not.toHaveBeenCalled();
    expect(store.clearLocalData).not.toHaveBeenCalled();
    expect(getSessionKey()).toBeNull();
  });

  it("correct key: 'ok', keeps the store open", async () => {
    store.probe.mockResolvedValue("ok");
    expect(await tryUnlock(store, "user-1", "pw")).toBe("ok");
    expect(store.close).not.toHaveBeenCalled();
    expect(store.wipe).not.toHaveBeenCalled();
    expect(getSessionKey()).toBe("deadbeef");
  });
});
