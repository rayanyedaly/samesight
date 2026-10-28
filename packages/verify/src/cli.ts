#!/usr/bin/env node
/**
 * samesight-verify: proves, against the local stack, that no device receives a row RLS
 * would refuse its user.
 *
 *   1. static checks, no services: manifest, sync streams, client schema, PowerSync version;
 *   2. catalog checks on the local database: RLS, policies, grants, hook, publication,
 *      triggers, and catalog parity with the generated migration;
 *   3. the differential test: generated data, real users, headless devices, RLS reads;
 *      then the write path: forged upload batches through apply_batch as each user;
 *   4. with --mutate, the mutation test: every mutant of the access layer must be caught.
 *
 * `samesight-verify audit` runs steps 1 to 3 on a project with no policy file: its own
 * RLS (pg_policies) against its own sync config.
 *
 * It refuses any database or service that is not on this machine: it creates users,
 * writes and deletes rows, (with --mutate) restarts PowerSync, and (audit) starts
 * PowerSync containers and a replication role of its own.
 */

import { Console } from "node:console";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import fc from "fast-check";
import type pg from "pg";
import {
  buildIR,
  introspect,
  loadPolicy,
  outputPaths,
  PUBLICATION,
  parseStreams,
  plan,
  resolvePolicyPath,
  type SchemaInfo,
} from "samesight/compiler";
import { audit } from "./audit/run.ts";
import { green, red, useColor, yellow } from "./color.ts";
import { type AutoStarted, autoStart } from "./autostart/run.ts";
import { type Mode, onSignals, Teardown } from "./autostart/teardown.ts";
import { connectLocal } from "./db.ts";
import { brokeDown, differential, setUp, stoppable } from "./differential/run.ts";
import { policyTables } from "./differential/model.ts";
import { worldArbitrary } from "./differential/world.ts";
import { reportDocument, type Section } from "./json.ts";
import { toMarkdown } from "./markdown.ts";
import { mutationTest } from "./mutate/run.ts";
import { exitCode, failed, type Finding, formatSection } from "./report.ts";
import { MAX_SEED, readSeed, replayCommand } from "./replay.ts";
import { assertPowerSync, readStack } from "./stack.ts";
import { checkCatalogParity } from "./static/catalog-parity.ts";
import { checkCatalog } from "./static/catalog.ts";
import { checkClientSchema } from "./static/client-schema.ts";
import { checkManifest, type Manifest } from "./static/manifest.ts";
import { checkStreams } from "./static/streams.ts";
import { checkVersionFloor } from "./static/version-floor.ts";
import { checkWritePath } from "./writepath.ts";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const ARGV = process.argv.slice(2);
const began = Date.now();
/** With --json, stdout carries the report document alone: everything the run prints goes to stderr. */
const JSON_OUT = ARGV.some((a) => a === "--json" || a.startsWith("--json="));
const textOut = JSON_OUT ? process.stderr : process.stdout;
/** Colour and symbols in a terminal; plain when piped, in CI, or under NO_COLOR. Decided once, for every section, on the stream the text goes to. */
const COLOR = useColor(textOut, process.env);
if (JSON_OUT) globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
/** Every section the run printed, for the document. */
const sections: Section[] = [];
/** Prints a section's findings under its title. */
function printSection(title: string, f: Finding[]) {
  sections.push({ title, findings: f });
  textOut.write(`\n${formatSection(title, f, COLOR)}\n`);
}

