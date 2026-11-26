import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { NOT_FOUND } from "./forward.ts";

/** A directory for one test, removed when it ends. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "samesight-cli-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Runs the CLI; resolves with its exit code, stderr and stdout. */
const cli = (args: string[], cwd?: string, env?: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | string; stderr: string; stdout: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 15_000, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) }, (e, stdout, stderr) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : `killed (${e.signal}): timed out?`) : 0, stderr, stdout }),
    );
  });

describe("samesight exit codes", () => {
  it("exits 0 for help, and 2 when there is nothing it can run", { timeout: 30_000 }, async () => {
    expect((await cli(["--help"])).code).toBe(0);
    expect((await cli([])).code).toBe(2);
    const unknown = await cli(["frobnicate"]);
    expect([unknown.code, unknown.stderr]).toEqual([2, 'samesight: unknown command "frobnicate"; the commands are init, generate, check, doctor, explain, lint, exposure, agent, audit; see samesight --help\n']);
  });

  it("names a flag it cannot read in Node's words, and where to look", { timeout: 30_000 }, async () => {
    const flag = await cli(["check", "--frobnicate"]);
    expect([flag.code, flag.stderr]).toEqual([2, "samesight: unknown option '--frobnicate'; see samesight --help\n"]);
    const value = await cli(["explain", "--table"]);
    expect([value.code, value.stderr]).toEqual([2, "samesight: option '--table <value>' argument missing; see samesight --help\n"]);
  });

  it("says how to start a database it cannot reach", { timeout: 30_000 }, async () => {
    const policy = fileURLToPath(new URL("../../../examples/fieldbook/samesight.policy.ts", import.meta.url));
    const result = await cli(["generate", "--policy", policy, "--db", "postgresql://postgres:postgres@127.0.0.1:1/postgres"]);
    expect([result.code, result.stderr]).toEqual([2, "samesight: cannot reach the local database at 127.0.0.1:1; start it with supabase start (or pass --db)\n"]);
  });

  it("exits 2 when it cannot find the policy, or would write over one", { timeout: 30_000 }, async () => {
    const dir = tempDir();
    const missing = await cli(["check", "--policy", join(dir, "nowhere.policy.ts")]);
    expect([missing.code, missing.stderr]).toEqual([2, `samesight: no policy file at ${join(dir, "nowhere.policy.ts")}; run samesight init, or pass --policy\n`]);
    writeFileSync(join(dir, "samesight.policy.ts"), "export default {};\n");
    const existing = await cli(["init", "--policy", join(dir, "samesight.policy.ts")]);
    expect([existing.code, existing.stderr]).toEqual([2, `samesight: ${join(dir, "samesight.policy.ts")} already exists; edit it, or remove it to start again\n`]);
  });

  it("says to generate first when there is no schema snapshot, and exits 1 on a policy that does not compile", { timeout: 30_000 }, async () => {
    // Fieldbook's policy, from a directory of its own: no snapshot beside it.
    const dir = tempDir();
    const fieldbook = new URL("../../../examples/fieldbook/samesight.policy.ts", import.meta.url).href;
    writeFileSync(join(dir, "samesight.policy.mjs"), `export { default } from ${JSON.stringify(fieldbook)};\n`);
    const policy = ["--policy", join(dir, "samesight.policy.mjs")];
    for (const command of ["check", "explain"]) {
      const result = await cli([command, ...policy]);
      expect([result.code, result.stderr]).toEqual([2, `samesight: no schema snapshot at ${join(dir, "samesight/schema.json")}; run samesight generate first\n`]);
    }
    // A snapshot with none of the policy's tables.
    mkdirSync(join(dir, "samesight"));
    writeFileSync(join(dir, "samesight/schema.json"), JSON.stringify({ tables: [] }));
    const result = await cli(["explain", ...policy]);
    expect([result.code, result.stderr]).toEqual([1, expect.stringMatching(/^samesight: the policy does not compile:\n {2}- .*Membership/)]);
  });
});

