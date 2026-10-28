/**
 * `samesight lint`: known leak patterns in a PowerSync sync config (streams or sync rules),
 * found by reading the file alone. No database, no PowerSync, no policy file. A clean lint
 * proves nothing about what devices receive; `samesight-verify audit` tests that.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { LineCounter, parseDocument, Scalar, visit } from "yaml";
import { parseSyncConfig, type SyncConfig } from "../sync/config.ts";
import type { LintFinding } from "./finding.ts";
import type { Migrations } from "./migrations.ts";
import { clientScoped } from "./rules/client-scoped.ts";
import { notAutoSubscribed } from "./rules/not-auto-subscribed.ts";
import { rlsOff } from "./rules/rls-off.ts";
import { rlsOpen } from "./rules/rls-open.ts";
import { unreadableQuery } from "./rules/unreadable-query.ts";
import { unscopedQuery } from "./rules/unscoped-query.ts";
import { userMetadata } from "./rules/user-metadata.ts";

/** Where projects keep their sync config, tried in order when no file is named. */
export const SYNC_CONFIG_FILES = ["sync-config.yaml", "sync-rules.yaml", "powersync/sync-config.yaml", "powersync/sync-rules.yaml"];

/** 1-based, as findings give them. */
export interface Position {
  line: number;
  column: number;
}

export interface LintContext {
  file: string;
  text: string;
  config: SyncConfig;
  /** The project's migrations as read, when lint was given or found them. */
  migrations?: Migrations;
  /** Where a query starts, found by its YAML string; undefined when it cannot be placed. */
  lineOf: (sql: string) => Position | undefined;
}

/** A rule: what it finds in one sync config, and its name, as findings and --allow use it. */
export type LintRule = ((context: LintContext) => LintFinding[]) & { readonly ruleName: string };

export function defineRule(name: string, run: (context: LintContext) => LintFinding[]): LintRule {
  return Object.assign(run, { ruleName: name });
}

export { RULE_INFO, type RuleInfo } from "./rule-info.ts";

export const RULES: LintRule[] = [unscopedQuery, clientScoped, userMetadata, unreadableQuery, notAutoSubscribed, rlsOff, rlsOpen];

/** Every rule's name, as findings and --allow use it. */
export const RULE_NAMES = RULES.map((r) => r.ruleName);

/** Every rule's findings for one sync config; throws when the file cannot be read as one. */
export function lintSyncConfig(text: string, file: string, rules: LintRule[] = RULES, migrations?: Migrations): LintFinding[] {
  const config = parseSyncConfig(text);
  const context: LintContext = { file, text, config, lineOf: lineFinder(text), ...(migrations ? { migrations } : {}) };
  return rules.flatMap((rule) => rule(context));
}

/** Where Supabase keeps migrations, read when no --migrations is given. */
export const MIGRATIONS_DIR = "supabase/migrations";

/** The first of the usual sync config paths that exists under `dir`. */
export function findSyncConfig(dir: string): string | undefined {
  return SYNC_CONFIG_FILES.find((f) => existsSync(join(dir, f)));
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Finds where a query starts in `text`: the 1-based line and column of the YAML string
 * that holds it (its first content line, for a | or > block), matched with all spacing
 * collapsed. Comments and keys never match, and neither does a longer query that starts
 * the same way. A query written twice is placed at its first copy; one that is no string
 * in the file has no position.
 */
export function lineFinder(text: string): (sql: string) => Position | undefined {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines });
  const at = new Map<string, Position>();
  visit(doc, {
    Scalar(_, node) {
      if (typeof node.value !== "string" || !node.range) return;
      const key = collapse(node.value);
      if (!key || at.has(key)) return;
      const start = lines.linePos(node.range[0]);
      if (node.type !== Scalar.BLOCK_LITERAL && node.type !== Scalar.BLOCK_FOLDED) {
        at.set(key, { line: start.line, column: start.col });
        return;
      }
      // A block starts at its | or >; the query at the first content line's indentation.
      const line = start.line + (/^\n*/.exec(node.value)?.[0].length ?? 0) + 1;
      const indent = / */y;
      indent.lastIndex = lines.lineStarts[line - 1] ?? 0;
      at.set(key, { line, column: (indent.exec(text)?.[0].length ?? 0) + 1 });
    },
  });
  return (sql) => at.get(collapse(sql));
}

/** Where `sql` starts in `text`; see lineFinder. */
export function lineOf(text: string, sql: string): Position | undefined {
  return lineFinder(text)(sql);
}
