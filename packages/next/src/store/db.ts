import type { Schema } from "@powersync/common";
import { PowerSyncDatabase } from "@powersync/web";
import { pendingUploadCount } from "@samesight/supabase";
import { clearSalt, storeExists } from "./kdf-salt";
import { clearSessionKey, getSessionKey, getSessionUserId } from "./session-key";

/**
 * The encrypted local PowerSync store for a browser app.
 *
 * Encrypted at rest (SQLite3MultipleCiphers) with a password-derived key (kdf.ts), and
 * kept per user (`<prefix>.<userId>.db`) so a shared device keeps each user's store
 * apart. The key is deterministic, so the store persists across reloads and is reopened
 * through the unlock screen.
 *
 * Safety rules:
 *  - A store is never deleted because it failed to open. That would silently destroy
 *    unsynced writes. `probe` says why it would not open (wrong key, or unopenable),
 *    and the caller offers "try again" or an explicit recovery that names the loss.
 *  - The only deletions are `clearLocalData` (sign-out that discards the store) and a
 *    recovery the user confirmed. Both clear through PowerSync and then remove the
 *    browser storage itself (IndexedDB for the default VFS, OPFS files otherwise).
 *  - Multi-tab is off: coordinating the unlock across tabs is not built yet.
 */
export interface EncryptedStoreOptions {
  schema: Schema;
  /** Namespaces the store files and salts, e.g. the app name. Letters, digits, dashes. */
  prefix: string;
  /**
   * URL of PowerSync's prebuilt database worker, for bundlers that do not bundle the
   * worker @powersync/web references (Turbopack production builds copy it unbundled).
   * Serve the output of `powersync-web copy-assets` and pass e.g. "/@powersync/worker.js".
   */
  worker?: string;
}

export type ProbeResult = "ok" | "wrong-key" | "unopenable";

export interface EncryptedStore {
  readonly prefix: string;
  /** Open (or return) the store for the user whose key is held in memory. Null without a key. */
  open(): Promise<PowerSyncDatabase | null>;
  /** The open store, if any. */
  current(): PowerSyncDatabase | null;
  /** Trial-read the open store. Never throws, and is bounded by a timeout. */
  probe(): Promise<ProbeResult>;
  /** Close without deleting anything (a failed unlock). */
  close(): Promise<void>;
  /** Lock: close and forget the key, keeping the encrypted file and its salt. */
  lock(): Promise<void>;
  /**
   * Purge a user's store: its data and files. Keeps the salt and the held key, so the
   * same key opens a fresh store. Defaults to the open store's user, else the key's.
   * Destructive.
   */
  wipe(userId?: string): Promise<void>;
  /** Purge the store, forget the key, and drop the salt. Destructive. */
  clearLocalData(userId?: string): Promise<void>;
  /** Local writes not yet accepted by the server; null when there is no open store or it cannot be read. */
  pendingWriteCount(): Promise<number | null>;
  /** Whether this user has a store on this device. */
  exists(userId: string): boolean;
}