describe("samesight audit", () => {
  // An example project that installs @samesight/verify.
  const project = fileURLToPath(new URL("../../../examples/audit-roles", import.meta.url));

  it("runs samesight-verify audit from the project's install, with its exit code", { timeout: 30_000 }, async () => {
    const help = await cli(["audit", "--help"], project);
    expect([help.code, help.stdout]).toEqual([0, expect.stringContaining("samesight-verify audit [audit options]")]);
    const missing = await cli(["audit", "--sync-config", "nowhere.yaml"], project);
    expect([missing.code, missing.stderr]).toEqual([2, expect.stringMatching(/no sync config at .*nowhere\.yaml/)]);
  });

  it("says how to install @samesight/verify when it finds none, and exits 2", { timeout: 30_000 }, async () => {
    const dir = tempDir();
    const result = await cli(["audit", "--help"], dir, { PATH: "" });
    expect([result.code, result.stderr, result.stdout]).toEqual([2, `${NOT_FOUND}\n`, ""]);
    // With --json, stdout still carries one document, as samesight-verify's would.
    const json = await cli(["audit", "--json"], dir, { PATH: "" });
    expect([json.code, json.stderr]).toEqual([2, `${NOT_FOUND}\n`]);
    expect(JSON.parse(json.stdout)).toEqual({
      tool: "samesight",
      version: 1,
      mode: "audit",
      result: "incomplete",
      exitCode: 2,
      durationMs: expect.any(Number),
      sections: [],
      error: NOT_FOUND.replace(/^samesight: /, ""),
    });
  });

  it("refuses audit after a flag, which would read audit's flags as samesight's", { timeout: 30_000 }, async () => {
    const message = "samesight: audit must come first, before any flag: samesight audit [audit options]; see samesight audit --help\n";
    for (const args of [["--policy", "x.ts", "audit"], ["--", "audit"], ["--sync-config", "x.yaml", "audit"], ["--db", "x", "audit", "--json"]]) {
      const result = await cli(args);
      expect([result.code, result.stderr]).toEqual([2, message]);
    }
    // An audit that is another command's argument is that command's business, and with no
    // flag before it, an unknown command is just that.
    const lint = await cli(["lint", "audit", "--bogus"]);
    expect([lint.code, lint.stderr]).toEqual([2, "samesight: unknown option '--bogus'; see samesight --help\n"]);
    const unknown = await cli(["frob", "audit"]);
    expect([unknown.code, unknown.stderr]).toEqual([2, expect.stringMatching(/^samesight: unknown command "frob"/)]);
    // --help before audit still prints the help.
    const help = await cli(["--help", "audit"]);
    expect([help.code, help.stdout]).toEqual([0, expect.stringContaining("Usage")]);
  });
});