const USAGE = `Usage: samesight-verify [options]
       samesight-verify audit [audit options]

Options:
  --policy <file>       policy file (default: samesight.policy.ts, or samesight.policy.mts); paths are relative to it
  --powersync <url>     the local PowerSync service (default: http://127.0.0.1:8080)
  --compose <file>      the compose file that runs PowerSync (default: docker-compose.yml)
  --static              run the static and catalog checks only
  --runs <n>            generated datasets for the differential (default: 8)
  --seed <n>            fast-check seed (0 to 2147483644), to replay a run
  --time-limit <s>      stop generating datasets after this many seconds (default: 120)
  --mutate              also run the mutation test (rewrites the sync config and restarts PowerSync)
  --mutate-datasets <n> datasets to try per mutant before calling it missed (default: 8)
  --restart <command>   restarts PowerSync (default: docker compose restart powersync)
  --json                write one JSON report to stdout (schema/report.schema.json), the text to stderr
  --report <file>       also write the findings to this file as Markdown, for an issue

Audit options (a project with hand-written RLS and sync config, no policy file):
  --sync-config <file>  the PowerSync sync config (default: sync-config.yaml)
  --project <dir>       the directory holding supabase/ (default: the current directory)
  --powersync <url>     audit a PowerSync service you run yourself; without it, audit starts one
                        for this run (needs Docker) and removes it, and all it made, at the end
  --keep-powersync      leave the service audit started up, for the next audit of the project to
                        reuse (the next audit that starts PowerSync without the flag removes it)
  --compose <file>      with --powersync or --static: the compose file that runs your PowerSync,
                        to check its version floor
  --publication <name>  with --powersync or --static: the publication to check (default: powersync)
  --static, --runs, --seed, --time-limit, --json, --report   as above

  -v, --version         print the version
  -h, --help            print this help

Needs the project's local Supabase stack running (supabase start); the policy mode also needs
its PowerSync service, and audit needs Docker unless given --powersync or --static.
Docs: https://github.com/rayanyedaly/samesight/tree/main/packages/verify#readme
`;

/**
 * parseArgs, strictly; a flag it refuses is reported in Node's words, without its hint
 * about '--', and with the help to see: "unknown option '--x'; see samesight-verify --help".
 */
