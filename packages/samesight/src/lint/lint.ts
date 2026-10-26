/**
 * `samesight lint`: known leak patterns in a PowerSync sync config (streams or sync rules),
 * found by reading the file alone. No database, no PowerSync, no policy file. A clean lint
 * proves nothing about what devices receive; `samesight-verify audit` tests that.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseSyncConfig, type SyncConfig } from "../sync/config.ts";
import type { LintFinding } from "./finding.ts";
import { clientScoped } from "./rules/client-scoped.ts";
import { notAutoSubscribed } from "./rules/not-auto-subscribed.ts";
import { unreadableQuery } from "./rules/unreadable-query.ts";
import { unscopedQuery } from "./rules/unscoped-query.ts";
import { userMetadata } from "./rules/user-metadata.ts";

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

export const RULES: LintRule[] = [unscopedQuery, clientScoped, userMetadata, unreadableQuery, notAutoSubscribed];

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
 * The 1-based line where `sql` starts in `text`, found by its full text with all spacing
 * collapsed on both sides, so a query YAML folded across lines is still found. A query
 * written twice is placed at its first copy; one that cannot be found (quoted with escapes,
 * say) has no line.
 */
export function lineOf(text: string, sql: string): number | undefined {
  const target = sql.replace(/\s+/g, " ").trim();
  if (!target) return undefined;
  let flat = "";
  const lineAt: number[] = [];
  let line = 1;
  let gap = false;
  for (const ch of text) {
    if (ch === "\n") line++;
    if (/\s/.test(ch)) {
      gap = flat.length > 0;
      continue;
    }
    if (gap) {
      flat += " ";
      lineAt.push(line);
      gap = false;
    }
    flat += ch;
    lineAt.push(line);
  }
  const at = flat.indexOf(target);
  return at === -1 ? undefined : lineAt[at];
}
