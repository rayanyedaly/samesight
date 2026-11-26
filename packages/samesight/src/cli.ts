#!/usr/bin/env node
/**
 * samesight init | generate | check | doctor | explain | lint | exposure | agent init | agent hook | audit
 *
 * Runs on Node's built-in TypeScript support (type stripping), so a policy file is
 * imported as written. Paths in the policy's `output` are relative to the policy file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { agentHook } from "./agent/hook.ts";
import { AGENTS, type Agent, agentInit } from "./agent/init.ts";
import { doctor, type Finding } from "./doctor.ts";
import { explainPolicy } from "./explain.ts";
import { diffExposure } from "./exposure/diff.ts";
import { type DiffedConfig, exposureDiffJson, formatExposureDiff } from "./exposure/diff-format.ts";
import { exposureJson, formatExposure, type MappedConfig } from "./exposure/format.ts";
import { type Commit, fileAt, GitError, migrationsAt, resolveCommit } from "./exposure/git.ts";
import { type ExposureMap, exposureMap, type Schema } from "./exposure/map.ts";
import { named, safe } from "./exposure/text.ts";
import { forwardAudit } from "./forward.ts";
import { outputPaths, plan } from "./generate.ts";
import { draftPolicy, findMembership, roleValues } from "./init.ts";
import { introspect, projectDbUrl, withLocalClient } from "./introspect.ts";
import { buildIR, CompileError } from "./ir.ts";
import { formatLint, type Unreadable } from "./lint/finding.ts";
import { formatGithub } from "./lint/github.ts";
import { lintDocument } from "./lint/json.ts";
import { lineFinder, MIGRATIONS_DIR, RULE_NAMES } from "./lint/lint.ts";
import { cannotRead, migrationsIn, runLint, syncConfigs, unknownRules } from "./lint/run.ts";
import { formatSarif } from "./lint/sarif.ts";
import { loadPolicy, POLICY_FILES, resolvePolicyPath, tsIsModule } from "./load.ts";
import type { Policy } from "./policy.ts";
import type { SchemaInfo } from "./schema.ts";
import { checkAuthConfig, readSupabaseConfig } from "./supabase-config.ts";
import { parseSyncConfig } from "./sync/config.ts";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const USAGE = `Usage: samesight <command> [options]

Commands:
  init       draft samesight.policy.ts from the local database (a template without one)
  generate   read the local database, write the migration, sync config and client files
  check      regenerate from the saved schema snapshot and fail if anything on disk differs
  doctor     check the local database against the policy (RLS, publication, hook, replication lag)
  explain    print who can read and write what, in plain words, from the saved schema snapshot
  lint [file ...]
             check PowerSync sync configs for known leak patterns, reading the files only
             (default: sync-config.yaml or sync-rules.yaml, here or under powersync/)
  exposure [file ...]
             print who receives which columns of which tables, marking the ones whose
             name or comment looks personal; reads the files only (default: as lint);
             with --against <ref>, what the change since that git commit does to it
  agent init [file ...]
             install the samesight skill for coding agents and the hook that lints after
             each edit to a sync config or migration (.claude/, .agents/, .cursor/, .codex/);
             never removes a file or changes a setting of yours; --print shows what it
             would write
  agent hook [file ...]
             the post-edit hook agent init installs: reads the hook's JSON on stdin and,
             when the edit touched a sync config or a migration, lints the sync configs;
             exit 2 with the findings on stderr when one is an error or a sync config
             cannot be read
  audit [options]
             run samesight-verify audit: the project's own RLS against its sync config, on
             the local stack; needs @samesight/verify, and takes its flags (audit --help)

Options:
  --policy <file>   policy file (default: samesight.policy.ts, or samesight.policy.mts)
  --db <url>        local database URL (default: $SAMESIGHT_DB_URL, else the [db] port in
                    supabase/config.toml, else 54322)
  --table <name>    explain: one table only
  --migrations <dir>
                    lint, exposure and agent init/hook: the SQL migrations to read tables,
                    keys, column comments and (lint) RLS from (default: supabase/migrations)
  --against <ref>   exposure: compare with the sync configs and migrations as that git commit
                    (a branch, a tag, a commit id) holds them; exit 1 when something reaches
                    more users than there, or may (a query or columns no longer read)
  --allow <rule>[:<name>]
                    lint and agent init/hook: accept a rule's findings, all of them or those
                    about one stream, bucket, table or policy; repeatable
  --format <text|json|sarif|github>
                    lint: text (default), one JSON object, one SARIF 2.1.0 log, or GitHub
                    Actions annotations, on stdout; notes on stderr; exposure: text
                    (default) or one JSON object
  --agents <list>   agent init: claude, codex, cursor, comma-separated (default: all three)
  --print           agent init: say what it would write, and write nothing
  -v, --version     print the version
  -h, --help        print this help

Docs: https://rayanyedaly.github.io/samesight/
`;

async function main(argv: string[]): Promise<number> {
  // Its flags are samesight-verify's, so they are not read here.
  if (argv[0] === "audit") return forwardAudit(argv.slice(1));
  // The hook runs after every edit an agent makes: a problem of its own must not stop the agent.
  if (argv[0] === "agent" && argv[1] === "hook") return agentHookLine(argv.slice(2));
  if (auditAfterFlags(argv)) {
    console.error("samesight: audit must come first, before any flag: samesight audit [audit options]; see samesight audit --help");
    return 2;
  }
  const { positionals, values } = (() => {
    try {
      return flags(argv);
    } catch (e) {
      // A JSON run gets its document even when its flags are wrong.
      if (lintJsonRun(argv)) printLintError(e);
      throw e;
    }
  })();
  const command = positionals[0];
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 2;
  }
  // Lint and exposure need no policy: they are for any PowerSync project.
  // Only agent init takes these: init or generate given --print would write files all the same.
  const initOnly = (["agents", "print"] as const).find((o) => values[o] !== undefined);
  if (initOnly && !(command === "agent" && positionals[1] === "init")) {
    const message = `--${initOnly} is for samesight agent init only`;
    if (command === "lint" && values.format === "json") printLintError(new Error(message));
    console.error(`samesight: ${message}`);
    return 2;
  }
  if (values.against !== undefined && command !== "exposure") {
    const message = "--against is for samesight exposure only";
    if (command === "lint" && values.format === "json") printLintError(new Error(message));
    console.error(`samesight: ${message}`);
    return 2;
  }
  if (command === "lint") return lint(positionals.slice(1), values.migrations, values.allow ?? [], values.format ?? "text");
  if (command === "agent") return agent(positionals.slice(1), values);
  if (command === "exposure") {
    // Accepting an option it does not use would look like it worked.
    const unused = (["allow", "policy", "db", "table"] as const).find((o) => values[o] !== undefined);
    if (unused) {
      console.error(`samesight: exposure does not take --${unused}; it takes [file ...], --migrations, --against and --format`);
      return 2;
    }
    return exposure(positionals.slice(1), values.migrations, values.format ?? "text", values.against);
  }
  const policyPath = resolvePolicyPath(values.policy);
  const root = dirname(policyPath);
  const db = values.db ?? process.env.SAMESIGHT_DB_URL ?? projectDbUrl(root);

  switch (command) {
    case "init":
      return init(values.policy, db);
    case "explain": {
      const policy = await loadPolicy(policyPath);
      const snapshot = join(root, outputPaths(policy).schemaSnapshot);
      if (!existsSync(snapshot)) {
        console.error(`samesight: no schema snapshot at ${snapshot}; run samesight generate first`);
        return 2;
      }
      const ir = buildIR(policy, JSON.parse(readFileSync(snapshot, "utf8")) as SchemaInfo);
      process.stdout.write(explainPolicy(ir, values.table));
      return 0;
    }
    case "generate": {
      const policy = await loadPolicy(policyPath);
      const schema = await introspect(db);
      return generate(policy, schema, root);
    }
    case "check": {
      const policy = await loadPolicy(policyPath);
      const snapshot = join(root, outputPaths(policy).schemaSnapshot);
      if (!existsSync(snapshot)) {
        console.error(`samesight: no schema snapshot at ${snapshot}; run samesight generate first`);
        return 2;
      }
      return check(policy, JSON.parse(readFileSync(snapshot, "utf8")) as SchemaInfo, root);
    }
    case "doctor": {
      const policy = await loadPolicy(policyPath);
      const schema = await introspect(db);
      const p = plan(policy, schema, root);
      const latest = p.migration.latest;
      const file = latest?.path.split("/").at(-1);
      const version = file ? file.slice(0, file.indexOf("_")) : null;
      const findings = await doctor(db, buildIR(policy, schema), version);
      // Drift that `check` cannot see without a database.
      const snapshotPath = outputPaths(policy).schemaSnapshot;
      const snapshot = join(root, snapshotPath);
      const saved = existsSync(snapshot) ? readFileSync(snapshot, "utf8") : null;
      const drift: Finding[] = [
        saved === p.files.get(snapshotPath)
          ? { status: "ok", check: "schema", detail: "the database matches the snapshot generate saved" }
          : { status: "fail", check: "schema", detail: `the database differs from ${snapshotPath}; run samesight generate` },
      ];
      // With no generated migration, doctor() already fails the migration check.
      if (latest) {
        drift.push(
          latest.content === p.migration.content
            ? { status: "ok", check: "policy", detail: "the latest generated migration matches the policy" }
            : { status: "fail", check: "policy", detail: `${latest.path} is not what the policy generates; run samesight generate` },
        );
      }
      findings.unshift(...drift);
      findings.push(...checkAuthConfig(readSupabaseConfig(root)));
      const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
      for (const f of findings) console.log(`${mark[f.status]}  ${f.check}: ${f.detail}`);
      return findings.some((f) => f.status === "fail") ? 1 : 0;
    }
    default:
      console.error(`samesight: unknown command "${command}"; the commands are ${COMMANDS.join(", ")}; see samesight --help`);
      return 2;
  }
}

const COMMANDS = ["init", "generate", "check", "doctor", "explain", "lint", "exposure", "agent", "audit"];

/**
 * The flags, read strictly. A flag Node cannot read is reported in its own words, with
 * where to look: "unknown option '--x'; see samesight --help".
 */
