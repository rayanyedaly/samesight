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

async function auth(stack: Stack, path: string, init: RequestInit & { admin?: boolean }): Promise<unknown> {
  const key = init.admin ? stack.secretKey : stack.publishableKey;
  const res = await fetch(`${stack.api}/auth/v1${path}`, {
    ...init,
    headers: { apikey: key, ...(init.admin ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
  });
  const text = await res.text();
  if (res.status === 429) {
    throw new Error(
      `Auth ${init.method ?? "GET"} ${path}: 429, Supabase Auth's rate limit. Every run signs each of its users in, more often in a long run; ` +
        "raise [auth.rate_limit] sign_in_sign_ups in supabase/config.toml for the local stack, then restart it",
    );
  }
  if (!res.ok) throw new Error(`Auth ${init.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 300)}`);
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
 * `metadata[i]` is the app_metadata and user_metadata user i is created with, if any.
 */
export async function createUsers(
  stack: Stack,
  count: number,
  runId: string,
  metadata: Partial<Record<"app_metadata" | "user_metadata", Record<string, unknown>>>[] = [],
): Promise<{ users: User[]; password: string }> {
  const password = randomBytes(18).toString("base64url");
  const users: User[] = [];
  for (let i = 0; i < count; i++) {
    const email = `u${i}-${runId}@${EMAIL_DOMAIN}`;
    const created = (await auth(stack, "/admin/users", {
      method: "POST",
      admin: true,
      body: JSON.stringify({ email, password, email_confirm: true, ...metadata[i] }),
    })) as { id: string };
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
