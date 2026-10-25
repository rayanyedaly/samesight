import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredSession, storedSession } from "./stored-session";

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

const KEY = "app-auth";

describe("storedSession", () => {
  it("returns a complete stored session", () => {
    mem.set(KEY, JSON.stringify({ access_token: "a", refresh_token: "r", user: { id: "u1" } }));
    expect(storedSession(KEY)?.user.id).toBe("u1");
  });

  it("ignores missing, partial or corrupt entries", () => {
    expect(storedSession(KEY)).toBeNull();
    mem.set(KEY, JSON.stringify({ access_token: "a", user: { id: "u1" } }));
    expect(storedSession(KEY)).toBeNull();
    mem.set(KEY, "{not json");
    expect(storedSession(KEY)).toBeNull();
  });
});

describe("clearStoredSession", () => {
  it("removes the session and its companion keys, nothing else", () => {
    for (const k of [KEY, `${KEY}-user`, `${KEY}-code-verifier`, "other"]) mem.set(k, "x");
    clearStoredSession(KEY);
    expect([...mem.keys()]).toEqual(["other"]);
  });
});
