/**
 * `samesight agent hook`: run by an agent's post-edit hook, with the hook's JSON on stdin.
 * When the edit touched the project's sync config, a sync config elsewhere, or a migration,
 * it lints the sync configs and answers the agent. An error finding (a leak) or a sync config
 * lint cannot read blocks: exit 2, with the findings on stderr, which Claude Code and Codex
 * hand to the agent. Anything else is context: exit 0 with the findings as additionalContext.
 * An edit to any other file costs nothing and says nothing. A problem of the hook's own
 * never blocks the agent.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { type LintFinding, sortFindings } from "../lint/finding.ts";
import { findSyncConfig, MIGRATIONS_DIR, RULE_NAMES } from "../lint/lint.ts";
import { RULE_INFO } from "../lint/rule-info.ts";
import { type LintRun, runLint, unknownRules } from "../lint/run.ts";
import { readEdit } from "./payload.ts";
import { staleCopies } from "./skill.ts";

export interface HookOptions {
  /** Sync configs named on the hook's command line; none: the first of the usual paths. */
  given: string[];
  migrationsDir?: string | undefined;
  allow: string[];
}

export interface HookEnv {
  /** $CLAUDE_PROJECT_DIR, which Claude Code sets for its hooks. */
  projectDir?: string | undefined;
  /** The hook process's own directory. */
  cwd: string;
  win32?: boolean;
  /** The package's skill directory, for the note on stale copies. */
  skillDir?: string;
}

export interface HookResult {
  code: 0 | 2;
  stdout: string;
  stderr: string;
}

/** What a hook may hand an agent: Claude Code takes 10,000 characters of context. */
const LIMIT = 9_500;

const QUIET: HookResult = { code: 0, stdout: "", stderr: "" };

/** The hook's answer to one payload. Never throws: a problem of its own is a note to the user, exit 0. */
export function agentHook(input: string, options: HookOptions, env: HookEnv): HookResult {
  try {
    return answer(input, options, env);
  } catch (e) {
    return { code: 0, stdout: "", stderr: `samesight agent hook: internal error: ${(e as Error).message}\n` };
  }
}

