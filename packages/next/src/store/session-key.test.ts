import { beforeEach, describe, expect, it } from "vitest";
import { clearSessionKey, getSessionKey, getSessionUserId, hasSessionKey, setSessionKey } from "./session-key";

describe("session-key", () => {
  beforeEach(() => clearSessionKey());

  it("is absent until set, then present with its user", () => {
    expect(hasSessionKey()).toBe(false);
    expect(getSessionKey()).toBeNull();
    expect(getSessionUserId()).toBeNull();
    setSessionKey("user-1", "deadbeef");
    expect(hasSessionKey()).toBe(true);
    expect(getSessionKey()).toBe("deadbeef");
    expect(getSessionUserId()).toBe("user-1");
  });

  it("clearing drops the key and the user", () => {
    setSessionKey("user-1", "abc123");
    clearSessionKey();
    expect(hasSessionKey()).toBe(false);
    expect(getSessionKey()).toBeNull();
    expect(getSessionUserId()).toBeNull();
  });
});
