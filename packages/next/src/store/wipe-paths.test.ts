// Structural guard for the paths that can destroy unsynced writes.
//
// A source-level test, which is unusual, and the right shape here: the regression is
// not "a function returns the wrong value", it is "someone wires a destructive call
// into a path that must not have one". An idle timeout that wipes needs no user action
// at all: someone finishes a morning of offline work, steps away, and returns to an
// empty device with nothing to recover. Behavioural tests belong next to this one once
// there are component tests; they do not replace it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const IDLE_LOCK = read("../session/idle-lock.tsx");
const SESSION_CLIENT = read("../session/session-client.ts");
const PROVIDER = read("../components/provider.tsx");
const UNLOCK_SCREEN = read("../components/unlock-screen.tsx");
const RECOVER_SCREEN = read("../components/recover-screen.tsx");
const DB = read("./db.ts");
const UNLOCK = read("./unlock.ts");

/** The source of one member of the provider, from its declaration to the next one. */
function providerMember(name: string, next: string): string {
  const start = PROVIDER.indexOf(`const ${name} = useCallback(`);
  const end = PROVIDER.indexOf(`const ${next} = `, start);
  expect(start, `${name} not found in provider.tsx`).toBeGreaterThan(-1);
  expect(end, `${next} not found after ${name}`).toBeGreaterThan(start);
  return PROVIDER.slice(start, end);
}

describe("paths that can destroy unsynced writes", () => {
  it("the idle timeout cannot wipe: it only calls the lock it is given", () => {
    expect(IDLE_LOCK).toContain("onLock");
    for (const destructive of ["signOutAndWipe", "clearLocalData", "wipe(", "disconnectAndClear"]) {
      expect(IDLE_LOCK).not.toContain(destructive);
    }
  });

  it("the provider's lock keeps the store", () => {
    const lock = providerMember("lock", "signOut");
    expect(lock).toContain("lockStore");
    expect(lock).not.toMatch(/wipe|clearLocalData|discard/i);
  });

  it("locking keeps the store and its salt, so the queue survives", () => {
    const start = DB.indexOf("    lock() {");
    expect(start).toBeGreaterThan(-1);
    const lockBody = DB.slice(start, DB.indexOf("wipe: (userId)", start));
    expect(lockBody).toContain("clearSessionKey");
    expect(lockBody).not.toContain("clearSalt");
    expect(lockBody).not.toContain("disconnectAndClear");
    expect(lockBody).not.toContain("removeFiles");
  });

  it("a failed unlock never wipes", () => {
    expect(UNLOCK).not.toMatch(/\.(wipe|clearLocalData)\(|clearSalt\(/);
  });

  it("the destructive sign-out consults the queue first, and only with the store open", () => {
    const signOut = providerMember("signOut", "discardLocalData");
    expect(signOut).toContain("unsyncedCount");
    expect(signOut).toContain('phase.kind !== "ready"');
    expect(signOut).toContain("signOutKeeping");
    // The count check comes before the wipe.
    expect(signOut.indexOf("unsyncedCount")).toBeLessThan(signOut.indexOf("signOutAndWipe"));
    // An unreadable queue (null) is treated as pending.
    expect(signOut).toContain("count === null");
  });

  it("signing out from the unlock and recovery screens keeps the store", () => {
    for (const src of [UNLOCK_SCREEN, RECOVER_SCREEN]) {
      expect(src).not.toMatch(/signOutAndWipe|clearLocalData/);
    }
  });

  it("every discard is behind a confirmation that names the loss", () => {
    for (const src of [UNLOCK_SCREEN, RECOVER_SCREEN]) {
      expect(src).toContain("ConfirmDialog");
      expect(src).toContain("destructive");
      expect(src).toMatch(/not synced will be lost/);
    }
  });

  it("the session client keeps the three exits distinct", () => {
    expect(SESSION_CLIENT).toContain("export async function lockStore");
    expect(SESSION_CLIENT).toContain("export async function signOutKeeping");
    expect(SESSION_CLIENT).toContain("export async function signOutAndWipe");
    const keeping = SESSION_CLIENT.slice(
      SESSION_CLIENT.indexOf("export async function signOutKeeping"),
      SESSION_CLIENT.indexOf("export async function signOutAndWipe"),
    );
    expect(keeping).not.toContain("clearLocalData");
  });
});
