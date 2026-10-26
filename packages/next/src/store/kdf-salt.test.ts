import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal in-memory localStorage (Node has none). The salt module checks
// `typeof localStorage`, so stubbing it runs the real code path.
const mem = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

beforeEach(() => {
  mem.clear();
  vi.stubGlobal("localStorage", localStorageStub);
});
afterEach(() => vi.unstubAllGlobals());

const { clearSalt, getOrCreateSalt, peekSalt, storeExists } = await import("./kdf-salt.ts");

const P = "app";
const U = "user-1";
const V = "user-2";

describe("kdf-salt", () => {
  it("creates and persists on first call, then returns the same salt", () => {
    expect(storeExists(P, U)).toBe(false);
    const a = getOrCreateSalt(P, U);
    expect(a).toHaveLength(16);
    expect(storeExists(P, U)).toBe(true);
    expect([...getOrCreateSalt(P, U)]).toEqual([...a]);
  });

  it("peekSalt reads the stored salt but never creates one", () => {
    expect(peekSalt(P, U)).toBeNull();
    const s = getOrCreateSalt(P, U);
    expect([...(peekSalt(P, U) ?? [])]).toEqual([...s]);
  });

  it("is kept per user: clearing one user leaves another intact", () => {
    const a = getOrCreateSalt(P, U);
    const b = getOrCreateSalt(P, V);
    expect([...a]).not.toEqual([...b]);
    clearSalt(P, U);
    expect(storeExists(P, U)).toBe(false);
    expect(storeExists(P, V)).toBe(true);
  });

  it("is kept per app prefix", () => {
    getOrCreateSalt(P, U);
    expect(storeExists("other-app", U)).toBe(false);
    expect([...mem.keys()]).toEqual(["app.kdf.v1.user-1.salt"]);
  });
});