function flags(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    throw flagError(e, "samesight --help");
  }
}

const OPTIONS = {
  policy: { type: "string" },
  db: { type: "string" },
  table: { type: "string" },
  migrations: { type: "string" },
  against: { type: "string" },
  allow: { type: "string", multiple: true },
  format: { type: "string" },
  agents: { type: "string" },
  print: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

/**
 * Audit given after a flag (`samesight --sync-config x.yaml audit`): it runs only when it
 * comes first, since after a flag its flags would be read as samesight's. Read loosely, so
 * an audit flag samesight does not know still gets this answer, not "unknown option".
 */
function auditAfterFlags(argv: string[]): boolean {
  const at = argv.indexOf("audit");
  if (at < 0 || !argv.slice(0, at).some((a) => a.startsWith("-"))) return false;
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, strict: false, options: OPTIONS });
  // --help and --version answer as they do anywhere.
  if (values.help || values.version) return false;
  const first = positionals.findIndex((p) => p === "audit" || COMMANDS.includes(p));
  return first >= 0 && positionals[first] === "audit";
}

/** Node's message for a flag parseArgs refuses, without its hint about '--', and the help to see. */
function flagError(e: unknown, help: string): unknown {
  if (!(e instanceof Error) || !(e as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS_")) return e;
  const message = e.message.replace(/\. To specify a positional argument[\s\S]*$/, "");
  return new Error(`${message.charAt(0).toLowerCase()}${message.slice(1)}; see ${help}`);
}

const FORMATS = ["text", "json", "sarif", "github"];

/** Whether the arguments ask for lint's JSON, read loosely: a run whose flags are wrong still gets its document. */
function lintJsonRun(argv: string[]): boolean {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, strict: false, options: OPTIONS });
  return positionals[0] === "lint" && values.format === "json";
}

