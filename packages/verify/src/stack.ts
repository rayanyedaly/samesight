/**
 * The local stack the differential runs against: Supabase (database, Auth) and the
 * PowerSync service. Read from `supabase status -o env` in the project, and refused
 * unless every address is this machine.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isReady } from "./autostart/powersync.ts";
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
  /** Auth's shared HS256 secret, when `supabase status` prints one. */
  jwtSecret?: string;
  /** The start of the service's replication slot names, when not powersync (auto-start's own). */
  slotPrefix?: string;
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
  // Every key it lacks, named at once.
  const missing: string[] = [];
  const pick = (...names: string[]) => {
    for (const n of names) if (status[n]) return status[n];
    missing.push(names.join(" or "));
    return "";
  };
  const stack: Stack = {
    db: pick("DB_URL"),
    api: pick("API_URL"),
    publishableKey: pick("PUBLISHABLE_KEY", "ANON_KEY"),
    secretKey: pick("SECRET_KEY", "SERVICE_ROLE_KEY"),
    powersync,
    ...(status.JWT_SECRET ? { jwtSecret: status.JWT_SECRET } : {}),
  };
  if (missing.length) {
    throw new Error(`supabase status -o env prints no ${missing.join(", ")}; run supabase status to see what the CLI reports (is the stack running?)`);
  }
  assertLocalTargets({ db: stack.db, http: { "Supabase API": stack.api, PowerSync: stack.powersync } }, env);
  return stack;
}

/**
 * Policy mode's PowerSync service, asked once, on its readiness probe, before the run
 * makes anything: a service that is not there would otherwise fail every dataset, late.
 */
export async function assertPowerSync(url: string, ready: (url: string) => Promise<boolean> = isReady): Promise<void> {
  if (!(await ready(url.replace(/\/+$/, "")))) {
    throw new Error(`PowerSync is not reachable at ${url}; start it (docker compose up powersync) or pass --powersync <url>`);
  }
}

/**
 * The Supabase CLI to ask for the stack: the nearest node_modules/.bin/supabase from the
 * project up (a dev dependency, with any package manager), else `supabase` on the PATH.
 */
export function findSupabaseCli(projectDir: string, platform: NodeJS.Platform = process.platform): string {
  const name = platform === "win32" ? "supabase.cmd" : "supabase";
  for (let dir = resolve(projectDir); ; dir = dirname(dir)) {
    const bin = join(dir, "node_modules", ".bin", name);
    if (existsSync(bin)) return bin;
    if (dirname(dir) === dir) return "supabase";
  }
}

/** Runs the project's Supabase CLI for the stack's addresses and keys. */
export function readStack(projectDir: string, powersync: string): Stack {
  // --workdir: the CLI looks for supabase/ there, not in the directory it runs from. On
  // Windows the command goes through cmd.exe, which does not escape arguments: paths are
  // quoted, and refused if they hold a character cmd.exe would still act on.
  const win = process.platform === "win32";
  const dir = resolve(projectDir);
  const cli = findSupabaseCli(dir);
  for (const p of [dir, cli]) {
    // A trailing separator (a drive root) would escape the closing quote.
    if (win && (/["%^&|<>!]/.test(p) || /[\\/]$/.test(p))) throw new Error(`cannot pass ${p} to the Supabase CLI safely on Windows; move the project to a plainer path`);
  }
  const quote = (p: string) => (win ? `"${p}"` : p);
  let out: string;
  try {
    out = execFileSync(quote(cli), ["--workdir", quote(dir), "status", "-o", "env"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: win,
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new Error("no Supabase CLI found: install it in the project (npm i -D supabase) or on the PATH");
    }
    // The CLI ends with a generic "Try rerunning ... --debug" line; the cause is above it.
    const detail = err.stderr
      ?.split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^Try rerunning/.test(l))
      .join("; ");
    throw new Error(`\`supabase status\` failed in ${dir}${detail ? `: ${detail}` : ""}; is the local stack running (supabase start)?`);
  }
  return stackFromStatus(parseEnv(out), powersync);
}
