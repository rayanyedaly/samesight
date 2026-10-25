import type { AbstractPowerSyncDatabase } from "@powersync/common";

/**
 * How many local writes have not yet reached the server.
 *
 * Every path that destroys a local store must consult this first. Returns null rather
 * than throwing when the queue cannot be read, which callers must treat as "there may
 * be unsynced work", never as zero.
 */
export async function pendingUploadCount(db: AbstractPowerSyncDatabase): Promise<number | null> {
  try {
    const stats = await db.getUploadQueueStats(false);
    return stats?.count ?? 0;
  } catch {
    return null;
  }
}

/**
 * Yes/no form of `pendingUploadCount`: if the queue cannot be read, answer
 * true. A needless confirmation costs a click; a skipped one can cost a day of work.
 */
export async function hasUnsyncedWrites(db: AbstractPowerSyncDatabase): Promise<boolean> {
  try {
    const stats = await db.getUploadQueueStats(false);
    return (stats?.count ?? 0) > 0;
  } catch {
    return true;
  }
}
