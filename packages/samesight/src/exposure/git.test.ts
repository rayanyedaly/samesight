import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { readMigrations } from "../lint/migrations.ts";
import { fileAt, GitError, migrationsAt, resolveCommit } from "./git.ts";

/** A directory for one test, removed when it ends. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "samesight-git-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repository holding `files`, committed, and its commit id. */
function repo(files: Record<string, string>): { dir: string; sha: string } {
  const dir = tempDir();
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "commit.gpgsign", "false");
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
  "supabase/migrations/notes.txt": "not a migration",
};

describe("resolveCommit", () => {
  it("names the commit a branch, a tag, HEAD~n or a commit id stands for", () => {
    const { dir, sha } = repo({ "a.yaml": "a" });
    git(dir, "tag", "v1");
    write(dir, { "a.yaml": "b" });
    git(dir, "commit", "-q", "-am", "two");
    for (const ref of ["v1", "HEAD~1", sha, sha.slice(0, 10)]) expect(resolveCommit(ref, dir), ref).toEqual({ ref, sha, cwd: dir });
    expect(resolveCommit("HEAD", dir).sha).not.toBe(sha);
  });

  it("says a ref the repository does not have is missing, and how to fetch it", () => {
    const { dir } = repo({ "a.yaml": "a" });
    expect(() => resolveCommit("main-that-is-not", dir)).toThrow(/no commit main-that-is-not in this repository; in a shallow clone, fetch it first/);
  });

  it("never reads a ref as an option", () => {
    const { dir } = repo({ "a.yaml": "a" });
    const out = join(dir, "written");
    for (const ref of [`--output=${out}`, "-h", "--all", "--git-dir=/"]) {
      expect(() => resolveCommit(ref, dir), ref).toThrow(GitError);
    }
    expect(existsSync(out)).toBe(false);
  });

  it("says when the directory is in no repository", () => {
    const dir = tempDir();
    let inRepo = true;
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, stdio: "ignore" });
    } catch {
      inRepo = false;
    }
    // The system's temp directory is in no repository on any CI runner; skip where it is.
    if (inRepo) return;
    expect(() => resolveCommit("HEAD", dir)).toThrow(/not in a git repository; --against compares with a commit of the repository the command runs in/);
  });

  it("needs a ref", () => {
    const { dir } = repo({ "a.yaml": "a" });
    expect(() => resolveCommit("", dir)).toThrow(/--against needs a commit/);
  });
});

describe("fileAt", () => {
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

  it("gives undefined when the commit has no such directory, and refuses a file", () => {
    const { dir, sha } = repo({ "a.yaml": "a" });
    const commit = resolveCommit(sha, dir);
    expect(migrationsAt(commit, "supabase/migrations")).toBeUndefined();
    expect(() => migrationsAt(commit, "a.yaml")).toThrow(/a.yaml is a file in .*, not a directory of migrations/);
  });
});
