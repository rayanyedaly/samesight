/**
 * `samesight agent hook`: run by an agent's post-edit hook, with the hook's JSON on stdin.
 * When the edit touched the project's sync config, a sync config elsewhere, or a migration,
 * it lints the sync configs and answers the agent. The edit has already been made; for an
 * error finding (a leak) or a sync config lint cannot read, the hook exits 2 with the
 * findings on stderr, which Claude Code and Codex hand to the agent as an error to fix.
 * Anything else is context: exit 0 with the findings as additionalContext. Any other edit
 * gets no output. A problem of the hook's own never reaches the agent as an error.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
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
  // A file's own path, as the file system spells it (its case on macOS and Windows), with symlinks followed.
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };
  const same = (a: string, b: string) => {
    const [x, y] = [real(a), real(b)];
    return env.win32 ? x.toLowerCase() === y.toLowerCase() : x === y;
  };
  const under = (base: string, p: string) => {
    const r = relative(base, p);
    return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
  };
  // In the project by name, and still once symlinks are followed: a link out is not read.
  // In the project once symlinks are followed (the project's own folder may be a link); by name when not there yet.
  const inside = (p: string) => (existsSync(p) ? under(real(root), real(p)) : under(root, p));

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
    return context([`samesight lint found ${count(run.kept.length, "finding")} in ${run.files.join(", ")}, none of them an error. Decide each with the user; they do not block.`, ...entries(sortFindings(run.kept))], notes);
  }
  const rest = run.kept.filter((f) => f.level !== "error");
  const text = [
    `samesight lint found ${[errors.length ? count(errors.length, "error") : "", run.unreadable.length ? `${count(run.unreadable.length, "sync config")} it cannot read` : ""].filter(Boolean).join(" and ")} after this edit:`,
    ...entries(sortFindings(errors)),
    ...run.unreadable.map((u) => `${oneLine(u.file)}: cannot be read as a sync config: ${oneLine(u.error.split("\n")[0] ?? "")}`),
    ...(rest.length ? ["Not blocking (decide these with the user):", ...entries(sortFindings(rest))] : []),
  ];
  // What to do comes last, and is kept however much is cut.
  return { code: 2, stdout: "", stderr: `${cap(text, [...notes, "Fix the errors above before going on. If a finding is intended, ask the user before accepting it with --allow."])}\n` };
}

/** Whether a YAML file is a sync config: sync streams or legacy sync rules at its top level. */
function looksLikeSyncConfig(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    // A mapping of streams or buckets: a top-level streams: list is some other tool's file.
    const doc = parse(readFileSync(path, "utf8")) as unknown;
    const mapping = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
    return mapping(doc) && (mapping((doc as Record<string, unknown>).streams) || mapping((doc as Record<string, unknown>).bucket_definitions));
  } catch {
    // YAML it cannot read is not known to be a sync config; the usual paths are linted anyway.
    return false;
  }
}

/** Text from the project's files on one line: a name holding a newline cannot start a line of its own. */
const oneLine = (s: string) => s.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim();

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** Each finding as one entry: its line, and where to read the fix. */
function entries(findings: LintFinding[]): string[] {
  return findings.map((f) => {
    const at = [f.file, f.line, f.column].filter((x) => x !== undefined).join(":");
    const help = RULE_INFO[f.rule]?.help;
    return `${oneLine(at)}  ${f.level}  ${f.rule}  ${oneLine(f.message)}\n  Fix: references/${f.rule}.md in the samesight skill${help ? `, or ${help}` : ""}`;
  });
}

/** The entries, cut to what an agent's hook may pass and saying how many were cut, then `tail` whole. */
function cap(text: string[], tail: string[] = []): string {
  const room = LIMIT - tail.reduce((n, t) => n + t.length + 1, 0) - 100;
  const out: string[] = [];
  let size = 0;
  for (const [i, entry] of text.entries()) {
    if (size + entry.length + 1 > room) {
      out.push(`and ${text.length - i} more: run samesight lint --format json to see them all`);
      break;
    }
    out.push(entry);
    size += entry.length + 1;
  }
  return [...out, ...tail].join("\n");
}

/** A non-blocking answer: the text as additionalContext, which the agent reads alongside the edit. */
function context(text: string[], tail: string[] = []): HookResult {
  const doc = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: cap(text, tail) } };
  return { code: 0, stdout: `${JSON.stringify(doc)}\n`, stderr: "" };
}
