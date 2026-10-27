/**
 * What Supabase Auth puts in a run user's token about the sign-in itself, one fact per
 * auth-state claim, so the Claims and Coverage sections say the same thing. Run users are
 * password users made by the admin API, signed in once each (checked live by the roles tests).
 */

import { authStateKey } from "samesight/compiler";

export type SignInKind =
  /** Every run user's token carries the same value. */
  | "alike"
  /** Every token carries one, set at sign-in; audit does not choose it. */
  | "set"
  /** Each run user has its own. */
  | "own"
  /** No run user's token carries it. */
  | "absent";

export const SIGN_IN: Record<string, { kind: SignInKind; fact: string; value?: unknown }> = {
  aal: { kind: "alike", fact: "aal1: a password sign-in, no second factor", value: "aal1" },
  is_anonymous: { kind: "alike", fact: "false", value: false },
  phone: { kind: "alike", fact: "empty: run users have no phone", value: "" },
  "app_metadata.provider": { kind: "alike", fact: "email", value: "email" },
  "app_metadata.providers": { kind: "alike", fact: '["email"]', value: ["email"] },
  "user_metadata.email_verified": { kind: "alike", fact: "true", value: true },
  amr: { kind: "set", fact: "the password method, with the time of each sign-in" },
  exp: { kind: "set", fact: "when each token expires" },
  iat: { kind: "set", fact: "when each token was issued" },
  email: { kind: "own", fact: "an address at verify.samesight.test" },
  session_id: { kind: "own", fact: "one per sign-in" },
  nbf: { kind: "absent", fact: "" },
  jti: { kind: "absent", fact: "" },
  "user_metadata.email": { kind: "absent", fact: "" },
  "user_metadata.phone_verified": { kind: "absent", fact: "" },
  "user_metadata.sub": { kind: "absent", fact: "" },
};

/** The Claims section's reason a sign-in claim is not tested further. */
export function signInDetail(key: string): string {
  const f = SIGN_IN[key];
  switch (f?.kind) {
    case "alike":
      return `every run user's token carries the same ${key} (${f.fact}), so rules reading it are tested for that value only`;
    case "set":
      return `every run user's token carries ${key} (${f.fact}), which audit does not choose, so rules reading it are tested for those values only`;
    case "own":
      return `each run user has its own ${key} (${f.fact}), which audit does not choose or put in generated rows, so rules matching it are tested on rows that do not match it`;
    case "absent":
      return `no run user's token carries ${key} (Supabase Auth adds none for a user made by its admin API), so every run user reads it as null`;
    default:
      return `every run user is a password user at aal1 with no other sign-in state, so rules reading ${key} are tested for that state only`;
  }
}

/** Coverage's reason for rules reading these claim keys, or undefined when none is sign-in state. */
export function signInReason(keys: string[]): string | undefined {
  const byKind = (...kinds: SignInKind[]) => keys.filter((k) => kinds.includes(SIGN_IN[signInKeyOf(k)]?.kind as SignInKind));
  const clauses = [
    [byKind("absent"), "which no run user's token carries"],
    [byKind("alike"), "which every run user has alike (an aal1 password user)"],
    [byKind("set", "own"), "whose values audit does not choose or put in generated rows"],
  ] as const;
  const said = clauses.filter(([ks]) => ks.length).map(([ks, why]) => `${ks.join(", ")}, ${why}`);
  return said.length ? `it reads ${said.join("; and ")}; see Claims` : undefined;
}

/** A claim key's sign-in fact key: amr.0.method reads amr. */
export function signInKeyOf(key: string): string {
  return authStateKey(key.split(".")) ?? key;
}