/** Lint's JSON document for a run that could not start, on stdout; the message itself still goes to stderr. */
function printLintError(e: unknown): void {
  console.log(JSON.stringify(lintDocument(VERSION, { error: e instanceof Error ? e.message : String(e) }), null, 2));
}

/** Exit 0 clean (or warnings only), 1 on an error finding, 2 when a file cannot be read; in every format. */
function lint(given: string[], migrationsDir: string | undefined, allow: string[], format: string): number {
  if (!FORMATS.includes(format)) {
    console.error(`samesight: --format must be text, json, sarif or github, not "${format}"`);
    return 2;
  }
  const unknown = unknownRules(allow);
  if (unknown.length) {
    const message = `--allow names no rule ${unknown.join(", ")}; the rules are ${RULE_NAMES.join(", ")}`;
    if (format === "json") printLintError(new Error(message));
    console.error(`samesight: ${message}`);
    return 2;
  }
  const run = (() => {
    try {
      return runLint({ given, migrationsDir, allow, cwd: process.cwd() });
    } catch (e) {
      if (format === "json") printLintError(e);
      throw e;
    }
  })();
  if (!run.rlsChecked) console.error(`note: no ${MIGRATIONS_DIR} here, so the RLS rules (rls-off, rls-open) did not run, and personal-columns saw only the columns queries list (not those a SELECT * sends), no column comments, and every table as keyed by id; pass --migrations <dir> to check them`);
  for (const m of run.messages) console.error(m);
  const { files: found, kept, allowed, unreadable, code } = run;
  if (format === "json") {
    console.log(JSON.stringify(lintDocument(VERSION, run), null, 2));
    return code;
  }
  if (format === "sarif") {
    console.log(JSON.stringify(formatSarif({ kept, allowed, unreadable }, VERSION), null, 2));
    return code;
  }
  if (format === "github") {
    const out = formatGithub({ kept, allowed, unreadable });
    if (out) console.log(out);
    return code;
  }
  // "No problems found" would be false for a file that was never checked.
  if (kept.length || !unreadable.length) console.log(formatLint(kept));
  if (allowed.length) console.log(`${allowed.length} finding${allowed.length === 1 ? "" : "s"} allowed by --allow`);
  if (unreadable.length) console.error(`${unreadable.length} of ${found.length} file(s) could not be read, so nothing in them was checked.`);
  return code;
}

