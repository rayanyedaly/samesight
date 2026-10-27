import { AUTH_STATE_KEYS } from "samesight/compiler";
import { describe, expect, it } from "vitest";
import { SIGN_IN, signInDetail, signInKeyOf, signInReason } from "./signin.ts";

describe("sign-in facts", () => {
  it("has one for every claim samesight calls sign-in state, and no other", () => {
    expect(Object.keys(SIGN_IN).sort()).toEqual([...AUTH_STATE_KEYS].sort());
    for (const [key, f] of Object.entries(SIGN_IN)) if (f.kind !== "absent") expect(f.fact, key).not.toBe("");
  });

  it("words the Claims line from the fact's kind", () => {
    expect(signInDetail("is_anonymous")).toBe("every run user's token carries the same is_anonymous (false), so rules reading it are tested for that value only");
    expect(signInDetail("iat")).toMatch(/^every run user's token carries iat \(when each token was issued\), which audit does not choose/);
    expect(signInDetail("session_id")).toMatch(/^each run user has its own session_id \(one per sign-in\)/);
    expect(signInDetail("jti")).toBe("Supabase Auth puts no jti in a password user's token, so every run user reads it as null");
  });

  it("gives Coverage the same account, absent claims first", () => {
    expect(signInReason(["aal"])).toBe("it reads aal, which every run user has alike (an aal1 password user); see Claims");
    expect(signInReason(["exp", "email"])).toBe("it reads exp, email, whose values audit does not choose or put in generated rows; see Claims");
    expect(signInReason(["aal", "user_metadata.sub"])).toBe("it reads user_metadata.sub, which no run user's token carries; see Claims");
    expect(signInReason(["app_metadata.role"])).toBeUndefined();
    expect(signInKeyOf("amr.method")).toBe("amr");
  });
});
