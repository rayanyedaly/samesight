/**
 * A sync config and its migrations as a git commit holds them, for `samesight exposure
 * --against <ref>`. Git runs with an argument list, never through a shell; a ref may not
 * start with "-" and is resolved to a full commit id before anything else reads it, so no
 * ref can be taken for an option. Paths are read as the files on disk would be: symlinks in
 * the commit are followed while they stay in the repository, and a path is placed in the
 * repository by where it really is, whatever links led to it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyMigrations, type Migrations } from "../lint/migrations.ts";

/** A problem reading the commit, with what to do about it. */
export class GitError extends Error {}

/** A commit to compare with: the ref as given, and the commit it names. */
export interface Commit {
  ref: string;
  sha: string;
  /** The directory paths are read from, as the command was run in. */
  cwd: string;
  /** The repository's top directory, symlinks resolved. */
  top: string;
}

/** Largest output git may hand back: sync configs and migrations are far smaller. */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * Git's own path. On Windows a program named without a directory may be looked up in the
 * current directory first, which is the checkout: take the first git.exe on PATH instead.
 */
const gitPath = (() => {
  let found: string | undefined;
  return () => {
    if (found) return found;
    found = "git";
    if (process.platform === "win32") {
      for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (dir && isAbsolute(dir) && existsSync(join(dir, "git.exe"))) {
          found = join(dir, "git.exe");
          break;
        }
      }
    }
    return found;
  };
})();