describe("samesight exposure", () => {
  const SYNC_CONFIG = [
    "config:",
    "  edition: 3",
    "streams:",
    "  org_members:",
    "    auto_subscribe: true",
    "    with:",
    "      my_orgs: SELECT org_id FROM members WHERE user_id = auth.user_id()",
    "    query: SELECT * FROM members WHERE org_id IN my_orgs",
    "",
  ].join("\n");
  const MIGRATION = "create table public.members (id uuid primary key, org_id uuid not null, user_id uuid not null references auth.users (id), email text not null, role text);\n";

  /** A project with the sync config, and its migrations in supabase/migrations unless told not to. */
  function project(migrations = true): string {
    const dir = tempDir();
    writeFileSync(join(dir, "sync-config.yaml"), SYNC_CONFIG);
    if (migrations) {
      mkdirSync(join(dir, "supabase/migrations"), { recursive: true });
      writeFileSync(join(dir, "supabase/migrations/1_init.sql"), MIGRATION);
    }
    return dir;
  }

  it("maps the sync config it finds, with the columns of supabase/migrations, and exits 0", { timeout: 30_000 }, async () => {
    const result = await cli(["exposure"], project());
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      [
        "members",
        "  sent by  stream org_members, query  (sync-config.yaml:8)",
        "  to       members of the row's group, through with.my_orgs",
        "  columns  id, org_id, user_id, email [contact], role  (all columns, from the migrations)",
        "",
        "1 table. 1 likely personal column reaches users other than the row's owner: members.email.",
        "Columns are matched by name or a samesight comment marker, never by their data.",
        "",
      ].join("\n"),
    );
  });

  it("says on stderr when it has no migrations to read, and still exits 0", { timeout: 30_000 }, async () => {
    const result = await cli(["exposure", "sync-config.yaml"], project(false));
    expect([result.code, result.stderr]).toEqual([
      0,
      "note: no supabase/migrations here, so the columns a SELECT * sends are not known, no column comment is read, and every table is taken to be keyed by id; pass --migrations <dir> to read them\n",
    ]);
    expect(result.stdout).toContain("  columns  all columns (no migrations read, so not known)\n");
  });

  it("prints one JSON object with --format json", { timeout: 30_000 }, async () => {
    const dir = project();
    const result = await cli(["exposure", "sync-config.yaml", "gone.yaml", "--format", "json"], dir);
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report).toEqual({
      version: 1,
      files: ["sync-config.yaml", "gone.yaml"],
      migrations: "supabase/migrations",
      maps: [{ file: "sync-config.yaml", kind: "streams", tables: [{ table: "members", queries: [expect.objectContaining({ stream: "org_members", query: "query", line: 8 })] }], unread: [] }],
      unreadable: [{ file: "gone.yaml", error: expect.stringMatching(/^ENOENT/) }],
    });
    expect(report.maps[0].tables[0].queries[0].columns.items.find((c: { name: string }) => c.name === "email").personal).toEqual({ category: "contact", matched: "email", source: "name" });
  });

  it("exits 2 when a file cannot be read, still mapping the others", { timeout: 30_000 }, async () => {
    const dir = project();
    writeFileSync(join(dir, "bad.yaml"), "streams: [1]\n");
    const result = await cli(["exposure", "sync-config.yaml", "gone.yaml", "bad.yaml"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      [
        "samesight: gone.yaml: cannot be read as a sync config: ENOENT: no such file or directory, open 'gone.yaml'; check the path, or name another file",
        "samesight: bad.yaml: cannot be read as a sync config: the sync config has no streams: section; fix the YAML, or name another file",
        "2 of 3 file(s) could not be read, so nothing in them is mapped.",
        "",
      ].join("\n"),
    );
    expect(result.stdout).toMatch(/^members\n {2}sent by {2}stream org_members, query {2}\(sync-config.yaml:8\)\n/);
    // Nothing read, nothing printed.
    const none = await cli(["exposure", "gone.yaml"], dir);
    expect([none.code, none.stdout]).toEqual([2, ""]);
  });

  it("exits 2 with no sync config, a --format it does not print, or migrations it cannot read, in lint's words", { timeout: 30_000 }, async () => {
    const empty = tempDir();
    const tried = "tried sync-config.yaml, sync-rules.yaml, powersync/sync-config.yaml, powersync/sync-rules.yaml";
    for (const command of ["exposure", "lint"]) {
      const none = await cli([command], empty);
      expect([none.code, none.stderr]).toEqual([2, `samesight: no sync config found (${tried}); name one: samesight ${command} <file>\n`]);
      const missing = await cli([command, "--migrations", "nowhere"], project());
      expect([missing.code, missing.stderr]).toEqual([2, "samesight: no migrations directory at nowhere; check the path given to --migrations\n"]);
    }
    const format = await cli(["exposure", "--format", "sarif"], project());
    expect([format.code, format.stderr]).toEqual([2, 'samesight: --format must be text or json for exposure, not "sarif"\n']);
    for (const [flag, value] of [
      ["--allow", "personal-columns"],
      ["--table", "members"],
      ["--policy", "p.ts"],
      ["--db", "postgres://localhost"],
    ]) {
      const unused = await cli(["exposure", flag as string, value as string], project());
      expect([unused.code, unused.stderr]).toEqual([2, `samesight: exposure does not take ${flag}; it takes [file ...], --migrations, --against and --format\n`]);
    }
  });
});

