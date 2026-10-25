import type { PowerSyncDatabase } from "@powersync/web";
import { describe, expect, it } from "vitest";
import type { EncryptedStore } from "../store/db";
import { unsyncedCount } from "./session-client";

const storeWith = (db: unknown) => ({ current: () => db as PowerSyncDatabase | null }) as EncryptedStore;

// The destructive sign-out wipes only on a count of exactly zero, so every "cannot
// tell" must come back as null, never as 0.
describe("unsyncedCount", () => {
  it("is null without an open store (locked, closing, never opened)", async () => {
    await expect(unsyncedCount(storeWith(null))).resolves.toBeNull();
  });

  it("is null when the queue cannot be read", async () => {
    const db = { getUploadQueueStats: async () => Promise.reject(new Error("closed")) };
    await expect(unsyncedCount(storeWith(db))).resolves.toBeNull();
  });

  it("counts the queue", async () => {
    await expect(unsyncedCount(storeWith({ getUploadQueueStats: async () => ({ count: 4 }) }))).resolves.toBe(4);
    await expect(unsyncedCount(storeWith({ getUploadQueueStats: async () => ({ count: 0 }) }))).resolves.toBe(0);
  });
});