function flags<T extends ParseArgsConfig>(help: string, config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (e) {
    if (!(e instanceof Error) || !(e as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS_")) throw e;
    const message = e.message.replace(/\. To specify a positional argument[\s\S]*$/, "");
    throw new Error(`${message.charAt(0).toLowerCase()}${message.slice(1)}; see ${help}`);
  }
}

/** --seed, checked before anything runs. */
function seedFlag(v: string): number {
  const n = readSeed(v);
  if (n === undefined) throw new Error(`--seed must be a whole number from 0 to ${MAX_SEED}, not "${v}"`);
  return n;
}

/** A whole-number flag, checked before anything runs: a zero count would pass while testing nothing. */
function int(name: string, v: string | undefined, fallback: number, min = 1): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be a whole number of at least ${min}, not "${v}"`);
  return n;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "-v" || argv[0] === "--version") {
    textOut.write(`${VERSION}\n`);
    return 0;
  }
  if (argv[0] === "audit") return auditMain(argv.slice(1));
  const { values } = flags("samesight-verify --help", {
    args: argv,
    options: {
      policy: { type: "string" },
      powersync: { type: "string" },
      compose: { type: "string" },
      static: { type: "boolean" },
      runs: { type: "string" },
      seed: { type: "string" },
      "time-limit": { type: "string" },
      mutate: { type: "boolean" },
      "mutate-datasets": { type: "string" },
      restart: { type: "string" },
      json: { type: "boolean" },
      report: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    textOut.write(USAGE);
    return 0;
  }
  const seed = values.seed === undefined ? undefined : seedFlag(values.seed);
  const runs = int("runs", values.runs, 8);
  const timeLimitMs = int("time-limit", values["time-limit"], 120) * 1000;
  const mutateDatasets = int("mutate-datasets", values["mutate-datasets"], 8);
  if (values.static && values.mutate) throw new Error("--static and --mutate cannot be combined");
  const policyPath = resolvePolicyPath(values.policy);
  const root = dirname(policyPath);
  const powersync = values.powersync ?? "http://127.0.0.1:8080";
  const findings: Finding[] = [];
  // Once a signal has begun the teardown, what the run says as its connection ends under it is not news.
  let stopped = () => false;
  const section = (title: string, f: Finding[]) => {
    if (stopped()) return;
    findings.push(...f);
    printSection(title, f);
  };
  const started = Date.now();

  // 1. Static.
  const policy = await loadPolicy(policyPath);
  const out = outputPaths(policy);
  const file = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);
  const snapshot = file(out.schemaSnapshot);
  const manifestText = file(out.manifest);
  if (!snapshot || !manifestText) {
    throw new Error(`no ${snapshot ? out.manifest : out.schemaSnapshot} next to ${policyPath}; run samesight generate first`);
  }
  const schema = JSON.parse(snapshot) as SchemaInfo;
  const ir = buildIR(policy, schema);
  const manifest = JSON.parse(manifestText) as Manifest;
  const planned = plan(policy, schema, root);
  const latest = planned.migration.latest;
  const syncYaml = file(out.syncConfig) ?? "";
  const statics: Finding[] = checkManifest(manifest, (p) => (p === "migration" ? (latest?.content ?? null) : file(p)));
  // The manifest vouches for the files it lists; the policy itself says what they must be.
  const stale = [...planned.files].filter(([p, content]) => file(p) !== content).map(([p]) => p);
  if (latest && latest.content !== planned.migration.content) stale.push(latest.path);
  statics.push(
    stale.length
      ? { status: "fail", check: "generated files", detail: `${stale.join(", ")} differ from what the policy generates; run samesight generate` }
      : { status: "ok", check: "generated files", detail: "every generated file is what the policy generates" },
  );
  try {
    statics.push(...checkStreams(ir, parseStreams(syncYaml)));
  } catch (e) {
    statics.push({ status: "fail", check: "streams", detail: `${out.syncConfig}: ${(e as Error).message}` });
  }
  const client = file(out.clientSchema);
  statics.push(
    ...(client === null ? [{ status: "fail" as const, check: "client schema", detail: `${out.clientSchema} is missing` }] : checkClientSchema(ir, out.clientSchema, client)),
  );
  const composePath = values.compose ?? "docker-compose.yml";
  const compose = file(composePath);
  statics.push(
    ...(compose === null
      ? [{ status: "warn" as const, check: "powersync version", detail: `no ${composePath}; pass --compose to check the PowerSync version floor` }]
      : checkVersionFloor(composePath, compose)),
  );
  section("Static checks", statics);

  // 2. Catalog.
  let signalled = false;
  const stack = readStack(root, powersync);
  const db = await connectLocal(stack.db);
  try {
    const catalog = await checkCatalog(db, manifest, PUBLICATION);
    // The checks above read schema.json; the database must still be what it describes.
    const live = `${JSON.stringify(await introspect(stack.db), null, 2)}\n`;
    catalog.unshift(
      live === snapshot
        ? { status: "ok", check: "schema", detail: `the database matches ${out.schemaSnapshot}` }
        : { status: "fail", check: "schema", detail: `the database differs from ${out.schemaSnapshot}; run samesight generate (and apply the migration)` },
    );
    catalog.push(
      ...(latest
        ? await checkCatalogParity(db, latest.path, latest.content)
        : [{ status: "fail" as const, check: "catalog parity", detail: `no generated migration in ${out.migrations}` }]),
    );
    section("Database catalog", catalog);
    if (values.static) return report(findings, started);
    if (failed(findings)) {
      textOut.write("\nSkipping the differential: fix the failures above first.\n");
      return report(findings, started);
    }
    // Before any user exists: a service that is not there would fail every dataset, and late.
    await assertPowerSync(stack.powersync);

    // 3. Differential, and 4. mutation.
    const log = (line: string) => textOut.write(`  ${((Date.now() - started) / 1000).toFixed(0)}s  ${line}\n`);
    // One teardown for the run, from here on: on Ctrl+C, SIGTERM or SIGHUP it removes the run's
    // users and rows (and with --mutate puts the sync config back).
    const run = signalTeardown(log, "policy");
    stopped = run.stopped;
    try {
      // Added before any user exists, so a run stopped at any point after removes what it made.
      const stop = await stoppable(db, stack, policyTables(ir), log, [], "policy");
      run.teardown.add("the run's users and rows", stop.step);
      log("creating users and tenants");
      // Users are made over HTTP, which ending the connection does not stop: a signal waits for this.
      const s = await run.teardown.step(() => setUp(db, stack, ir));
      try {
        log("generating datasets for the differential");
        const result = await differential(s, {
          sync: { kind: "streams", streams: parseStreams(syncYaml) },
          runs,
          timeLimitMs,
          ...(seed !== undefined ? { seed } : {}),
          replay: (x) => replayCommand("policy", argv, x),
        });
        section(`Differential (${s.fixed.users.length} users, ${result.runs} datasets)`, result.findings);
        log("forging upload batches");
        // Datasets are tried until every forgery has the rows it needs.
        const worlds = fc.sample(worldArbitrary(s.tables, { minRows: 8, maxRows: 20 }), { numRuns: 6, seed: seed ?? 7 });
        section("Write path", (await checkWritePath(s, worlds)).findings);
        if (values.mutate) {
          if (failed(findings)) textOut.write("\nSkipping the mutation test: fix the failures above first.\n");
          else {
            const restart = (values.restart ?? "docker compose restart powersync").split(/\s+/).filter(Boolean);
            const m = await mutationTest(
              s,
              { configPath: join(root, out.syncConfig), restart, cwd: root, url: stack.powersync },
              syncYaml,
              { maxWorlds: mutateDatasets, seed: seed ?? 7, log, teardown: run.teardown },
            );
            const equivalent = m.equivalent.map((e) => ({ status: "ok" as const, check: "equivalent mutant", detail: `${e.description} (${e.reason})` }));
            section("Mutation", [...m.findings, ...equivalent]);
          }
        }
      } finally {
        await stop.tearDown(s);
      }
    } catch (e) {
      if (!run.stopped()) throw e;
    } finally {
      signalled = run.settle();
      await run.teardown.run();
      run.stopListening();
    }
  } finally {
    await db.end().catch(() => {});
  }
  if (signalled) return untilExit();
  return report(findings, started);
}

async function auditMain(argv: string[]): Promise<number> {
  const { values } = flags("samesight-verify audit --help", {
    args: argv,
    options: {
      "sync-config": { type: "string" },
      project: { type: "string" },
      publication: { type: "string" },
      powersync: { type: "string" },
      "keep-powersync": { type: "boolean" },
      compose: { type: "string" },
      static: { type: "boolean" },
      runs: { type: "string" },
      seed: { type: "string" },
      "time-limit": { type: "string" },
      json: { type: "boolean" },
      report: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    textOut.write(USAGE);
    return 0;
  }
  const ownService = values.powersync !== undefined;
  // The service audit starts replicates "powersync"; these only mean something with one of the user's own.
  if (values["keep-powersync"] && (ownService || values.static)) throw new Error("--keep-powersync keeps the service audit starts; it cannot be combined with --powersync or --static");
  if (values.compose !== undefined && !ownService && !values.static) {
    throw new Error("--compose checks the version of a PowerSync service you run yourself; pass it with --powersync or --static");
  }
  if (values.publication !== undefined && values.publication !== "powersync" && !ownService && !values.static) {
    throw new Error(`the PowerSync service audit starts replicates the "powersync" publication; --publication ${values.publication} needs --powersync or --static`);
  }
  const seed = values.seed === undefined ? undefined : seedFlag(values.seed);
  const runs = int("runs", values.runs, 8);
  const timeLimitMs = int("time-limit", values["time-limit"], 120) * 1000;
  const syncPath = resolve(values["sync-config"] ?? "sync-config.yaml");
  if (!existsSync(syncPath)) {
    throw new Error(`no sync config at ${syncPath}; pass --sync-config`);
  }
  const project = resolve(values.project ?? ".");
  const findings: Finding[] = [];
  // Once a signal has begun the teardown, what the run says as its connection ends under it is not news.
  let stopped = () => false;
  const section = (title: string, f: Finding[]) => {
    if (stopped()) return;
    findings.push(...f);
    printSection(title, f);
  };
  const startedAt = Date.now();
  const log = (line: string) => textOut.write(`  ${((Date.now() - startedAt) / 1000).toFixed(0)}s  ${line}\n`);
  const syncText = readFileSync(syncPath, "utf8");
  if (values.compose !== undefined) {
    const compose = existsSync(values.compose) ? readFileSync(values.compose, "utf8") : null;
    section(
      "PowerSync",
      compose === null ? [{ status: "fail", check: "powersync version", detail: `no ${values.compose}` }] : checkVersionFloor(values.compose, compose),
    );
  }
  const stack = readStack(project, values.powersync ?? "http://127.0.0.1");
  const db = await connectLocal(stack.db);
  // One teardown for the run, from here on: on Ctrl+C, SIGTERM or SIGHUP it removes the run's
  // users and rows, and the PowerSync service audit started.
  const run = signalTeardown(log, "audit");
  const { teardown } = run;
  stopped = run.stopped;
  let signalled = false;
  // Without --powersync, a service of the run's own, on a connection of its own, once the checks before the differential pass.
  let client: pg.Client | undefined;
  let started: AutoStarted | undefined;
  let threw = false;
  const startPowerSync = async (tables: string[]) => {
    client = await connectLocal(stack.db);
    started = await autoStart({
      projectDir: project,
      client,
      dbPort: Number(new URL(stack.db).port || 5432),
      api: stack.api,
      ...(stack.jwtSecret ? { jwtSecret: stack.jwtSecret } : {}),
      syncConfig: syncText,
      tables,
      log,
      keep: values["keep-powersync"] === true,
      teardown,
    });
    const how = started.reused ? "kept by an earlier audit and reused" : "started by audit for this run";
    section("PowerSync", [{ status: "ok", check: "powersync version", detail: `${started.version}, ${how} (pinned; at least the 1.20.1 security floor)` }]);
    return { powersync: started.url, slotPrefix: started.slotPrefix };
  };
  try {
    await audit(db, stack, {
      syncConfig: { path: syncPath, text: syncText },
      ...(values.publication !== undefined ? { publication: values.publication } : {}),
      staticOnly: values.static === true,
      runs,
      timeLimitMs,
      ...(seed !== undefined ? { seed } : {}),
      replay: (x) => replayCommand("audit", argv, x),
      section,
      log,
      projectDir: project,
      ...(ownService ? {} : { startPowerSync }),
      teardown,
    });
  } catch (e) {
    if (!stopped()) {
      threw = true;
      throw e;
    }
  } finally {
    signalled = run.settle();
    // A run that broke down (an error, or datasets the run could not finish) shows the service's last words before they are removed.
    const broke = !signalled && (threw || brokeDown(findings));
    const left = (await started?.stop(broke ? { logs: (text) => process.stderr.write(`\nPowerSync's last log lines:\n${text}\n`) } : {})) ?? (await teardown.run());
    run.stopListening();
    if (left.length && !signalled) section("Clean-up", left.map((what) => ({ status: "warn" as const, check: "clean-up", detail: `could not remove ${what}; the next audit that starts PowerSync removes it` })));
    await client?.end().catch(() => {});
    await db.end().catch(() => {});
  }
  if (signalled) return untilExit();
  return report(findings, startedAt);
}