describe("samesight exposure --against", () => {
  const OWN = "SELECT id, name FROM lists WHERE owner_id = auth.user_id()";
  const config = (query: string) => ["config:", "  edition: 3", "streams:", "  s:", "    auto_subscribe: true", `    query: ${query}`, ""].join("\n");
  const MIGRATION = "create table lists (id uuid primary key, name text, owner_id uuid references auth.users, email text);\n";
  /** Git, and the CLI, as the tests run them: no GIT_* from the environment, no hooks, no signing. */
  const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const SETTINGS = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=.no-hooks", "-c", "user.email=test@example.com", "-c", "user.name=test"];
  const git = (cwd: string, ...args: string[]) => execFileSync("git", [...SETTINGS, ...args], { cwd, encoding: "utf8", env: ENV }).trim();
  const run = (args: string[], cwd: string) => cli(args, cwd, ENV);

  /** A repository with `files` committed on main, and its directory. */
  function repo(files: Record<string, string>): string {
    const dir = tempDir();
    git(dir, "init", "-q", "-b", "main");
    put(dir, files);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "one");
    return dir;
  }
  function put(dir: string, files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }
  const PROJECT = { "sync-config.yaml": config(OWN), "supabase/migrations/1.sql": MIGRATION };

  it("exits 0 when nothing changed, and 1 when a table reaches more users, naming it", { timeout: 30_000 }, async () => {
    const dir = repo(PROJECT);
    const same = await run(["exposure", "--against", "main"], dir);
    expect([same.code, same.stderr]).toEqual([0, ""]);
    expect(same.stdout).toContain("No change in who receives which tables and columns since main.");
    put(dir, { "sync-config.yaml": config("SELECT id, name, email FROM lists") });
    const wider = await run(["exposure", "--against", "main"], dir);
    expect(wider.code).toBe(1);
    expect(wider.stdout).toContain("lists: reaches more users");
    expect(wider.stdout).toContain("  columns added     email [contact]: to every user");
    expect(wider.stdout).toContain("1 table reaches more users, or more columns, than in main: lists.");
  });

  it("exits 0 for a change that reaches no more users", { timeout: 30_000 }, async () => {
    const dir = repo({ ...PROJECT, "sync-config.yaml": config("SELECT id, name FROM lists") });
    put(dir, { "sync-config.yaml": config(OWN) });
    const narrower = await run(["exposure", "--against", "main"], dir);
    expect(narrower.code).toBe(0);
    expect(narrower.stdout).toContain("lists: reaches fewer users");
  });

  it("prints one JSON document with the ref, its commit and widened", { timeout: 30_000 }, async () => {
    const dir = repo(PROJECT);
    put(dir, { "sync-config.yaml": config("SELECT id, name FROM lists") });
    const out = await run(["exposure", "--against", "main", "--format", "json"], dir);
    expect(out.code).toBe(1);
    const doc = JSON.parse(out.stdout);
    expect(doc).toMatchObject({ version: 1, against: { ref: "main", commit: git(dir, "rev-parse", "main") }, files: ["sync-config.yaml"], migrations: "supabase/migrations", widened: true });
    expect(doc.diffs[0].tables[0]).toMatchObject({ table: "lists", audience: { direction: "wider" } });
  });

  it("compares the migrations as the commit holds them", { timeout: 30_000 }, async () => {
    const dir = repo({ ...PROJECT, "sync-config.yaml": config("SELECT * FROM lists WHERE owner_id = auth.user_id()") });
    put(dir, { "supabase/migrations/2.sql": "alter table lists add column phone text;\n" });
    const out = await run(["exposure", "--against", "main"], dir);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("  columns added     phone [contact]: to only the row's owner (owner_id)");
  });

  it("counts a sync config the commit does not have as newly sent, and says so", { timeout: 30_000 }, async () => {
    const dir = repo({ "supabase/migrations/1.sql": MIGRATION, "README.md": "x" });
    put(dir, { "sync-config.yaml": config(OWN) });
    const out = await run(["exposure", "--against", "main"], dir);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("note: sync-config.yaml is not in main, so all it sends counts as newly sent");
    const doc = JSON.parse((await run(["exposure", "--against", "main", "--format", "json"], dir)).stdout);
    expect(doc).toMatchObject({ commitMigrations: "supabase/migrations", diffs: [{ inCommit: false }] });
    expect(out.stdout).toContain("lists: newly sent");
  });

  it("says when the commit has no migrations", { timeout: 30_000 }, async () => {
    const dir = repo({ "sync-config.yaml": config(OWN) });
    put(dir, { "supabase/migrations/1.sql": MIGRATION });
    const out = await run(["exposure", "--against", "main"], dir);
    expect(out.stderr).toContain("note: no supabase/migrations in main, so the columns a SELECT * sent there are not known");
    const doc = JSON.parse((await run(["exposure", "--against", "main", "--format", "json"], dir)).stdout);
    expect(doc).toMatchObject({ migrations: "supabase/migrations", commitMigrations: null, diffs: [{ inCommit: true }] });
  });

  it("exits 2 for a ref the repository does not have, and never reads one as an option", { timeout: 30_000 }, async () => {
    const dir = repo(PROJECT);
    const missing = await run(["exposure", "--against", "release-9"], dir);
    expect([missing.code, missing.stdout]).toEqual([2, ""]);
    expect(missing.stderr).toBe("samesight: no commit release-9 in this repository; in a shallow clone, fetch it first (git fetch origin release-9:release-9)\n");
    const option = await run(["exposure", `--against=--output=${join(dir, "written")}`], dir);
    expect([option.code, option.stderr]).toEqual([2, `samesight: --against takes a branch, a tag or a commit id, which cannot start with "-": ${JSON.stringify(`--output=${join(dir, "written")}`)}\n`]);
    expect(existsSync(join(dir, "written"))).toBe(false);
  });

  it("exits 2 for a sync config the commit holds but cannot be read, naming it so", { timeout: 30_000 }, async () => {
    const dir = repo({ ...PROJECT, "sync-config.yaml": "streams: [unclosed" });
    put(dir, { "sync-config.yaml": config(OWN) });
    const out = await run(["exposure", "--against", "main"], dir);
    expect(out.code).toBe(2);
    // The error on one line: the commit's own lines are not printed under it.
    expect(out.stderr).toMatch(/^samesight: sync-config.yaml as main holds it: cannot be read as a sync config: [^\n]+\n1 of 1 file\(s\) could not be read/);
  });

  it("is refused by every command but exposure, with lint's JSON document under --format json", { timeout: 30_000 }, async () => {
    const out = await cli(["lint", "--against", "main"]);
    expect([out.code, out.stderr]).toEqual([2, "samesight: --against is for samesight exposure only\n"]);
    const json = await cli(["lint", "--against", "main", "--format", "json"]);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({ error: "--against is for samesight exposure only" });
  });

  it("compares with an earlier commit, not the one checked out", { timeout: 30_000 }, async () => {
    const dir = repo({ ...PROJECT, "sync-config.yaml": config("SELECT id FROM lists WHERE owner_id = auth.user_id()") });
    git(dir, "checkout", "-q", "-b", "feature");
    put(dir, { "sync-config.yaml": config(OWN) });
    git(dir, "commit", "-q", "-am", "name too");
    put(dir, { "sync-config.yaml": config("SELECT id, name FROM lists") });
    git(dir, "commit", "-q", "-am", "everyone");
    const vsMain = await run(["exposure", "--against", "main"], dir);
    expect(vsMain.code).toBe(1);
    expect(vsMain.stdout).toContain("  columns added     name: to every user");
    expect(vsMain.stdout).toContain("lists: reaches more users");
    const vsParent = await run(["exposure", "--against", "HEAD~1"], dir);
    expect(vsParent.stdout).not.toContain("columns added");
    expect(vsParent.stdout).toContain("  columns wider     id, name");
    const vsHead = await run(["exposure", "--against", "HEAD"], dir);
    expect([vsHead.code, vsHead.stdout]).toEqual([0, expect.stringContaining("No change")]);
  });

  it("reads --migrations from the commit too", { timeout: 30_000 }, async () => {
    const dir = repo({ "sync-config.yaml": config("SELECT * FROM lists WHERE owner_id = auth.user_id()"), "db/migrations/1.sql": MIGRATION });
    put(dir, { "db/migrations/2.sql": "alter table lists add column phone text;\n" });
    const out = await run(["exposure", "--migrations", "db/migrations", "--against", "main"], dir);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("  columns added     phone [contact]: to only the row's owner (owner_id)");
    const json = JSON.parse((await run(["exposure", "--migrations", "db/migrations", "--against", "main", "--format", "json"], dir)).stdout);
    expect(json).toMatchObject({ migrations: "db/migrations", commitMigrations: "db/migrations", diffs: [{ inCommit: true }] });
  });

  it("exits 1 for a new query that cannot be read alone, which may send anything", { timeout: 30_000 }, async () => {
    const dir = repo(PROJECT);
    put(dir, { "sync-config.yaml": `${config(OWN)}  t:\n    auto_subscribe: true\n    query: SELECT id FROM notes WHERE owner_id = auth.user_id() UNION SELECT id FROM notes\n` });
    const out = await run(["exposure", "--against", "main"], dir);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("No table is known to reach more users than in main, but: 1 query that cannot be read is new since main, and may send anything.");
  });

  it("says a table may send more, not that it does, when its columns are no longer known", { timeout: 30_000 }, async () => {
    const dir = repo({ ...PROJECT, "sync-config.yaml": config("SELECT * FROM lists WHERE owner_id = auth.user_id()") });
    put(dir, { "supabase/migrations/1.sql": "create table other (id uuid primary key);\n" });
    const out = await run(["exposure", "--against", "main"], dir);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("lists: may send more");
    expect(out.stdout).toContain("1 table may send more, since not all its columns are known now: lists.");
    expect(out.stdout).not.toContain("reach more users, or more columns");
  });

  it("exits 2 with the JSON's unreadable list when the commit holds a directory where the file is", { timeout: 30_000 }, async () => {
    const dir = repo({ "supabase/migrations/1.sql": MIGRATION, "sync-config.yaml/x": "a directory then" });
    rmSync(join(dir, "sync-config.yaml"), { recursive: true });
    put(dir, { "sync-config.yaml": config(OWN) });
    const out = await run(["exposure", "--against", "main", "--format", "json"], dir);
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout).unreadable).toEqual([{ file: "sync-config.yaml as main holds it", error: "sync-config.yaml is a directory in main, not a sync config" }]);
    expect(out.stderr).toBe("samesight: sync-config.yaml as main holds it: sync-config.yaml is a directory in main, not a sync config\n");
    const text = await run(["exposure", "--against", "main"], dir);
    expect(text.code).toBe(2);
    expect(text.stderr).toContain("1 of 1 file(s) could not be read on one side or both, so nothing in them is compared.");
  });

  it("names a table that could pose as a line of its own in quotes, on one line", { timeout: 30_000 }, async () => {
    const dir = repo(PROJECT);
    put(dir, { "sync-config.yaml": `${config(OWN)}  x:\n    auto_subscribe: true\n    query: "SELECT id FROM \\"::error::forged\\n\\nNo change.\\""\n` });
    const out = await run(["exposure", "--against", "main"], dir);
    expect(out.stdout).toContain('"::error::forged\\n\\nNo change.": newly sent');
    expect(out.stdout.split("\n").some((l) => l.startsWith("::"))).toBe(false);
  });

  it("exits 2 outside a git repository", { timeout: 30_000 }, async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "sync-config.yaml"), config(OWN));
    const out = await cli(["exposure", "--against", "main"], dir, { ...ENV, GIT_CEILING_DIRECTORIES: dirname(dir) });
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/^samesight: not in a git repository; --against compares with a commit of the repository the command runs in$/m);
  });
});

