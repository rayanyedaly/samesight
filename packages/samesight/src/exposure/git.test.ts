import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { readMigrations } from "../lint/migrations.ts";
import { fileAt, GitError, migrationsAt, resolveCommit } from "./git.ts";

/** A directory for one test, removed when it ends. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "samesight-git-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Git as the tests run it: no GIT_* from the environment, no hooks, no signing, whatever the machine's setup. */
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const SETTINGS = ["-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false", "-c", "core.hooksPath=.no-hooks", "-c", "user.email=test@example.com", "-c", "user.name=test"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...SETTINGS, ...args], { cwd, encoding: "utf8", env: ENV }).trim();
const posix = process.platform !== "win32";

/** A repository holding `files`, committed, and its commit id. */
function repo(files: Record<string, string>): { dir: string; sha: string } {
  const dir = tempDir();
  git(dir, "init", "-q");
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "files");
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}

function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const MIGRATIONS = {
  "supabase/migrations/1_lists.sql": "create table lists (id uuid primary key, name text, owner_id uuid references auth.users);",
  "supabase/migrations/2_email.sql": "alter table lists add column email text;",
  "supabase/migrations/notes.txt": "create table not_a_migration (id uuid primary key);",
};

describe("resolveCommit", () => {
  it("names the commit a branch, a tag, HEAD~n or a commit id stands for", () => {
    const { dir, sha } = repo({ "a.yaml": "a" });
    git(dir, "tag", "v1");
    write(dir, { "a.yaml": "b" });
    git(dir, "commit", "-q", "-am", "two");
    for (const ref of ["v1", "HEAD~1", sha, sha.slice(0, 10)]) expect(resolveCommit(ref, dir), ref).toMatchObject({ ref, sha, cwd: dir, top: realpathSync.native(dir) });
    expect(resolveCommit("HEAD", dir).sha).not.toBe(sha);
  });

  it("says a ref the repository does not have is missing, and how to fetch it", () => {
    const { dir } = repo({ "a.yaml": "a" });
    expect(() => resolveCommit("main-that-is-not", dir)).toThrow(/no commit main-that-is-not in this repository; in a shallow clone, fetch it first \(git fetch origin main-that-is-not\)/);
    // Only a name git can fetch gets the hint.
    for (const ref of ["HEAD~5", "HEAD:a.yaml", "v1..v2"]) expect(() => resolveCommit(ref, dir), ref).toThrow(new GitError(`no commit ${ref} in this repository`));
  });

  it("never reads a ref as an option", () => {
    const { dir } = repo({ "a.yaml": "a" });
    const out = join(dir, "written");
    for (const ref of [`--output=${out}`, "-h", "--all", "--git-dir=/"]) {
      expect(() => resolveCommit(ref, dir), ref).toThrow(`--against takes a branch, a tag or a commit id, which cannot start with "-": ${ref}`);
    }
    expect(existsSync(out)).toBe(false);
  });

  it("says when the directory is in no repository", () => {
    const dir = tempDir();
    // Git looks no higher than the temp directory, whatever repository may hold it.
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dirname(realpathSync.native(dir));
    onTestFinished(() => {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    });
    expect(() => resolveCommit("HEAD", dir)).toThrow(/not in a git repository; --against compares with a commit of the repository the command runs in/);
  });

  it("needs a ref", () => {
    const { dir } = repo({ "a.yaml": "a" });
    expect(() => resolveCommit("", dir)).toThrow(/--against needs a commit/);
  });
});

