/**
 * A sync config and its migrations as a git commit holds them, for `samesight exposure
 * --against <ref>`. Git runs with an argument list, never through a shell; a ref may not
 * start with "-" and is resolved to a full commit id before anything else reads it, so no
 * ref can be taken for an option. A path is placed in the repository as named when that is
 * inside it, else by where its directories really are on disk; in the commit, its links are
 * followed while they stay in the repository. (The files on disk are read through any link.)
 * In a partial clone, git may fetch an object the commit needs from the clone's remote.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyMigrations, type Migrations } from "../lint/migrations.ts";
import { named } from "./text.ts";

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
 * current directory first, which is the checkout: there, only a git.exe in an absolute PATH
 * directory is run, and none found is git missing.
 */
const gitPath = (() => {
  let found: string | undefined;
  return () => {
    if (found) return found;
    if (process.platform !== "win32") found = "git";
    else {
      const dir = (process.env.PATH ?? "").split(delimiter).find((d) => d && isAbsolute(d) && existsSync(join(d, "git.exe")));
      if (dir === undefined) throw new GitError("git is not installed or not on the PATH; --against reads the commit with git");
      found = join(dir, "git.exe");
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
  if (ref.startsWith("-")) throw new GitError(`--against takes a branch, a tag or a commit id, which cannot start with "-": ${named(ref)}`);
  let top: string;
  try {
    top = realpathSync.native(text(["rev-parse", "--show-toplevel"], cwd).trim());
  } catch (e) {
    if (!failed(e)) throw e;
    // Git refuses a repository another user owns (in a container, say) until it is marked safe.
    if (/dubious ownership/i.test((e as Error).message)) throw new GitError("git refuses this repository, which another user owns; mark it safe (git config --global --add safe.directory <its path>) and run again");
    throw new GitError("not in a git repository; --against compares with a commit of the repository the command runs in");
  }
  try {
    const sha = text(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).trim();
    if (/^[0-9a-f]{40,64}$/.test(sha)) return { ref, sha, cwd, top };
  } catch (e) {
    if (!failed(e)) throw e;
  }
  throw new GitError(`no commit ${named(ref)} in this repository${fetchHint(ref)}`);
}

/**
 * How to get a branch or tag a shallow clone lacks: fetch it, then compare with FETCH_HEAD,
 * which works whatever kind of ref it is. None for a commit id (a remote may not serve one),
 * HEAD~1, HEAD:file and the like, which name nothing to fetch.
 */
function fetchHint(ref: string): string {
  if (!/^[\w./-]+$/.test(ref) || ref === "HEAD" || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock") || ref.startsWith("refs/") || /^[0-9a-f]{7,64}$/.test(ref)) return "";
  const name = /^origin\/(.+)$/.exec(ref)?.[1] ?? ref;
  return `; in a shallow clone, fetch it first (git fetch origin ${name}) and compare with FETCH_HEAD`;
}

/**
 * Where a path is in the repository, from its top, with forward slashes. As named, when that
 * is inside the repository: the commit's own symlinks are then followed as the commit holds
 * them. Else (an absolute path through a link to the repository, a short Windows name) by
 * where its directories really are on disk, the file itself left as named.
 */
function repoPath(commit: Commit, path: string): string {
  const full = resolve(commit.cwd, path);
  let rel = relative(commit.top, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    let real = dirname(full);
    const rest: string[] = [basename(full)];
    while (!existsSync(real) && dirname(real) !== real) {
      rest.unshift(basename(real));
      real = dirname(real);
    }
    rel = relative(commit.top, join(realpathSync.native(real), ...rest));
  }
  if (rel.startsWith("..") || isAbsolute(rel)) throw new GitError(`${named(path)} is outside the repository, so no commit holds it`);
  if (rel.includes("\n")) throw new GitError(`${named(path)}: a path with a line break cannot be read from a commit`);
  return rel.split(sep).join("/");
}

type Found = { oid: string; type: string } | "missing" | "dangling" | { outside: string } | { broken: string };

/**
 * What each `<commit>:<path>` names, links in the commit followed while they stay in the
 * repository. Read by the sizes git gives, so a link target holding a line break cannot shift
 * the answers that follow.
 */
function lookup(commit: Commit, paths: string[]): Found[] {
  if (!paths.length) return [];
  const inputs = paths.map((p) => `${commit.sha}:${p}`);
  const raw = run(["cat-file", "--batch-check", "--follow-symlinks"], commit.top, `${inputs.join("\n")}\n`);
  const out: Found[] = [];
  let at = 0;
  const nextLine = () => {
    const end = raw.indexOf(10, at);
    const line = raw.subarray(at, end < 0 ? raw.length : end).toString("utf8");
    at = end < 0 ? raw.length : end + 1;
    return line;
  };
  for (const input of inputs) {
    const head = nextLine();
    const link = /^(symlink|dangling|loop|notdir) (\d+)$/.exec(head);
    if (head === `${input} missing`) out.push("missing");
    else if (link) {
      const size = Number(link[2]);
      const target = raw.subarray(at, at + size).toString("utf8");
      at += size + 1;
      // A link out of the repository; one to nothing, or through a file, holds nothing there.
      if (link[1] === "symlink") out.push({ outside: target });
      else if (link[1] === "loop") out.push({ broken: "a loop of symlinks" });
      else out.push("dangling");
    } else {
      const [oid, type] = head.split(" ");
      if (!oid || !type || !/^[0-9a-f]{40,64}$/.test(oid)) throw new GitError(`git cat-file answered ${named(head)} for ${named(input)}`);
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
    if (id !== oid || type !== "blob" || size === undefined) throw new GitError(`git cat-file answered ${named(head)} for ${oid}`);
    const start = end + 1;
    out.push(raw.subarray(start, start + Number(size)).toString("utf8"));
    at = start + Number(size) + 1;
  }
  return out;
}

/**
 * The object at `path` in the commit: a blob, a tree, or "commit" for a submodule, whose
 * contents another repository holds. Undefined when the commit has nothing there, a link to
 * nothing included.
 */
function objectAt(commit: Commit, path: string): { oid: string; type: string } | undefined {
  const at = repoPath(commit, path);
  const [found] = lookup(commit, [at]);
  if (found === "dangling" || found === undefined) return undefined;
  if (found === "missing") {
    // cat-file says "missing" for an object git does not have, too: a commit that names the
    // path, with the object gone (a damaged clone, or one whose fetch of it failed), must not
    // read as an empty one. A submodule's commit is another repository's: not ours to read.
    const entry = at ? text(["ls-tree", "-z", commit.sha, "--", at], commit.top) : "";
    if (entry.startsWith("160000 ")) return { oid: "", type: "commit" };
    if (entry === "") {
      // A path inside a submodule: the commit holds the submodule, not the path.
      const parts = at.split("/");
      for (let n = parts.length - 1; n > 0; n--) {
        if (text(["ls-tree", "-z", commit.sha, "--", parts.slice(0, n).join("/")], commit.top).startsWith("160000 ")) return { oid: "", type: "commit" };
      }
      return undefined;
    }
    throw new GitError(`${named(commit.ref)} holds ${named(path)}, but git does not have its contents here (a damaged or partial clone?); fetch the commit again`);
  }
  if ("outside" in found) throw new GitError(`${named(path)} in ${named(commit.ref)} is a symlink out of the repository (${named(found.outside)}), which is not read`);
  if ("broken" in found) throw new GitError(`${named(path)} in ${named(commit.ref)} is ${found.broken}`);
  return found;
}

/** A file's text in the commit, or undefined when the commit has no file there. */
export function fileAt(commit: Commit, path: string): string | undefined {
  const found = objectAt(commit, path);
  if (!found) return undefined;
  if (found.type === "commit") throw new GitError(`${named(path)} is a submodule, or in one, in ${named(commit.ref)}: another repository holds it`);
  if (found.type !== "blob") throw new GitError(`${named(path)} is a directory in ${named(commit.ref)}, not a sync config`);
  return blobs(commit, [found.oid])[0];
}

/**
 * The migrations in `dir` as the commit holds them: every `.sql` file directly in it, in name
 * order, as `readMigrations` reads them from disk (a symlinked file read through its link);
 * findings name the files under `dir`. Undefined when the commit has no such directory, and
 * "submodule" when the commit holds it as one, or in one, whose files another repository holds.
 */
export function migrationsAt(commit: Commit, dir: string): Migrations | "submodule" | undefined {
  const found = objectAt(commit, dir);
  if (!found) return undefined;
  if (found.type === "commit") return "submodule";
  if (found.type !== "tree") throw new GitError(`${named(dir)} is a file in ${named(commit.ref)}, not a directory of migrations`);
  const base = repoPath(commit, dir);
  // mode SP type SP id TAB name, NUL-terminated; run from the top, so every entry is listed.
  const entries = text(["ls-tree", "-z", found.oid], commit.top)
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
  if (links.some((e) => e.name.includes("\n"))) throw new GitError(`${named(dir)}: a migration name with a line break cannot be read from a commit`);
  const followed = lookup(
    commit,
    links.map((e) => (base ? `${base}/${e.name}` : e.name)),
  );
  links.forEach((e, n) => {
    const f = followed[n];
    const at = `${named(join(dir, e.name))} in ${named(commit.ref)}`;
    if (f === "missing" || f === "dangling" || f === undefined) throw new GitError(`${at} is a symlink to nothing`);
    if ("outside" in f) throw new GitError(`${at} is a symlink out of the repository (${named(f.outside)}), which is not read`);
    if ("broken" in f) throw new GitError(`${at} is ${f.broken}`);
    if (f.type !== "blob") throw new GitError(`${at} is a symlink to a directory, not a migration`);
    e.oid = f.oid;
  });
  const sql = blobs(
    commit,
    entries.map((e) => e.oid),
  );
  return applyMigrations(entries.map((e, n) => ({ file: join(dir, e.name), sql: sql[n] as string })));
}