/**
 * Exit 0 whatever the map shows, since it informs and never fails; 2 when a file cannot be
 * read. Text or JSON on stdout, notes on stderr. With `against`, what changed since that
 * commit: exit 1 when something reaches more users, or may.
 */
function exposure(given: string[], migrationsDir: string | undefined, format: string, against?: string): number {
  if (format !== "text" && format !== "json") {
    console.error(`samesight: --format must be text or json for exposure, not "${format}"`);
    return 2;
  }
  const found = syncConfigs(given, "exposure", process.cwd());
  const read = migrationsIn(migrationsDir, process.cwd());
  if (!read) console.error(`note: no ${MIGRATIONS_DIR} here, so the columns a SELECT * sends are not known, no column comment is read, and every table is taken to be keyed by id; pass --migrations <dir> to read them`);
  const schema = read && ((table: string) => read.migrations.tables.get(table));
  if (against !== undefined) return exposureAgainst(found, { given: migrationsDir, read }, schema, format, against);
  const mapped: MappedConfig[] = [];
  const unreadable: Unreadable[] = [];
  for (const file of found) {
    try {
      const text = readFileSync(file, "utf8");
      mapped.push({ file, map: exposureMap(parseSyncConfig(text), schema), lineOf: lineFinder(text) });
    } catch (e) {
      const bad = cannotRead(file, e);
      console.error(bad.message);
      unreadable.push(bad.unreadable);
    }
  }
  if (format === "json") {
    console.log(JSON.stringify(exposureJson(mapped, { files: found, migrations: read?.dir ?? null, unreadable }), null, 2));
  } else {
    if (mapped.length) console.log(formatExposure(mapped, { migrations: read !== undefined }));
    if (unreadable.length) console.error(`${unreadable.length} of ${found.length} file(s) could not be read, so nothing in them is mapped.`);
  }
  return unreadable.length ? 2 : 0;
}