describe("fileAt", () => {
  it("reads an earlier commit, not the one checked out", () => {
    const { dir, sha } = repo({ "sync-config.yaml": "one" });
    write(dir, { "sync-config.yaml": "two" });
    git(dir, "commit", "-q", "-am", "two");
    write(dir, { "sync-config.yaml": "three" });
    expect(fileAt(resolveCommit("HEAD~1", dir), "sync-config.yaml")).toBe("one");
    expect(fileAt(resolveCommit(sha, dir), "sync-config.yaml")).toBe("one");
    expect(fileAt(resolveCommit("HEAD", dir), "sync-config.yaml")).toBe("two");
  });

  it("reads a file as the commit holds it, not as it is on disk", () => {
    const { dir, sha } = repo({ "powersync/sync-config.yaml": "before" });
    write(dir, { "powersync/sync-config.yaml": "after" });
    const commit = resolveCommit(sha, dir);
    expect(fileAt(commit, "powersync/sync-config.yaml")).toBe("before");
    expect(fileAt(commit, join(dir, "powersync", "sync-config.yaml"))).toBe("before");
  });

  it("reads paths from the directory the command runs in", () => {
    const { dir, sha } = repo({ "app/powersync/sync.yaml": "in app", "top.yaml": "top" });
    const commit = resolveCommit(sha, join(dir, "app"));
    expect(fileAt(commit, "powersync/sync.yaml")).toBe("in app");
    expect(fileAt(commit, "../top.yaml")).toBe("top");
  });

  it("gives undefined for a file the commit does not have", () => {
    const { dir, sha } = repo({ "a.yaml": "a" });
    write(dir, { "new.yaml": "new" });
    expect(fileAt(resolveCommit(sha, dir), "new.yaml")).toBeUndefined();
  });

  it("refuses a directory, and a path out of the repository", () => {
    const { dir, sha } = repo({ "powersync/sync-config.yaml": "a" });
    const commit = resolveCommit(sha, dir);
    expect(() => fileAt(commit, "powersync")).toThrow(/powersync is a directory in .*, not a sync config/);
    expect(() => fileAt(commit, "../elsewhere.yaml")).toThrow(/outside the repository/);
  });

  it.runIf(posix)("follows a symlink the commit holds while it stays in the repository, and refuses one out of it", () => {
    const { dir } = repo({ "shared/sync.yaml": "shared" });
    symlinkSync("shared/sync.yaml", join(dir, "sync-config.yaml"));
    symlinkSync("/etc/hostname", join(dir, "out.yaml"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "links");
    const commit = resolveCommit("HEAD", dir);
    expect(fileAt(commit, "sync-config.yaml")).toBe("shared");
    expect(() => fileAt(commit, "out.yaml")).toThrow(/out.yaml in HEAD is a symlink out of the repository/);
  });

  it.runIf(posix)("places a path by where it really is: through a link to the repository, or out and back in", () => {
    const { dir, sha } = repo({ "app/sync.yaml": "in app" });
    const link = join(tempDir(), "link");
    symlinkSync(dir, link);
    const commit = resolveCommit(sha, join(dir, "app"));
    expect(fileAt(commit, join(link, "app", "sync.yaml"))).toBe("in app");
    expect(fileAt(commit, join("..", "..", basename(dir), "app", "sync.yaml"))).toBe("in app");
    expect(fileAt(resolveCommit(sha, join(link, "app")), "sync.yaml")).toBe("in app");
  });

  it("refuses to read a path the commit names when git does not have its contents", () => {
    const { dir } = repo({ "sync-config.yaml": "a" });
    const oid = git(dir, "rev-parse", "HEAD:sync-config.yaml");
    unlinkSync(join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
    expect(() => fileAt(resolveCommit("HEAD", dir), "sync-config.yaml")).toThrow(/HEAD holds sync-config.yaml, but git does not have its contents here/);
  });

  it("reads names with spaces and quotes as they are", () => {
    const { dir, sha } = repo({ "my config's 'x'.yaml": "odd" });
    expect(fileAt(resolveCommit(sha, dir), "my config's 'x'.yaml")).toBe("odd");
  });
});

describe("migrationsAt", () => {
  it("reads the .sql files directly in the directory, in name order, as readMigrations reads them from disk", () => {
    const { dir, sha } = repo({ ...MIGRATIONS, "supabase/migrations/nested/3.sql": "create table nested (id uuid primary key);" });
    const fromGit = migrationsAt(resolveCommit(sha, dir), "supabase/migrations");
    const fromDisk = readMigrations(join(dir, "supabase/migrations"), "supabase/migrations");
    expect(fromGit).toEqual(fromDisk);
    expect(fromGit?.tables.get("lists")?.columns.map((c) => c.name)).toEqual(["id", "name", "owner_id", "email"]);
    expect(fromGit?.tables.has("nested")).toBe(false);
    expect(fromGit?.tables.has("not_a_migration")).toBe(false);
  });

  it("skips a directory whose name ends in .sql", () => {
    const { dir, sha } = repo({ ...MIGRATIONS, "supabase/migrations/folder.sql/3.sql": "create table in_a_folder (id uuid primary key);" });
    const fromGit = migrationsAt(resolveCommit(sha, dir), "supabase/migrations");
    expect(fromGit?.tables.has("in_a_folder")).toBe(false);
    expect(fromGit?.tables.has("lists")).toBe(true);
  });

  it("reads them from a subdirectory as from the top", () => {
    const { dir, sha } = repo(Object.fromEntries(Object.entries(MIGRATIONS).map(([path, text]) => [`app/${path}`, text])));
    const app = join(dir, "app");
    expect(migrationsAt(resolveCommit(sha, app), "supabase/migrations")).toEqual(readMigrations(join(app, "supabase/migrations"), "supabase/migrations"));
    expect(migrationsAt(resolveCommit(sha, app), "supabase/migrations")?.tables.has("lists")).toBe(true);
  });

  it("reads the commit, not the files on disk", () => {
    const { dir, sha } = repo(MIGRATIONS);
    write(dir, { "supabase/migrations/3_phone.sql": "alter table lists add column phone text;" });
    expect(migrationsAt(resolveCommit(sha, dir), "supabase/migrations")?.tables.get("lists")?.columns.map((c) => c.name)).not.toContain("phone");
  });

  it.runIf(posix)("follows a symlinked migration, and a symlinked directory, as the disk does", () => {
    const { dir } = repo({ "shared/orgs.sql": "create table orgs (id uuid primary key, ssn text);", "db/supabase/migrations/2.sql": "alter table orgs add column phone text;" });
    symlinkSync("../../../shared/orgs.sql", join(dir, "db/supabase/migrations/1.sql"));
    symlinkSync("db/supabase", join(dir, "supabase"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "links");
    const fromGit = migrationsAt(resolveCommit("HEAD", dir), "supabase/migrations");
    expect(fromGit?.tables.get("orgs")?.columns.map((c) => c.name)).toEqual(["id", "ssn", "phone"]);
    expect(fromGit).toEqual(readMigrations(join(dir, "supabase/migrations"), "supabase/migrations"));
  });

  it("refuses a migrations directory the commit names when git does not have it", () => {
    const { dir } = repo(MIGRATIONS);
    const oid = git(dir, "rev-parse", "HEAD:supabase/migrations");
    unlinkSync(join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
    expect(() => migrationsAt(resolveCommit("HEAD", dir), "supabase/migrations")).toThrow(/git does not have its contents here/);
  });

  it("gives undefined when the commit has no such directory, and refuses a file", () => {
    const { dir, sha } = repo({ "a.yaml": "a" });
    const commit = resolveCommit(sha, dir);
    expect(migrationsAt(commit, "supabase/migrations")).toBeUndefined();
    expect(() => migrationsAt(commit, "a.yaml")).toThrow(/a.yaml is a file in .*, not a directory of migrations/);
  });
});