/** Runs the CLI with `input` on stdin, as an agent's hook does; resolves with its exit code, stderr and stdout. */
const piped = (args: string[], input: string, env: NodeJS.ProcessEnv = process.env) =>
  new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });

describe("samesight agent hook", () => {
  it("reads a Claude Code payload on stdin: exit 2 with the findings on stderr for a leak, nothing for another file", { timeout: 30_000 }, async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "sync-config.yaml"), "config:\n  edition: 3\nstreams:\n  all:\n    auto_subscribe: true\n    query: SELECT * FROM customers\n");
    const payload = (file: string) => JSON.stringify({ session_id: "s", transcript_path: "/t.jsonl", cwd: dir, permission_mode: "default", hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: join(dir, file), content: "x" }, tool_response: { filePath: join(dir, file), success: true } });
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    const leak = await piped(["agent", "hook"], payload("sync-config.yaml"), env);
    expect([leak.code, leak.stdout]).toEqual([2, ""]);
    expect(leak.stderr).toMatch(/^samesight lint found 1 error after this edit:\nsync-config\.yaml:6:12 {2}error {2}unscoped-query /);
    expect(await piped(["agent", "hook"], payload("notes.md"), env)).toEqual({ code: 0, stdout: "", stderr: "" });
    const accepted = await piped(["agent", "hook", "--allow", "unscoped-query"], payload("sync-config.yaml"), env);
    expect([accepted.code, JSON.parse(accepted.stdout).hookSpecificOutput.additionalContext]).toEqual([0, expect.stringMatching(/^samesight lint: no findings in sync-config\.yaml\./)]);
  });

  it("takes only init or hook, and notes options the hook does not take", { timeout: 30_000 }, async () => {
    const none = await cli(["agent"]);
    expect([none.code, none.stderr]).toEqual([2, expect.stringMatching(/^samesight: agent takes init or hook: samesight agent init \[file \.\.\.\] .*, or samesight agent hook \[file \.\.\.\] /)]);
    expect((await cli(["agent", "frob"])).stderr).toMatch(/^samesight: agent takes init or hook, not "frob": /);
    // The hook never stops an agent on its own arguments: a note to the user, exit 0.
    for (const args of [["--format", "json"], ["--frob"], ["--migrations"]]) {
      const r = await piped(["agent", "hook", ...args], "{}");
      expect([r.code, r.stdout], args.join(" ")).toEqual([0, ""]);
      expect(r.stderr, args.join(" ")).toMatch(/^samesight agent hook: (it does not take --\w+|--migrations and --allow each take a value); nothing checked\./);
    }
    const help = await cli(["agent", "hook", "--help"]);
    expect([help.code, help.stdout]).toEqual([0, expect.stringMatching(/^Usage: samesight agent hook \[file \.\.\.\] /)]);
    const late = await cli(["--allow", "rls-off", "agent", "hook"]);
    expect([late.code, late.stderr]).toEqual([2, expect.stringMatching(/^samesight: agent hook must come first, before any flag: /)]);
  });

  it("says when a payload is over 5 MB, rather than that there is none", { timeout: 30_000 }, async () => {
    const r = await piped(["agent", "hook"], JSON.stringify({ tool_input: { content: "x".repeat(5_100_000) } }));
    expect(r).toEqual({ code: 0, stdout: "", stderr: "samesight agent hook: the hook payload on stdin is over 5 MB; nothing checked\n" });
  });
});

