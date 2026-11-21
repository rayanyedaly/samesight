/**
 * `samesight agent init`: installs the samesight skill where each agent reads skills, and
 * adds the post-edit hook to Claude Code's and Codex's hook settings (Cursor runs Claude
 * Code's). It never removes a file or changes a setting of the user's: it adds the hook beside
 * theirs, and adds or updates the skill's own files. A second run writes nothing. `print`
 * says what it would do and writes nothing.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findSyncConfig, SYNC_CONFIG_FILES } from "../lint/lint.ts";
import { type HookEntry, type Merge, mergeHook } from "./settings.ts";
import { SKILL_DIR, SKILL_TARGETS, skillFiles } from "./skill.ts";

export const AGENTS = ["claude", "codex", "cursor"] as const;
export type Agent = (typeof AGENTS)[number];

/** Where each agent reads hooks, and the tools whose edits run them. Cursor runs Claude Code's. */
const SETTINGS = {
  claude: { file: ".claude/settings.json", matcher: "Write|Edit|MultiEdit" },
  codex: { file: ".codex/hooks.json", matcher: "apply_patch|Edit|Write" },
} as const;

export interface InitOptions {
  root: string;
  agents: Agent[];
  /** Lint's arguments, for the hook command: sync configs, migrations, --allow. */
  given: string[];
  migrationsDir?: string | undefined;
  allow: string[];
  print: boolean;
  skillDir?: string;
}

export interface InitResult {
  code: 0 | 2;
  lines: string[];
}

/**
 * What a value in the hook command may hold: ASCII letters and digits, spaces and `_+:./-`,
 * not starting with `-`. Bash, zsh, cmd.exe and PowerShell each read something else
 * specially, inside quotes or out ($(...), backticks, %VAR%, `,` and a leading `@` in
 * PowerShell, a leading `=` in zsh), a leading `-` would be read as an option, a value with
 * no letter or digit (`.`, a space) names no sync config, and the command runs on every edit
 * for everyone who commits it: anything else is refused rather than quoted.
 */
const SAFE_VALUE = /^(?!-)(?=.*[A-Za-z0-9])[A-Za-z0-9_+:./ -]+$/;

/** The values the hook command carries: lint's sync configs, migrations directory and --allow entries. */
const hookValues = (o: Pick<InitOptions, "given" | "migrationsDir" | "allow">) => [...o.given, ...(o.migrationsDir ? [o.migrationsDir] : []), ...o.allow];

/** The hook command's arguments: lint's sync configs, migrations and --allow. */
const hookArgs = (o: Pick<InitOptions, "given" | "migrationsDir" | "allow">) => [...o.given, ...(o.migrationsDir ? ["--migrations", o.migrationsDir] : []), ...o.allow.flatMap((a) => ["--allow", a])];

/** The values the hook command cannot carry safely. */
export function unsafeArgs(o: Pick<InitOptions, "given" | "migrationsDir" | "allow">): string[] {
  return hookValues(o).filter((a) => !SAFE_VALUE.test(a));
}

/**
 * The hook command: npx runs the samesight it finds (the project's, a parent folder's, a global
 * one) and installs none; Yarn Plug'n'Play has no node_modules for npx to look in. Arguments
 * with a space are double-quoted, which every shell reads alike for the characters allowed.
 */
export function hookCommand(o: Pick<InitOptions, "root" | "given" | "migrationsDir" | "allow">): string {
  const run = existsSync(join(o.root, ".pnp.cjs")) ? "yarn samesight" : "npx --no-install samesight";
  const unsafe = unsafeArgs(o);
  if (unsafe.length) throw new Error(`the hook command cannot carry ${unsafe.map((a) => JSON.stringify(a)).join(", ")}`);
  return [run, "agent", "hook", ...hookArgs(o).map((a) => (a.includes(" ") ? `"${a}"` : a))].join(" ");
}

/** Whether `path`, once symlinks are followed (its own included), stays in the project. */
function staysInside(root: string, path: string): boolean {
  // lstat, not exists: a dangling symlink exists for a write, which would create its target.
  const there = (p: string) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  let existing = path;
  while (!there(existing) && dirname(existing) !== existing) existing = dirname(existing);
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    // A symlink to nothing: where it would write is not known to be inside.
    return false;
  }
  const r = relative(realpathSync(root), real);
  return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}