/**
 * `samesight exposure --against <ref>`: each sync config as `ref` holds it against the file on
 * disk, with the migrations under each. Exit 1 when something reaches more users than in
 * `ref`, or may (`widened`), 2 when a file or the commit cannot be read, else 0.
 */
function exposureAgainst(
  found: string[],
  migrations: { given: string | undefined; read: ReturnType<typeof migrationsIn> },
  schema: Schema | undefined,
  format: string,
  ref: string,
): number {
  const cwd = process.cwd();
  let commit: Commit;
  let before: Schema | undefined;
  let commitMigrations: string | null = null;
  const dir = migrations.given ?? MIGRATIONS_DIR;
  try {
    commit = resolveCommit(ref, cwd);
    const was = migrationsAt(commit, dir);
    if (was === "submodule") console.error(`note: ${named(dir)} is a submodule in ${named(ref)}, whose files another repository holds, so the columns a SELECT * sent there are not known`);
    // No migrations here and none named: the note above already says so for both sides.
    else if (!was && (migrations.read || migrations.given)) console.error(`note: no ${named(dir)} in ${named(ref)}, so the columns a SELECT * sent there are not known`);
    else if (was) {
      before = (table: string) => was.tables.get(table);
      commitMigrations = dir;
    }
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    console.error(`samesight: ${safe(e.message)}`);
    return 2;
  }
  // Errors about either side are said on one line: in CI the files on disk are the pull
  // request's, and a line of a file printed under an error could pose as a runner's command.
  const oneLine = (file: string, e: unknown) => {
    const fix = (e as NodeJS.ErrnoException).syscall ? "; check the path, or name another file" : "";
    const error = `cannot be read as a sync config: ${(e as Error).message.split("\n")[0] ?? ""}${fix}`;
    console.error(`samesight: ${named(file)}: ${safe(error)}`);
    return { file, error };
  };
  const diffed: DiffedConfig[] = [];
  const unreadable: Unreadable[] = [];
  for (const file of found) {
    let text: string;
    let after: ExposureMap;
    try {
      text = readFileSync(file, "utf8");
      after = exposureMap(parseSyncConfig(text), schema);
    } catch (e) {
      unreadable.push(oneLine(file, e));
      continue;
    }
    let was: ExposureMap;
    let old: string | undefined;
    try {
      old = fileAt(commit, file);
      if (old === undefined) console.error(`note: ${named(file)} is not in ${named(ref)}, so all it sends counts as newly sent`);
      was = old === undefined ? { kind: after.kind, tables: [], unread: [] } : exposureMap(parseSyncConfig(old), before);
    } catch (e) {
      // The commit's file is not the one on disk the user can open: its error is said on one
      // line, quoted, rather than with lines of the file under it.
      const at = `${file} as ${ref} holds it`;
      const error = e instanceof GitError ? e.message : `cannot be read as a sync config: ${(e as Error).message.split("\n")[0] ?? ""}`;
      console.error(`samesight: ${named(file)} as ${named(ref)} holds it: ${safe(error)}`);
      unreadable.push({ file: at, error });
      continue;
    }
    diffed.push({ file, diff: diffExposure(was, after), after, lineOf: lineFinder(text), inCommit: old !== undefined });
  }
  if (format === "json") {
    console.log(JSON.stringify(exposureDiffJson(diffed, { ref, commit: commit.sha, files: found, migrations: migrations.read?.dir ?? null, commitMigrations, unreadable }), null, 2));
  } else {
    if (diffed.length) console.log(formatExposureDiff(diffed, ref));
    if (unreadable.length) console.error(`${unreadable.length} of ${found.length} file(s) could not be read on one side or both, so nothing in them is compared.`);
  }
  if (unreadable.length) return 2;
  return diffed.some((d) => d.diff.widened) ? 1 : 0;
}

const AGENT_USAGE = "samesight agent init [file ...] [--migrations <dir>] [--allow <rule>[:<name>]] [--agents claude,codex,cursor] [--print], or samesight agent hook [file ...] [--migrations <dir>] [--allow <rule>[:<name>]]";

/**
 * `samesight agent init`: installs the skill and the post-edit hook. `samesight agent hook`:
 * the post-edit hook an agent runs, with its JSON on stdin.
 */