/**
 * A run's teardown, which onSignals runs on Ctrl+C, SIGTERM or SIGHUP (or a closed output).
 * `stopped` says a signal began it while the run goes on: what the run says as its
 * connections end under it is not news. `settle`, once the run is over, ends that and says
 * whether a signal stopped it.
 */
function signalTeardown(log: (line: string) => void, mode: Mode) {
  const teardown = new Teardown(log, mode);
  const stopListening = onSignals(teardown, log);
  let over = false;
  const stopped = () => teardown.stoppedBy !== undefined && !over;
  const settle = () => {
    const was = stopped();
    over = true;
    return was;
  };
  return { teardown, stopListening, stopped, settle };
}

/** Stopped by a signal: onSignals exits with its code (130, 143, 129, 141) once the teardown is done. */
const untilExit = () => new Promise<number>(() => setInterval(() => {}, 60_000));

/** The summary line; exits 0 on a pass, 1 when a check found something, 2 when one only could not run. */
function report(findings: Finding[], started: number): number {
  const fails = findings.filter((f) => f.status === "fail" && !f.incomplete).length;
  const incomplete = findings.filter((f) => f.status === "fail" && f.incomplete).length;
  const warns = findings.filter((f) => f.status === "warn").length;
  const time = `${((Date.now() - started) / 1000).toFixed(0)}s`;
  const notRun = incomplete ? `${incomplete} could not run` : "";
  const head = fails ? `FAILED: ${fails} failing${notRun ? `, ${notRun}` : ""}` : notRun ? `INCOMPLETE: ${notRun}` : "PASSED";
  const paint = !COLOR ? (s: string) => s : fails ? red : notRun ? yellow : green;
  textOut.write(`\n${paint(head)}${warns ? `, ${warns} warnings` : ""} (${time})\n`);
  return exitCode(findings);
}