function run(args: string[], cwd: string, input?: string): Buffer {
  try {
    return execFileSync(gitPath(), args, { cwd, input, maxBuffer: MAX_BYTES, timeout: 60_000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer };
    if (err.code === "ENOENT") throw new GitError("git is not installed or not on the PATH; --against reads the commit with git");
    if (err.code === "ENOBUFS") throw new GitError(`git's answer is over ${MAX_BYTES / 1024 / 1024} MB; a sync config and its migrations are far smaller`);
    if (err.code === "ETIMEDOUT") throw new GitError("git did not answer within a minute");
    throw Object.assign(new GitError(String(err.stderr ?? err.message).trim()), { failed: true });
  }
}

const text = (args: string[], cwd: string, input?: string) => run(args, cwd, input).toString("utf8");

/** Whether git ran and failed, rather than not running at all. */
const failed = (e: unknown) => e instanceof GitError && (e as GitError & { failed?: boolean }).failed === true;

/** The commit `ref` names, in the repository `cwd` is in. */
export function resolveCommit(ref: string, cwd: string): Commit {
  if (!ref) throw new GitError("--against needs a commit: a branch, a tag or a commit id");
  if (ref.startsWith("-")) throw new GitError(`--against takes a branch, a tag or a commit id, which cannot start with "-": ${ref}`);
  let top: string;
  try {
    top = realpathSync.native(text(["rev-parse", "--show-toplevel"], cwd).trim());
  } catch (e) {
    if (failed(e)) throw new GitError("not in a git repository; --against compares with a commit of the repository the command runs in");
    throw e;
  }
  try {
    const sha = text(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).trim();
    if (/^[0-9a-f]{40,64}$/.test(sha)) return { ref, sha, cwd, top };
  } catch (e) {
    if (!failed(e)) throw e;
  }
  // A branch or tag name can be fetched; HEAD~1, HEAD:file and the like cannot.
  const fetchable = /^[\w./-]+$/.test(ref) && ref !== "HEAD" && !ref.includes("..");
  throw new GitError(`no commit ${ref} in this repository${fetchable ? `; in a shallow clone, fetch it first (git fetch origin ${ref})` : ""}`);
}

/**
 * Where a path is in the repository, from its top, with forward slashes: by where it really
 * is, the directories on the way resolved as far as they exist on disk. The file itself is
 * left as named: a symlink there is the commit's to follow.
 */
function repoPath(commit: Commit, path: string): string {
  const full = resolve(commit.cwd, path);
  let real = dirname(full);
  const rest: string[] = [basename(full)];
  while (!existsSync(real) && dirname(real) !== real) {
    rest.unshift(basename(real));
    real = dirname(real);
  }
  real = join(realpathSync.native(real), ...rest);
  const rel = full === dirname(full) ? relative(commit.top, full) : relative(commit.top, real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new GitError(`${path} is outside the repository, so no commit holds it`);
  if (rel.includes("\n")) throw new GitError(`${path}: a path with a line break cannot be read from a commit`);
  return rel.split(sep).join("/");
}

type Found = { oid: string; type: string } | "missing" | { outside: string } | { broken: string };

/** What each `<commit>:<path>` names, links in the commit followed while they stay in the repository. */
function lookup(commit: Commit, paths: string[]): Found[] {
  if (!paths.length) return [];
  const inputs = paths.map((p) => `${commit.sha}:${p}`);
  const lines = text(["cat-file", "--batch-check", "--follow-symlinks"], commit.top, `${inputs.join("\n")}\n`).split("\n");
  const out: Found[] = [];
  let at = 0;
  for (const input of inputs) {
    const head = lines[at++] ?? "";
    if (head === `${input} missing`) out.push("missing");
    else if (/^(symlink|dangling|loop|notdir) \d+$/.test(head)) {
      const target = lines[at++] ?? "";
      const kind = head.split(" ")[0];
      // A link out of the repository; a link to nothing, or through a file, is nothing there.
      if (kind === "symlink") out.push({ outside: target });
      else if (kind === "loop") out.push({ broken: "a loop of symlinks" });
      else out.push("missing");
    } else {
      const [oid, type] = head.split(" ");
      if (!oid || !type || !/^[0-9a-f]{40,64}$/.test(oid)) throw new GitError(`git cat-file answered "${head}" for ${input}`);
      out.push({ oid, type });
    }
  }
  return out;
}

/** The blobs with these ids, read in one go. */
function blobs(commit: Commit, oids: string[]): string[] {
  if (!oids.length) return [];
  const raw = run(["cat-file", "--batch"], commit.top, `${oids.join("\n")}\n`);
  const out: string[] = [];
  let at = 0;
  for (const oid of oids) {
    const end = raw.indexOf(10, at);
    const head = raw.subarray(at, end).toString("utf8");
    const [id, type, size] = head.split(" ");
    if (id !== oid || type !== "blob" || size === undefined) throw new GitError(`git cat-file answered "${head}" for ${oid}`);
    const start = end + 1;
    out.push(raw.subarray(start, start + Number(size)).toString("utf8"));
    at = start + Number(size) + 1;
  }
  return out;
}

/** The object at `path` in the commit; undefined when the commit has nothing there. */
function objectAt(commit: Commit, path: string): { oid: string; type: string } | undefined {
  const at = repoPath(commit, path);
  const [found] = lookup(commit, [at]);
  if (found === "missing" || found === undefined) {
    // cat-file says "missing" for an object git does not have, too: a commit that names the
    // path, with the object gone (a partial or damaged clone), must not read as an empty one.
    if (at && text(["ls-tree", "-z", commit.sha, "--", at], commit.top) !== "") {
      throw new GitError(`${commit.ref} holds ${path}, but git does not have its contents here (a partial or damaged clone?); fetch the commit again`);
    }
    return undefined;
  }
  if ("outside" in found) throw new GitError(`${path} in ${commit.ref} is a symlink out of the repository (${found.outside}), which is not read`);
  if ("broken" in found) throw new GitError(`${path} in ${commit.ref} is ${found.broken}`);
  return found;
}

/** A file's text in the commit, or undefined when the commit has no file there. */
export function fileAt(commit: Commit, path: string): string | undefined {
  const found = objectAt(commit, path);
  if (!found) return undefined;
  if (found.type !== "blob") throw new GitError(`${path} is a directory in ${commit.ref}, not a sync config`);
  return blobs(commit, [found.oid])[0];
}

/**
 * The migrations in `dir` as the commit holds them: every `.sql` file directly in it, in name
 * order, as `readMigrations` reads them from disk (a symlinked file read through its link);
 * findings name the files under `dir`. Undefined when the commit has no such directory.
 */
export function migrationsAt(commit: Commit, dir: string): Migrations | undefined {
  const found = objectAt(commit, dir);
  if (!found) return undefined;
  if (found.type !== "tree") throw new GitError(`${dir} is a file in ${commit.ref}, not a directory of migrations`);
  const base = repoPath(commit, dir);
  // mode SP type SP id TAB name, NUL-terminated. --full-tree: from a subdirectory, ls-tree
  // would keep only the entries under that directory's path.
  const entries = text(["ls-tree", "--full-tree", "-z", found.oid], commit.top)
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, oid] = line.slice(0, tab).split(" ");
      return { mode, type, oid: oid as string, name: line.slice(tab + 1) };
    })
    .filter((e) => e.name.endsWith(".sql") && e.type === "blob")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // A symlink's blob is its target's path: follow it as the disk would.
  const links = entries.filter((e) => e.mode === "120000");
  if (links.some((e) => e.name.includes("\n"))) throw new GitError(`${dir}: a migration name with a line break cannot be read from a commit`);
  const followed = lookup(
    commit,
    links.map((e) => (base ? `${base}/${e.name}` : e.name)),
  );
  links.forEach((e, n) => {
    const f = followed[n];
    const at = join(dir, e.name);
    if (f === "missing" || f === undefined) throw new GitError(`${at} in ${commit.ref} is a symlink to nothing`);
    if ("outside" in f) throw new GitError(`${at} in ${commit.ref} is a symlink out of the repository (${f.outside}), which is not read`);
    if ("broken" in f) throw new GitError(`${at} in ${commit.ref} is ${f.broken}`);
    if (f.type !== "blob") throw new GitError(`${at} in ${commit.ref} is a symlink to a directory, not a migration`);
    e.oid = f.oid;
  });
  const sql = blobs(
    commit,
    entries.map((e) => e.oid),
  );
  return applyMigrations(entries.map((e, n) => ({ file: join(dir, e.name), sql: sql[n] as string })));
}
