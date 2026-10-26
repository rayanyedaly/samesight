import type { AbstractPowerSyncDatabase } from "@powersync/common";
import { describe, expect, it } from "vitest";
import { hasUnsyncedWrites, pendingUploadCount } from "./queue.ts";
import { rejectedWriteTable } from "./rejected-writes.ts";

const db = (stats: () => Promise<{ count: number }>) =>
  ({ getUploadQueueStats: stats }) as unknown as AbstractPowerSyncDatabase;

describe("queue helpers", () => {
  it("say there may be unsynced writes when the queue cannot be read", async () => {
    await expect(hasUnsyncedWrites(db(async () => Promise.reject(new Error("closed"))))).resolves.toBe(true);
    await expect(hasUnsyncedWrites(db(async () => ({ count: 0 })))).resolves.toBe(false);
    await expect(hasUnsyncedWrites(db(async () => ({ count: 2 })))).resolves.toBe(true);
  });

  it("count the queue for display", async () => {
    await expect(pendingUploadCount(db(async () => ({ count: 3 })))).resolves.toBe(3);
    await expect(pendingUploadCount(db(async () => Promise.reject(new Error("closed"))))).resolves.toBeNull();
  });
});

describe("rejectedWriteTable", () => {
  // Synced, a refused write would queue an upload of its own record, which apply_batch
  // refuses, which records it again: a loop.
  it("is local only", () => {
    expect(rejectedWriteTable.localOnly).toBe(true);
  });
});