export function agentInit(o: InitOptions): InitResult {
  const root = resolve(o.root);
  const unsafe = unsafeArgs(o);
  if (unsafe.length) {
    return { code: 2, lines: [`not writing anything: the hook command would carry ${unsafe.map((a) => JSON.stringify(a)).join(", ")}; its values may hold only ASCII letters and digits, spaces and _+:./-, must hold a letter or digit, and may not start with - (use / in paths)`] };
  }
  const lines: string[] = [];
  let code: 0 | 2 = 0;
  let changed = false;
  const would = (done: string, todo: string) => (o.print ? todo : done);
  const shown = (path: string) => relative(root, path).split(sep).join("/");
  /** Says the system refused to read or write a file, without the path on this machine. */
  const refused = (what: string, path: string, e: unknown) => {
    lines.push(`cannot ${what} ${shown(path)}: ${(e as Error).message.split(root).join(".")}`);
    code = 2;
  };
  /**
   * Writes a file by writing a new one beside it and renaming it into place: the name is
   * replaced, so a symlink or a hard link there is never written through, and the file it
   * shared contents with elsewhere keeps its own. False, said in `lines`, when the system
   * refuses (a file where a folder must go, say).
   */
  const write = (path: string, text: string | Buffer): boolean => {
    if (o.print) {
      changed = true;
      return true;
    }
    const temp = join(dirname(path), `.${basename(path)}.samesight-${process.pid}`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      // wx: a file (or a symlink) already at the temporary name is not written through either.
      writeFileSync(temp, text, { flag: "wx" });
      renameSync(temp, path);
      changed = true;
      return true;
    } catch (e) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // Its folder could not be made: there is no temporary file to remove.
      }
      refused("write", path, e);
      return false;
    }
  };
  /** A file's bytes, or undefined, said in `lines`, when the system refuses (a folder where a file goes, say). */
  const read = (path: string): Buffer | undefined => {
    try {
      return readFileSync(path);
    } catch (e) {
      refused("read", path, e);
      return undefined;
    }
  };

  // The skill, for each agent asked for.
  const dir = o.skillDir ?? SKILL_DIR;
  const files = skillFiles(dir);
  if (!files.length) {
    lines.push(`no skill files in ${dir}: this samesight package is incomplete; reinstall it`);
    code = 2;
  }
  for (const agent of files.length ? o.agents : []) {
    const target = SKILL_TARGETS[agent];
    const at = join(root, target);
    if (!staysInside(root, at)) {
      lines.push(`not writing ${target}: it leads out of the project through a symlink`);
      code = 2;
      continue;
    }
    // Each file is checked too: a symlinked references/ folder would otherwise be written into.
    const outside = files.filter((f) => !staysInside(root, join(at, f)));
    if (outside.length) {
      lines.push(`not writing ${target}: ${outside.join(", ")} lead${outside.length === 1 ? "s" : ""} out of the project through a symlink`);
      code = 2;
      continue;
    }
    // The files missing or different, in the skill's order.
    const before = code;
    const touched = files.filter((f) => !existsSync(join(at, f)) || !(read(join(at, f)) ?? Buffer.alloc(0)).equals(readFileSync(join(dir, f))));
    if (code !== before) continue;
    const fresh = touched.length === files.length && !existsSync(at);
    if (!touched.every((f) => write(join(at, f), readFileSync(join(dir, f))))) continue;
    if (!touched.length) lines.push(`${target}: up to date`);
    else if (fresh) lines.push(`${target}: ${would("created", "would create")} (${files.length} files)`);
    else lines.push(`${target}: ${would("updated", "would update")} ${touched.join(", ")}`);
  }

  // The hook, in each settings file the agents asked for read.
  const command = hookCommand({ ...o, root });
  const settings = [...new Set(o.agents.map((a) => (a === "cursor" ? "claude" : a)))] as (keyof typeof SETTINGS)[];
  for (const agent of settings) {
    const { file, matcher } = SETTINGS[agent];
    const path = join(root, file);
    const entry: HookEntry = { matcher, hooks: [{ type: "command", command, timeout: 30 }] };
    if (!staysInside(root, path)) {
      lines.push(`not writing ${file}: it leads out of the project through a symlink`);
      code = 2;
      continue;
    }
    const text = existsSync(path) ? read(path) : undefined;
    if (existsSync(path) && text === undefined) continue;
    const merge: Merge = mergeHook(text?.toString("utf8"), entry);
    if (merge.status === "create" || merge.status === "update") {
      if (!write(path, merge.text as string)) continue;
      lines.push(`${file}: ${merge.status === "create" ? would("created, with the samesight hook", "would create, with the samesight hook") : would("added the samesight hook", "would add the samesight hook")}`);
      if (o.print) lines.push(...(merge.text as string).trimEnd().split("\n").map((l) => `  ${l}`));
    } else if (merge.status === "unchanged") lines.push(`${file}: up to date`);
    else if (merge.status === "kept") lines.push(`${file}: left as it is (${merge.why})`);
    else {
      lines.push(`${file}: cannot add the hook: ${merge.why}; add this entry to hooks.PostToolUse by hand:`, ...JSON.stringify(entry, null, 2).split("\n").map((l) => `  ${l}`));
      code = 2;
    }
  }

  // What the hook will lint, and what is left to do.
  const missing = o.given.filter((f) => !existsSync(resolve(root, f)));
  if (missing.length) lines.push(`note: ${missing.join(", ")} not found; the hook lints it once it exists`);
  if (!o.given.length && findSyncConfig(root) === undefined) lines.push(`note: no sync config here (tried ${SYNC_CONFIG_FILES.join(", ")}); the hook does nothing until one exists, or name yours: samesight agent init path/to/sync-config.yaml`);
  if (changed) {
    if (o.agents.includes("cursor")) lines.push("Cursor runs the hook in .claude/settings.json when its third-party hooks setting is on; see https://rayanyedaly.github.io/samesight/agents for what is known to work.");
    if (settings.includes("codex")) lines.push("Codex asks you to review and trust a new hook: run /hooks in Codex. The Codex hook follows Codex's documented format and has not been tried with a running Codex yet.");
    if (!o.print) lines.push("Commit these files so every agent working on the project runs the hook.");
  }
  return { code, lines };
}