describe("samesight agent init", () => {
  it("installs from the command line, with --print and --agents, and refuses what it cannot do", { timeout: 30_000 }, async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "sync-config.yaml"), "config:\n  edition: 3\nstreams:\n  all:\n    auto_subscribe: true\n    query: SELECT * FROM customers WHERE owner_id = auth.user_id()\n");
    const print = await cli(["agent", "init", "--print", "--agents", "claude"], dir);
    expect([print.code, print.stdout.split("\n")[0]]).toEqual([0, ".claude/skills/samesight: would create (10 files)"]);
    const made = await cli(["agent", "init", "--agents", "codex,codex"], dir);
    expect([made.code, made.stdout.split("\n").slice(0, 2)]).toEqual([0, [".agents/skills/samesight: created (10 files)", ".codex/hooks.json: created, with the samesight hook"]]);
    const agents = await cli(["agent", "init", "--agents", "claude,vim"], dir);
    expect([agents.code, agents.stderr]).toEqual([2, "samesight: --agents takes claude, codex, cursor, comma-separated, not vim\n"]);
    const allow = await cli(["agent", "init", "--allow", "nope"], dir);
    expect([allow.code, allow.stderr]).toEqual([2, expect.stringMatching(/^samesight: --allow names no rule nope; the rules are /)]);
    const injected = await cli(["agent", "init", "--allow", "rls-off:$(id)"], dir);
    expect([injected.code, injected.stdout]).toEqual([2, expect.stringMatching(/^not writing anything: the hook command would carry "rls-off:\$\(id\)"/)]);
  });

  it("is the only command that takes --print and --agents", { timeout: 30_000 }, async () => {
    for (const args of [["generate", "--print"], ["init", "--print"], ["exposure", "--agents", "claude"], ["lint", "--print"]]) {
      const r = await cli(args);
      expect([r.code, r.stderr], args.join(" ")).toEqual([2, `samesight: --${args[1]?.slice(2)} is for samesight agent init only\n`]);
    }
    const json = await cli(["lint", "--format", "json", "--print"]);
    expect([json.code, JSON.parse(json.stdout).error]).toEqual([2, "--print is for samesight agent init only"]);
  });
});