async function agent(args: string[], values: ReturnType<typeof flags>["values"]): Promise<number> {
  const [sub, ...given] = args;
  if (sub === "init") return agentInitCommand(given, values);
  if (sub !== "hook") {
    console.error(`samesight: agent takes init or hook${sub ? `, not "${sub}"` : ""}: ${AGENT_USAGE}`);
    return 2;
  }
  // Main runs `agent hook` before any flag is read; here a flag came first.
  console.error("samesight: agent hook must come first, before any flag: samesight agent hook [file ...] [--migrations <dir>] [--allow <rule>[:<name>]]");
  return 2;
}

/**
 * `samesight agent hook`, its arguments read loosely: an option it does not take, or one with
 * no value, is a note to the user and exit 0, never an error the agent is stopped by after
 * every edit (a hook command written by a later samesight, say).
 */
async function agentHookLine(argv: string[]): Promise<number> {
  const { positionals: given, values, tokens } = parseArgs({ args: argv, allowPositionals: true, strict: false, tokens: true, options: { migrations: { type: "string" }, allow: { type: "string", multiple: true } } });
  if (tokens.some((t) => t.kind === "option" && (t.name === "help" || t.name === "h"))) {
    process.stdout.write("Usage: samesight agent hook [file ...] [--migrations <dir>] [--allow <rule>[:<name>]]\nRun by an agent's post-edit hook, with the hook's JSON on stdin; samesight agent init installs it.\n");
    return 0;
  }
  const other = tokens.filter((t) => t.kind === "option" && t.name !== "migrations" && t.name !== "allow").map((t) => (t.kind === "option" ? t.rawName : ""));
  const migrations = values.migrations;
  const allow = values.allow ?? [];
  if (other.length || typeof migrations === "boolean" || !Array.isArray(allow) || allow.some((a) => typeof a !== "string")) {
    process.stderr.write(`samesight agent hook: ${other.length ? `it does not take ${other.join(", ")}` : "--migrations and --allow each take a value"}; nothing checked. It takes [file ...], --migrations <dir> and --allow <rule>[:<name>]\n`);
    return 0;
  }
  const input = await readStdin();
  if (input === undefined) {
    process.stderr.write("samesight agent hook: the hook payload on stdin is over 5 MB; nothing checked\n");
    return 0;
  }
  const result = agentHook(input, { given, migrationsDir: migrations, allow: allow as string[] }, { projectDir: process.env.CLAUDE_PROJECT_DIR, cwd: process.cwd(), win32: process.platform === "win32" });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.code;
}

function agentInitCommand(given: string[], values: ReturnType<typeof flags>["values"]): number {
  const unused = (["policy", "db", "table", "format"] as const).find((o) => values[o] !== undefined);
  if (unused) {
    console.error(`samesight: agent init does not take --${unused}; it takes [file ...], --migrations, --allow, --agents and --print`);
    return 2;
  }
  const agents = (values.agents ?? AGENTS.join(",")).split(",").map((a) => a.trim()).filter(Boolean);
  const unknownAgent = agents.filter((a) => !(AGENTS as readonly string[]).includes(a));
  if (unknownAgent.length || !agents.length) {
    console.error(`samesight: --agents takes ${AGENTS.join(", ")}, comma-separated${unknownAgent.length ? `, not ${unknownAgent.join(", ")}` : ""}`);
    return 2;
  }
  const allow = values.allow ?? [];
  const unknown = unknownRules(allow);
  if (unknown.length) {
    console.error(`samesight: --allow names no rule ${unknown.join(", ")}; the rules are ${RULE_NAMES.join(", ")}`);
    return 2;
  }
  const result = agentInit({ root: process.cwd(), agents: [...new Set(agents)] as Agent[], given, migrationsDir: values.migrations, allow, print: values.print ?? false });
  for (const line of result.lines) console.log(line);
  return result.code;
}