/** What `--report` writes: each section as printed, and why the run could not go on. */
/** `--report`'s file, read before the flags are, so a run that cannot read them still writes it. */
function reportPath(argv: string[]): string | undefined {
  let path: string | undefined;
  for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
    // A flag after --report is not its file (parseArgs refuses the line): no file named --json.
    if (argv[i] === "--report" && i + 1 < argv.length && !argv[i + 1]?.startsWith("--")) path = argv[++i];
    else if (argv[i]?.startsWith("--report=")) path = argv[i]?.slice("--report=".length);
  }
  return path;
}

/**
 * Writes the Markdown report, when asked for and the run got as far as a check or an error
 * (not for --help or --version). A report it cannot write turns a pass into exit 2.
 */
function writeReport(argv: string[], code: number, error?: string): number {
  const path = reportPath(argv);
  if (path === undefined || (!sections.length && error === undefined)) return code;
  try {
    writeFileSync(path, toMarkdown({ mode: argv[0] === "audit" ? "audit" : "policy", exitCode: code, sections, ...(error !== undefined ? { error } : {}) }));
  } catch (e) {
    process.stderr.write(`samesight-verify: could not write the report to ${path}: ${(e as Error).message}\n`);
    return code === 0 ? 2 : code;
  }
  return code;
}

