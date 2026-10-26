/**
 * What samesight reads from a Supabase CLI project's supabase/config.toml: the database
 * port, and the Auth settings the generated access layer depends on. A line reader for the
 * flat `[section]` / `key = value` subset the CLI writes, not a TOML parser.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./doctor.ts";

export type SupabaseConfig = Map<string, Map<string, string>>;

export const HOOK_URI = "pg-functions://postgres/samesight/custom_access_token_hook";

/** Sections and their keys, values unquoted; null without supabase/config.toml in `dir`. */
export function readSupabaseConfig(dir: string): SupabaseConfig | null {
  const path = join(dir, "supabase", "config.toml");
  if (!existsSync(path)) return null;
  const config: SupabaseConfig = new Map([["", new Map()]]);
  let section = config.get("") as Map<string, string>;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      const name = header[1]?.trim() ?? "";
      section = config.get(name) ?? new Map();
      config.set(name, section);
      continue;
    }
    const pair = /^\s*([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^#]*?)\s*(#.*)?$/.exec(line);
    if (pair?.[1] && pair[2] !== undefined) section.set(pair[1], pair[2].replace(/^"(.*)"$|^'(.*)'$/, "$1$2"));
  }
  return config;
}

/** The access token hook must be on and point at the generated function; Auth needs a signing key for PowerSync. */
export function checkAuthConfig(config: SupabaseConfig | null): Finding[] {
  if (!config) return [{ status: "warn", check: "auth config", detail: "no supabase/config.toml next to the policy, so the hook settings were not checked" }];
  const out: Finding[] = [];
  const hook = config.get("auth.hook.custom_access_token");
  const how = `add [auth.hook.custom_access_token] with enabled = true and uri = "${HOOK_URI}" to supabase/config.toml, then restart Supabase`;
  if (hook?.get("enabled") !== "true") out.push({ status: "fail", check: "auth config", detail: `the access token hook is off, so tokens carry no tenant or role; ${how}` });
  else if (hook.get("uri") !== HOOK_URI) out.push({ status: "fail", check: "auth config", detail: `the access token hook calls ${hook.get("uri") ?? "nothing"}; ${how}` });
  else out.push({ status: "ok", check: "auth config", detail: "the access token hook is on and calls samesight.custom_access_token_hook" });
  if (!config.get("auth")?.get("signing_keys_path")) {
    out.push({
      status: "warn",
      check: "auth config",
      detail: "no [auth] signing_keys_path: PowerSync verifies tokens through the JWKS, which lists only asymmetric keys (supabase gen signing-key --algorithm ES256)",
    });
  }
  return out;
}