/** All of stdin, read for up to 5 seconds; empty from a terminal, where no hook payload comes; undefined when over 5 MB. */
async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  const read = new Promise<void>((done) => {
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 5_000_000) chunks.push(chunk);
    });
    process.stdin.on("end", done);
    process.stdin.on("error", () => done());
  });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([read, new Promise<void>((done) => (timer = setTimeout(done, 5_000)))]);
  clearTimeout(timer);
  process.stdin.pause();
  return size > 5_000_000 ? undefined : Buffer.concat(chunks).toString("utf8");
}

function generate(policy: Policy, schema: SchemaInfo, root: string): number {
  const p = plan(policy, schema, root);
  let written = 0;
  const write = (rel: string, content: string) => {
    const abs = join(root, rel);
    if (existsSync(abs) && readFileSync(abs, "utf8") === content) return;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    console.log(`wrote ${rel}`);
    written++;
  };
  for (const [rel, content] of p.files) write(rel, content);
  if (p.migration.latest?.content === p.migration.content) console.log(`${p.migration.latest.path} is current`);
  else write(p.migration.next, p.migration.content);
  for (const w of p.warnings) console.warn(`warning: ${w}`);
  console.log(written ? `${written} file(s) written.` : "Everything is up to date.");
  return 0;
}

function check(policy: Policy, schema: SchemaInfo, root: string): number {
  const p = plan(policy, schema, root);
  const stale: string[] = [];
  for (const [rel, content] of p.files) {
    const abs = join(root, rel);
    if (!existsSync(abs)) stale.push(`${rel} is missing`);
    else if (readFileSync(abs, "utf8") !== content) stale.push(`${rel} differs from the policy`);
  }
  if (!p.migration.latest) stale.push("no generated migration");
  else if (p.migration.latest.content !== p.migration.content) stale.push(`${p.migration.latest.path} differs from the policy`);
  for (const w of p.warnings) console.warn(`warning: ${w}`);
  if (stale.length) {
    for (const s of stale) console.error(`stale: ${s}`);
    console.error("Run `samesight generate` and commit the result.");
    return 1;
  }
  console.log("Generated files match the policy.");
  return 0;
}

async function init(given: string | undefined, db: string): Promise<number> {
  const cwd = process.cwd();
  const existing = given === undefined ? POLICY_FILES.map((f) => join(cwd, f)).find((p) => existsSync(p)) : undefined;
  // A .ts policy outside a "type": "module" package would load as CommonJS; .mts never does.
  const path = given !== undefined ? resolve(given) : join(cwd, tsIsModule(cwd) ? POLICY_FILES[0] : POLICY_FILES[1]);
  for (const p of [existing, path]) {
    if (p && existsSync(p)) {
      console.error(`samesight: ${p} already exists; edit it, or remove it to start again`);
      return 2;
    }
  }
  const dir = dirname(path);
  const types = TYPES_FILES.find((f) => existsSync(join(dir, f)));
  const typesFile = types ?? TYPES_FILES[0];
  let schema: SchemaInfo | null = null;
  let roles: string[] = [];
  try {
    schema = await introspect(db);
    const membership = findMembership(schema);
    if (membership) roles = await withLocalClient(db, (client) => roleValues(client, membership.table, membership.role));
  } catch (e) {
    console.log(`Could not read the local database (${(e as Error).message}); writing a template instead.`);
    console.log("Start it (supabase start) and rerun init for a policy drafted from your schema.");
  }
  const draft = draftPolicy(schema?.tables.length ? schema : null, { typesFile, roles });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, draft.source);
  for (const n of draft.notes) console.log(`  ${n}`);
  console.log(`wrote ${path}`);
  console.log("\nNext:");
  if (!types) console.log(`  supabase gen types typescript --local --schema public > ${TYPES_FILES[0]}`);
  console.log("  edit the rules, then: samesight generate && samesight explain");
  return 0;
}

/** Where projects usually keep `supabase gen types` output, relative to the policy file. */
const TYPES_FILES = ["supabase/types.ts", "src/types/supabase.ts", "types/supabase.ts", "database.types.ts", "src/database.types.ts", "lib/database.types.ts"];

// 0 on a pass, 1 when a check found something (a policy that does not compile among them),
// 2 when the command could not run: a flag, a file, a database it cannot reach.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`samesight: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof CompileError ? 1 : 2;
  },
);