function answer(input: string, options: HookOptions, env: HookEnv): HookResult {
  const edit = readEdit(input);
  if (!edit) return { code: 0, stdout: "", stderr: "samesight agent hook: no hook payload on stdin (a JSON object); nothing to check\n" };
  if (edit.event !== undefined && edit.event !== "PostToolUse") return QUIET;
  const root = resolve(env.projectDir || edit.cwd || env.cwd);
  const from = resolve(root, edit.cwd ?? ".");
  const same = (a: string, b: string) => (env.win32 ? a.toLowerCase() === b.toLowerCase() : a === b);
  const inside = (p: string) => {
    const r = relative(root, p);
    return r !== "" && !r.startsWith("..") && !isAbsolute(r);
  };

  const named = options.given.length ? options.given : [findSyncConfig(root)].filter((f): f is string => f !== undefined);
  const configs = named.map((f) => resolve(root, f));
  const migrations = resolve(root, options.migrationsDir ?? MIGRATIONS_DIR);
  const edited = edit.paths.map((p) => resolve(from, p)).filter(inside);

  // Which of the edited files call for a lint, and sync configs outside the usual paths.
  let relevant = false;
  const extra: string[] = [];
  for (const path of edited) {
    if (configs.some((c) => same(c, path))) relevant = true;
    else if (extname(path).toLowerCase() === ".sql" && same(dirname(path), migrations)) relevant = true;
    else if ([".yaml", ".yml"].includes(extname(path).toLowerCase()) && looksLikeSyncConfig(path)) {
      relevant = true;
      extra.push(path);
    }
  }
  // A payload naming no file (a shell command, a tool this does not know): by the paths it mentions.
  if (!edit.paths.length) {
    const mentions = [...configs, migrations].map((p) => relative(root, p).split(sep).join("/"));
    relevant = edit.texts.some((t) => mentions.some((m) => m && t.includes(m)));
  }
  if (!relevant) return QUIET;

  const files = [...new Set([...configs, ...extra])].filter((p) => existsSync(p)).map((p) => relative(root, p).split(sep).join("/"));
  if (!files.length) return QUIET;

  const stale = staleCopies(root, env.skillDir).map((t) => `The samesight skill in ${t} differs from the one this samesight ships; npx samesight agent init updates it.`);
  const unknown = unknownRules(options.allow);
  if (unknown.length) return context([`samesight lint could not run: --allow names no rule ${unknown.join(", ")}; the rules are ${RULE_NAMES.join(", ")}.`, ...stale]);
  let run: LintRun;
  try {
    run = runLint({ given: files, migrationsDir: options.migrationsDir, allow: options.allow, cwd: root });
  } catch (e) {
    return context([`samesight lint could not run: ${(e as Error).message}`, ...stale]);
  }
  const notes = [...(run.rlsChecked ? [] : [`No migrations were read (none in ${options.migrationsDir ?? MIGRATIONS_DIR}), so the RLS rules (rls-off, rls-open) did not run.`]), ...stale];
  const errors = run.kept.filter((f) => f.level === "error");
  if (!errors.length && !run.unreadable.length) {
    if (!run.kept.length) return context([`samesight lint: no findings in ${run.files.join(", ")}. Lint reads files only; a clean lint does not show that no rows leak (samesight audit tests that on the local stack).`, ...notes]);
    return context([`samesight lint found ${count(run.kept.length, "finding")} in ${run.files.join(", ")}, none of them an error. Decide each with the user; they do not block.`, ...lines(sortFindings(run.kept)), ...notes]);
  }
  const rest = run.kept.filter((f) => f.level !== "error");
  const text = [
    `samesight lint found ${[errors.length ? count(errors.length, "error") : "", run.unreadable.length ? `${count(run.unreadable.length, "sync config")} it cannot read` : ""].filter(Boolean).join(" and ")} after this edit:`,
    ...lines(sortFindings(errors)),
    ...run.unreadable.map((u) => `${u.file}: cannot be read as a sync config: ${u.error.trimEnd()}`),
    ...(rest.length ? ["Not blocking (decide these with the user):", ...lines(sortFindings(rest))] : []),
    ...notes,
    "Fix the errors above before going on. If a finding is intended, ask the user before accepting it with --allow.",
  ];
  return { code: 2, stdout: "", stderr: `${cap(text)}\n` };
}

/** Whether a YAML file is a sync config: sync streams or legacy sync rules at its top level. */
function looksLikeSyncConfig(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const doc = parse(readFileSync(path, "utf8")) as unknown;
    return typeof doc === "object" && doc !== null && ("streams" in doc || "bucket_definitions" in doc);
  } catch {
    // YAML it cannot read is not known to be a sync config; the usual paths are linted anyway.
    return false;
  }
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** Each finding on a line, with where to read the fix. */
function lines(findings: LintFinding[]): string[] {
  return findings.flatMap((f) => {
    const at = [f.file, f.line, f.column].filter((x) => x !== undefined).join(":");
    const help = RULE_INFO[f.rule]?.help;
    return [`${at}  ${f.level}  ${f.rule}  ${f.message}`, `  Fix: references/${f.rule}.md in the samesight skill${help ? `, or ${help}` : ""}`];
  });
}

/** The lines joined, cut to what an agent's hook may pass, saying what was cut. */
function cap(text: string[]): string {
  const out: string[] = [];
  let size = 0;
  for (const [i, line] of text.entries()) {
    if (size + line.length + 1 > LIMIT) {
      out.push(`and ${text.length - i} more lines: run npx samesight lint --format json`);
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return out.join("\n");
}

/** A non-blocking answer: the text as additionalContext, which the agent reads alongside the edit. */
function context(text: string[]): HookResult {
  const doc = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: cap(text) } };
  return { code: 0, stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
}
