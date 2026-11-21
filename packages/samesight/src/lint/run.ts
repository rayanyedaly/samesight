/**
 * A lint run as a value: the sync configs it read, what it found, what --allow accepted, the
 * files it could not read, and the messages it would print. The CLI prints them; the agent
 * hook passes them to the agent. Nothing here writes to stdout or stderr.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyAllow, exitCode, type LintFinding, type Unreadable } from "./finding.ts";
import { findSyncConfig, lintSyncConfig, MIGRATIONS_DIR, RULE_NAMES, SYNC_CONFIG_FILES } from "./lint.ts";
import { type Migrations, readMigrations } from "./migrations.ts";

export interface LintRun {
  /** The sync configs read, as given or as found (relative to `cwd` when found). */
  files: string[];
  /** Whether migrations were read, so the RLS rules ran. */
  rlsChecked: boolean;
  /** Findings --allow did not accept. */
  kept: LintFinding[];
  allowed: LintFinding[];
  unreadable: Unreadable[];
  /** What a run says on stderr about the files it could not read, in order. */
  messages: string[];
  /** 0 clean or warnings only, 1 an error finding kept, 2 a file could not be read. */
  code: 0 | 1 | 2;
}

export interface LintOptions {
  /** Sync configs named; none: the first of the usual paths in `cwd`. */
  given: string[];
  /** The migrations directory; none: supabase/migrations in `cwd` when it exists. */
  migrationsDir?: string | undefined;
  /** --allow entries; check them with `unknownRules` first. */
  allow: string[];
  /** Where relative paths start. */
  cwd: string;
}

/** The rules --allow entries name that do not exist: a misspelt rule would allow nothing and look like it worked. */
export function unknownRules(allow: string[]): string[] {
  return allow.map((a) => a.split(":")[0] as string).filter((r) => !RULE_NAMES.includes(r));
}

/** Lints each sync config against the migrations. Throws, with what to fix, when there is no sync config or the migrations cannot be read. */
export function runLint(o: LintOptions): LintRun {
  const files = syncConfigs(o.given, "lint", o.cwd);
  const migrations = migrationsIn(o.migrationsDir, o.cwd)?.migrations;
  const findings: LintFinding[] = [];
  const unreadable: Unreadable[] = [];
  const messages: string[] = [];
  for (const file of files) {
    try {
      findings.push(...lintSyncConfig(readFileSync(resolve(o.cwd, file), "utf8"), file, undefined, migrations));
    } catch (e) {
      const bad = cannotRead(file, e);
      unreadable.push(bad.unreadable);
      messages.push(bad.message);
    }
  }
  const { kept, allowed } = applyAllow(findings, o.allow);
  return { files, rlsChecked: migrations !== undefined, kept, allowed, unreadable, messages, code: unreadable.length ? 2 : exitCode(kept) };
}

/** The sync configs named, else the first of the usual paths in `cwd`; throws when there is none. */
export function syncConfigs(given: string[], command: string, cwd: string): string[] {
  if (given.length) return given;
  const found = findSyncConfig(cwd);
  if (found === undefined) throw new Error(`no sync config found (tried ${SYNC_CONFIG_FILES.join(", ")}); name one: samesight ${command} <file>`);
  return [found];
}

/**
 * The migrations in the directory --migrations names, else in supabase/migrations when it
 * exists in `cwd`; undefined when there is none. Throws, with what to fix, when it cannot be read.
 */
export function migrationsIn(given: string | undefined, cwd: string): { dir: string; migrations: Migrations } | undefined {
  const dir = given ?? (existsSync(resolve(cwd, MIGRATIONS_DIR)) ? MIGRATIONS_DIR : undefined);
  if (!dir) return undefined;
  try {
    return { dir, migrations: readMigrations(resolve(cwd, dir)) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? `no migrations directory at ${dir}; check the path given to --migrations`
        : code === "ENOTDIR"
          ? `${dir} is not a directory; ${given ? "--migrations takes the directory that holds the .sql files" : "make it the directory of .sql migrations, or pass --migrations <dir>"}`
          : `cannot read the migrations in ${dir}: ${(e as Error).message}; fix it, or pass --migrations with another directory`,
    );
  }
}

/** Why a sync config cannot be read, and what to do: the message for stderr and the entry for the report. */
export function cannotRead(file: string, e: unknown): { unreadable: Unreadable; message: string } {
  // A file the system could not read (not there, a directory) is a path to fix; anything else is its YAML.
  const fix = (e as NodeJS.ErrnoException).syscall ? "check the path, or name another file" : "fix the YAML, or name another file";
  const message = (e as Error).message.trimEnd();
  // A YAML error ends with the line it points at: the fix goes below it.
  return { unreadable: { file, error: (e as Error).message }, message: `samesight: ${file}: cannot be read as a sync config: ${message}${message.includes("\n") ? "\n" : "; "}${fix}` };
}
