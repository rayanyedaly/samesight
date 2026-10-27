/**
 * Verifier users, made through the real Auth service so their tokens pass through the
 * project's access token hook. They are recognisable by their email domain, and a run
 * removes any left over from an interrupted one before it starts.
 */

import { randomBytes } from "node:crypto";
import type pg from "pg";
import { rows } from "../db.ts";
import type { Stack } from "../stack.ts";

export const EMAIL_DOMAIN = "verify.samesight.test";

export interface User {
  id: string;
  email: string;
}

export interface Session {
  token: string;
  /** The token's payload: what the hook put in it. */
  claims: Record<string, unknown>;
  expiresAt: number;
}

const AUTH_TIMEOUT_MS = 30_000;

async function auth(stack: Stack, path: string, init: RequestInit & { admin?: boolean }): Promise<unknown> {
  const key = init.admin ? stack.secretKey : stack.publishableKey;
  // Bounded, so a signal's cleanup, which waits for users being made, is never held by a hung Auth.
  const res = await fetch(`${stack.api}/auth/v1${path}`, {
    ...init,
    headers: { apikey: key, ...(init.admin ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  }).catch((e: Error) => {
    throw e.name === "TimeoutError" ? new Error(`Auth ${init.method ?? "GET"} ${path}: no answer within ${AUTH_TIMEOUT_MS / 1000}s`) : e;
  });
  const text = await res.text();
  if (res.status === 429 && path.startsWith("/token")) {
    throw new Error(
      `Auth ${init.method ?? "GET"} ${path}: 429 ${text.slice(0, 200)}. That is Supabase Auth's sign-in rate limit: every run signs each of its users in, ` +
        "again in a long run; raise [auth.rate_limit] sign_in_sign_ups in supabase/config.toml for the local stack, then restart it",
    );
  }
  if (!res.ok) {
    // A database error's detail (the table a row that blocks a delete is in) comes whole.
    const detail = (() => {
      try {
        const body = JSON.parse(text) as { code?: unknown; message?: unknown; detail?: unknown };
        return typeof body.code === "string" && typeof body.detail === "string" ? `${body.code}: ${typeof body.message === "string" ? `${body.message} (${body.detail})` : body.detail}` : undefined;
      } catch {
        return undefined;
      }
    })();
    throw new Error(`Auth ${init.method ?? "GET"} ${path}: ${res.status} ${detail ?? text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

export function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("not a JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Users left by earlier runs, found by email domain. */
export async function leftoverUsers(client: pg.Client): Promise<string[]> {
  const found = await rows<{ id: string }>(client, "select id::text from auth.users where email like $1", [`%@${EMAIL_DOMAIN}`]);
  return found.map((u) => u.id);
}

export async function deleteUser(stack: Stack, id: string): Promise<void> {
  await auth(stack, `/admin/users/${encodeURIComponent(id)}`, { method: "DELETE", admin: true });
}

/**
 * Creates `count` confirmed users sharing one random password, made for this run only.
 * `metadata[i]` is the app_metadata and user_metadata user i is created with, if any, and
 * `ids[i]` its id (minted up front, so a claim can hold it); Auth picks one when none is given.
 */
export async function createUsers(
  stack: Stack,
  count: number,
  runId: string,
  metadata: Partial<Record<"app_metadata" | "user_metadata", Record<string, unknown>>>[] = [],
  ids: string[] = [],
): Promise<{ users: User[]; password: string }> {
  const password = randomBytes(18).toString("base64url");
  const users: User[] = [];
  for (let i = 0; i < count; i++) {
    const email = `u${i}-${runId}@${EMAIL_DOMAIN}`;
    const created = (await auth(stack, "/admin/users", {
      method: "POST",
      admin: true,
      body: JSON.stringify({ ...(ids[i] ? { id: ids[i] } : {}), email, password, email_confirm: true, ...metadata[i] }),
    })) as { id: string };
    // An Auth that ignores the id would leave claims holding ids no user has.
    if (ids[i] && created.id !== ids[i]) throw new Error(`Auth created ${email} with id ${created.id}, not the ${ids[i]} audit asked for; this Auth version does not take an id at creation`);
    users.push({ id: created.id, email });
  }
  return { users, password };
}

export async function signIn(stack: Stack, email: string, password: string): Promise<Session> {
  const res = (await auth(stack, "/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) })) as {
    access_token: string;
    expires_at: number;
  };
  return { token: res.access_token, claims: decodeClaims(res.access_token), expiresAt: res.expires_at * 1000 };
}