/** Race a promise against a timeout, so a hung WASM or storage init cannot wedge the UI. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export function createEncryptedStore({ schema, prefix, worker }: EncryptedStoreOptions): EncryptedStore {
  if (!/^[A-Za-z0-9-]+$/.test(prefix)) throw new Error(`Invalid store prefix "${prefix}"`);
  // The connector records refused writes there before discarding them; without the table
  // that record fails and the refused batch blocks the queue.
  if (!schema.tables.some((t) => t.name === "RejectedWrite")) {
    throw new Error("The schema needs the RejectedWrite table: add `RejectedWrite: rejectedWriteTable` from @samesight/supabase");
  }
  const fileName = (userId: string) => `${prefix}.${userId}.db`;
  let db: PowerSyncDatabase | null = null;
  let dbUserId: string | null = null;
  // open, close and wipe run one at a time: two overlapping opens would each create a
  // PowerSyncDatabase on the same file and leak one; a wipe must not race an open.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  async function closeOpen(): Promise<void> {
    const open = db;
    db = null;
    dbUserId = null;
    if (open) {
      try {
        await withTimeout(open.close(), 5000, "store close");
      } catch {
        // Best effort: the handle is dropped either way.
      }
    }
  }

  /** Best-effort removal of the browser storage behind a user's store. */
  async function removeFiles(userId: string): Promise<void> {
    const name = fileName(userId);
    // The default VFS (IDBBatchAtomicVFS) keeps the database in IndexedDB under the file name.
    if (typeof indexedDB !== "undefined") {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      });
    }
    // OPFS-based VFSs keep files (and sidecars) in the origin's private file system.
    try {
      const storage = (navigator as { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } })
        .storage;
      if (!storage?.getDirectory) return;
      const root = await storage.getDirectory();
      for (const entry of [name, `${name}-journal`, `${name}-wal`, `${name}-shm`]) {
        await root.removeEntry(entry, { recursive: true }).catch(() => {});
      }
    } catch {
      // Best effort.
    }
  }

  /**
   * Best effort: drop the service worker's runtime caches (visited pages and their
   * payloads, whose URLs carry record ids), keeping the precached app shell.
   */
  async function clearPageCaches(): Promise<void> {
    try {
      if (typeof caches === "undefined") return;
      for (const name of await caches.keys()) {
        if (!name.includes("precache")) await caches.delete(name);
      }
    } catch {
      // Best effort.
    }
  }

  async function wipe(forUser?: string): Promise<void> {
    const userId = forUser ?? dbUserId ?? getSessionUserId();
    // Clear through PowerSync only when the open store is this user's.
    const open = dbUserId === userId ? db : null;
    if (open) {
      try {
        // Empties the data and the upload queue even if removing the files then fails.
        await withTimeout(open.disconnectAndClear(), 8000, "store disconnectAndClear");
      } catch {
        // The store may be unopenable; removing the files below still applies.
      }
      await closeOpen();
    }
    // Bounded: this runs inside the serial chain, and a deleteDatabase that never settles
    // would hold every later open and lock behind it.
    if (userId) await withTimeout(removeFiles(userId), 8000, "store remove").catch(() => {});
  }

  return {
    prefix,

    open: () =>
      serial(async () => {
        if (typeof window === "undefined") return null;
        const key = getSessionKey();
        const userId = getSessionUserId();
        if (!key || !userId) return null; // never an unkeyed or unowned store
        if (db && dbUserId === userId) return db;
        await closeOpen();
        db = new PowerSyncDatabase({
          schema,
          database: { dbFilename: fileName(userId), encryptionKey: key, enableMultiTabs: false, worker },
        });
        dbUserId = userId;
        return db;
      }),

    current: () => db,

    async probe() {
      if (!db) return "unopenable";
      try {
        await withTimeout(db.waitForReady(), 8000, "store waitForReady");
        await withTimeout(db.getAll("SELECT name FROM sqlite_master LIMIT 1"), 8000, "store probe read");
        return "ok";
      } catch (e) {
        const message = (e instanceof Error ? e.message : String(e)).toLowerCase();
        // A wrong key cannot decrypt page 1, which SQLite reports as SQLITE_NOTADB.
        if (/not a database|notadb|file is encrypted/.test(message)) return "wrong-key";
        console.warn("[samesight] store unopenable (not a wrong-key error)", e);
        return "unopenable";
      }
    },

    close: () => serial(closeOpen),

    lock() {
      // Forget the key first: that is what locks the store, whatever happens next.
      clearSessionKey();
      return serial(closeOpen);
    },

    wipe: (userId) => serial(() => wipe(userId)),

    clearLocalData: (forUser) =>
      serial(async () => {
        const userId = forUser ?? dbUserId ?? getSessionUserId();
        await wipe(userId ?? undefined);
        if (userId) clearSalt(prefix, userId);
        clearSessionKey();
        await clearPageCaches();
      }),

    async pendingWriteCount() {
      return db ? pendingUploadCount(db) : null;
    },

    exists: (userId) => storeExists(prefix, userId),
  };
}
