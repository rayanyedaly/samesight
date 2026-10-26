/**
 * The local stack the differential runs against: Supabase (database, Auth) and the
 * PowerSync service. Read from `supabase status -o env` in the project, and refused
 * unless every address is this machine.
 */

import { execFileSync } from "node:child_process";
import { assertLocalTargets } from "./guard.ts";

export interface Stack {
  db: string;
  /** The Supabase API gateway (Auth at /auth/v1). */
  api: string;
  /** Sent as `apikey` on sign-in. */
  publishableKey: string;
  /** For the Auth admin API (creating and deleting users). */
  secretKey: string;
  powersync: string;
}

/** Parses `KEY="value"` lines as `supabase status -o env` prints them. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^"(.*)"$/, "$1");
  }
  return out;
}

export function stackFromStatus(status: Record<string, string>, powersync: string, env: NodeJS.ProcessEnv = process.env): Stack {
  const pick = (...names: string[]) => {
    for (const n of names) if (status[n]) return status[n];
    throw new Error(`supabase status prints none of ${names.join(", ")}; is the stack running?`);
  };
  const stack: Stack = {
    db: pick("DB_URL"),
    api: pick("API_URL"),
    publishableKey: pick("PUBLISHABLE_KEY", "ANON_KEY"),
    secretKey: pick("SECRET_KEY", "SERVICE_ROLE_KEY"),
    powersync,
  };
  assertLocalTargets({ db: stack.db, http: { "Supabase API": stack.api, PowerSync: stack.powersync } }, env);
  return stack;
}

/** Runs the project's Supabase CLI (a workspace dev dependency) for the stack's addresses and keys. */
export function readStack(projectDir: string, powersync: string): Stack {
  const out = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  return stackFromStatus(parseEnv(out), powersync);
}
