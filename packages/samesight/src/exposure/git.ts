/**
 * A sync config and its migrations as a git commit holds them, for `samesight exposure
 * --against <ref>`. Git runs with an argument list, never through a shell, and the ref is
 * resolved to a full commit id before anything else reads it, so no ref can be taken for an
 * option.
 */

import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";
import { applyMigrations, type Migrations } from "../lint/migrations.ts";

/** A problem reading the commit, with what to do about it. */
export class GitError extends Error {}

/** A commit to compare with: the ref as given, and the commit it names. */
export interface Commit {
  ref: string;
  sha: string;
  /** The directory paths are read from, as the command was run in. */
  cwd: string;
}

/** Largest object git may hand back: sync configs and migrations are far smaller. */
const MAX_BYTES = 64 * 1024 * 1024;

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BYTES, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") throw new GitError("git is not installed or not on the PATH; --against reads the commit with git");
    if (err.code === "ENOBUFS") throw new GitError(`a file in the commit is over ${MAX_BYTES / 1024 / 1024} MB; that is no sync config or migration`);
    throw Object.assign(new GitError(String(err.stderr ?? err.message).trim()), { failed: true });
  }
}

/** Whether git ran and failed (a ref or path it does not have), rather than not running at all. */
const failed = (e: unknown) => e instanceof GitError && (e as GitError & { failed?: boolean }).failed === true;

/** The commit `ref` names, in the repository `cwd` is in. */
export function resolveCommit(ref: string, cwd: string): Commit {
  if (!ref) throw new GitError("--against needs a commit: a branch, a tag or a commit id");
  try {
    git(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch (e) {
    if (failed(e)) throw new GitError("not in a git repository; --against compares with a commit of the repository the command runs in");
    throw e;
  }
  try {
    const sha = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], cwd).trim();
    if (/^[0-9a-f]{40,64}$/.test(sha)) return { ref, sha, cwd };
  } catch (e) {
    if (!failed(e)) throw e;
  }
  // Only a name git could fetch gets the hint: a ref like -x names nothing to fetch.
  throw new GitError(`no commit ${ref} in this repository${ref.startsWith("-") ? "" : `; in a shallow clone, fetch it first (git fetch origin ${ref})`}`);
}

/** A path as git reads it against a commit: relative to where the command runs, with forward slashes. */
function spec(commit: Commit, path: string): string {
  const rel = (isAbsolute(path) ? relative(commit.cwd, path) : path).split(sep).join("/");
  if (rel === "" || rel === ".") return "./";
  return rel.startsWith("../") || rel === ".." ? rel : `./${rel.replace(/^\.\//, "")}`;
}

/** The type of the object at `path` in the commit, or undefined when the commit has nothing there. */
function typeAt(commit: Commit, path: string): string | undefined {
  try {
    return git(["cat-file", "-t", `${commit.sha}:${spec(commit, path)}`], commit.cwd).trim();
  } catch (e) {
    if (!failed(e)) throw e;
    const message = (e as Error).message;
    // A path that leads out of the repository is a mistake, not a file the commit lacks.
    if (/outside repository/i.test(message)) throw new GitError(`${path} is outside the repository, so no commit holds it`);
    return undefined;
  }
}

/** A file's text in the commit, or undefined when the commit has no file there. */
export function fileAt(commit: Commit, path: string): string | undefined {
  const type = typeAt(commit, path);
  if (type === undefined) return undefined;
  if (type !== "blob") throw new GitError(`${path} is a directory in ${commit.ref}, not a sync config`);
  return git(["cat-file", "blob", `${commit.sha}:${spec(commit, path)}`], commit.cwd);
}

/**
 * The migrations in `dir` as the commit holds them: every `.sql` file directly in it, in name
 * order, as `readMigrations` reads them from disk; findings name the files under `dir`.
 * Undefined when the commit has no such directory.
 */
export function migrationsAt(commit: Commit, dir: string): Migrations | undefined {
  const type = typeAt(commit, dir);
  if (type === undefined) return undefined;
  if (type !== "tree") throw new GitError(`${dir} is a file in ${commit.ref}, not a directory of migrations`);
  // mode SP type SP id TAB name, NUL-terminated: names may hold anything but NUL. Run from a
  // subdirectory, ls-tree would keep only the entries under that directory's path: --full-tree
  // lists the whole tree it is given.
  const entries = git(["ls-tree", "--full-tree", "-z", `${commit.sha}:${spec(commit, dir)}`], commit.cwd)
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [, type, id] = line.slice(0, tab).split(" ");
      return { type, id: id as string, name: line.slice(tab + 1) };
    })
    .filter((e) => e.type === "blob" && e.name.endsWith(".sql"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return applyMigrations(entries.map((e) => ({ file: join(dir, e.name), sql: git(["cat-file", "blob", e.id], commit.cwd) })));
}