// PowerSync's worker threads can keep the process alive, so it exits explicitly, once the
// report has been written out.
// Output that has gone (| head, a closed terminal) is no reason to crash; during an audit,
// its teardown handles it (autostart/teardown.ts), and otherwise the run ends as it would,
// exiting 141 as on SIGPIPE.
let outputGone: number | undefined;
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    outputGone ??= e.code === "EPIPE" || e.code === "EIO" ? 141 : 2;
  });
}
// A failed write calls back before it emits 'error': the callbacks' own errors count too.
const exit = (code: number) => {
  let left = 2;
  const done = (e?: Error | null) => {
    if (e) outputGone ??= ["EPIPE", "EIO"].includes((e as NodeJS.ErrnoException).code ?? "") ? 141 : 2;
    if (--left === 0) process.exit(outputGone ?? code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
};
/** Writes the --json document, then exits. A signal exits before this, with no document. */
// A signal exits from onSignals instead, with neither report.
const finish = (exitWith: number, error?: string) => {
  const code = writeReport(ARGV, exitWith, error);
  if (JSON_OUT) {
    const doc = reportDocument({ toolVersion: VERSION, argv: ARGV, exitCode: code, durationMs: Date.now() - began, sections, ...(error !== undefined ? { error } : {}) });
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  }
  exit(code);
};
// An error (bad flags, a database or service it cannot reach) means it could not run: 2.
main(ARGV).then(finish, (e) => {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`samesight-verify: ${message}\n`);
  finish(2, message);
});
