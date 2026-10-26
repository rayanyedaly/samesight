/**
 * `samesight lint`: known leak patterns in a PowerSync sync config (streams or sync rules),
 * found by reading the file alone. No database, no PowerSync, no policy file. A clean lint
 * proves nothing about what devices receive; `samesight-verify audit` tests that.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseSyncConfig, type SyncConfig } from "../sync/config.ts";
import type { LintFinding } from "./finding.ts";

/** Where projects keep their sync config, tried in order when no file is named. */
export const SYNC_CONFIG_FILES = ["sync-config.yaml", "sync-rules.yaml", "powersync/sync-config.yaml", "powersync/sync-rules.yaml"];

export interface LintContext {
  file: string;
  text: string;
  config: SyncConfig;
  /** The line a query starts on, found by its text; undefined when it cannot be placed. */
  lineOf: (sql: string) => number | undefined;
}

export type LintRule = (context: LintContext) => LintFinding[];

export const RULES: LintRule[] = [];

/** Every rule's findings for one sync config; throws when the file cannot be read as one. */
export function lintSyncConfig(text: string, file: string, rules: LintRule[] = RULES): LintFinding[] {
  const config = parseSyncConfig(text);
  const context: LintContext = { file, text, config, lineOf: (sql) => lineOf(text, sql) };
  return rules.flatMap((rule) => rule(context));
}

/** The first of the usual sync config paths that exists under `dir`. */
export function findSyncConfig(dir: string): string | undefined {
  return SYNC_CONFIG_FILES.find((f) => existsSync(join(dir, f)));
}

/**
 * The 1-based line where `sql` starts in `text`, matched on its first line with spacing
 * ignored. YAML may fold or quote a query, so a query that cannot be found has no line.
 */
export function lineOf(text: string, sql: string): number | undefined {
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  const first = squash(sql.split("\n").find((l) => l.trim()) ?? "");
  if (!first) return undefined;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => squash(l).includes(first));
  return at === -1 ? undefined : at + 1;
}
