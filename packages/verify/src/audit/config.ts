/**
 * The checks audit makes on the sync config file alone, with no database: its Sync config
 * section, and the stream queries its Database catalog section reads for user_metadata next
 * to the RLS policies. run.ts runs these; scripts/docs/leaks.mjs shows them in the docs.
 */

import { auditScope, parseSyncConfig, type SyncConfig } from "samesight/compiler";
import type { Finding } from "../report.ts";
import { checkUserEditableClaims } from "./catalog.ts";
import { type RuleSql, syncRules } from "./claims.ts";

export interface SyncConfigCheck {
  /** The Sync config section, as audit prints it. */
  findings: Finding[];
  /** The parsed config, unless the file could not be read as one. */
  parsed?: { config: SyncConfig; scope: ReturnType<typeof auditScope>; streamSql: RuleSql[] };
}

/** Reads the sync config at `path` (named in a failure) and checks what audit can check in it. */
export function checkSyncConfig(path: string, text: string): SyncConfigCheck {
  try {
    const config = parseSyncConfig(text);
    const streamSql = syncRules(config);
    const scope = auditScope(config.streams, config.kind);
    return { findings: [...scope.findings, ...config.findings], parsed: { config, scope, streamSql } };
  } catch (e) {
    return { findings: [{ status: "fail", check: "sync config", detail: `${path}: ${(e as Error).message}` }] };
  }
}

/** A public RLS policy, as audit reads it from pg_policies. */
export interface PolicyRow {
  table: string;
  name: string;
  qual: string | null;
  with_check: string | null;
}

/** The Database catalog section's user_metadata check, on the RLS policies and the stream queries. */
export function checkUserMetadata(policies: PolicyRow[], streamSql: RuleSql[]): Finding[] {
  return checkUserEditableClaims([...policies.map((p) => ({ where: `policy "${p.name}" on ${p.table}`, sql: `${p.qual ?? ""} ${p.with_check ?? ""}` })), ...streamSql]);
}
