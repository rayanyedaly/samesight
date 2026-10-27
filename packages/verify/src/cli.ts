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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
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
import { type AutoStarted, autoStart } from "./autostart/run.ts";
import { onSignals, Teardown } from "./autostart/teardown.ts";
import { connectLocal } from "./db.ts";
import { differential, setUp, tearDown } from "./differential/run.ts";
import { worldArbitrary } from "./differential/world.ts";
import { mutationTest } from "./mutate/run.ts";
import { failed, type Finding, formatFindings } from "./report.ts";
import { readStack } from "./stack.ts";
import { checkCatalogParity } from "./static/catalog-parity.ts";
import { checkCatalog } from "./static/catalog.ts";
import { checkClientSchema } from "./static/client-schema.ts";
import { checkManifest, type Manifest } from "./static/manifest.ts";
import { checkStreams } from "./static/streams.ts";
import { checkVersionFloor } from "./static/version-floor.ts";
import { checkWritePath } from "./writepath.ts";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const USAGE = `Usage: samesight-verify [options]
       samesight-verify audit [audit options]

Options:
  --policy <file>       policy file (default: samesight.policy.ts, or samesight.policy.mts); paths are relative to it
  --powersync <url>     the local PowerSync service (default: http://127.0.0.1:8080)
  --compose <file>      the compose file that runs PowerSync (default: docker-compose.yml)
  --static              run the static and catalog checks only
  --runs <n>            generated datasets for the differential (default: 8)
  --seed <n>            fast-check seed, to replay a run
  --time-limit <s>      stop generating datasets after this many seconds (default: 120)
  --mutate              also run the mutation test (rewrites the sync config and restarts PowerSync)
  --mutate-datasets <n> datasets to try per mutant before calling it missed (default: 8)
  --restart <command>   restarts PowerSync (default: docker compose restart powersync)

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
  --static, --runs, --seed, --time-limit   as above

  -v, --version         print the version
  -h, --help            print this help

Needs the project's local Supabase stack running (supabase start); the policy mode also needs
its PowerSync service, and audit needs Docker unless given --powersync or --static.
Docs: https://github.com/rayanyedaly/samesight/tree/main/packages/verify#readme
`;

/** A whole-number flag, checked before anything runs: a zero count would pass while testing nothing. */
function int(name: string, v: string | undefined, fallback: number, min = 1): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be a whole number of at least ${min}, not "${v}"`);
  return n;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "-v" || argv[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (argv[0] === "audit") return auditMain(argv.slice(1));
  const { values } = parseArgs({
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
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const seed = values.seed === undefined ? undefined : int("seed", values.seed, 0, 0);
  const runs = int("runs", values.runs, 8);
  const timeLimitMs = int("time-limit", values["time-limit"], 120) * 1000;
  const mutateDatasets = int("mutate-datasets", values["mutate-datasets"], 8);
  if (values.static && values.mutate) throw new Error("--static and --mutate cannot be combined");
  const policyPath = resolvePolicyPath(values.policy);
  const root = dirname(policyPath);
  const powersync = values.powersync ?? "http://127.0.0.1:8080";
  const findings: Finding[] = [];
  const section = (title: string, f: Finding[]) => {
    findings.push(...f);
    process.stdout.write(`\n${title}\n${formatFindings(f)}\n`);
  };
  const started = Date.now();

  // 1. Static.
  const policy = await loadPolicy(policyPath);
  const out = outputPaths(policy);
  const file = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);
  const snapshot = file(out.schemaSnapshot);
  const manifestText = file(out.manifest);
  if (!snapshot || !manifestText) {
    process.stderr.write(`No ${snapshot ? out.manifest : out.schemaSnapshot} next to ${policyPath}; run samesight generate first.\n`);
    return 1;
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
      process.stdout.write("\nSkipping the differential: fix the failures above first.\n");
      return report(findings, started);
    }

    // 3. Differential, and 4. mutation.
    const log = (line: string) => process.stdout.write(`  ${((Date.now() - started) / 1000).toFixed(0)}s  ${line}\n`);
    log("creating users and tenants");
    const s = await setUp(db, stack, ir);
    try {
      log("generating datasets for the differential");
      const result = await differential(s, {
        runs,
        timeLimitMs,
        ...(seed !== undefined ? { seed } : {}),
      });
      section(`Differential (${s.fixed.users.length} users, ${result.runs} datasets)`, result.findings);
      log("forging upload batches");
      // Datasets are tried until every forgery has the rows it needs.
      const worlds = fc.sample(worldArbitrary(s.tables, { minRows: 8, maxRows: 20 }), { numRuns: 6, seed: seed ?? 7 });
      section("Write path", (await checkWritePath(s, worlds)).findings);
      if (values.mutate) {
        if (failed(findings)) process.stdout.write("\nSkipping the mutation test: fix the failures above first.\n");
        else {
          const restart = (values.restart ?? "docker compose restart powersync").split(/\s+/).filter(Boolean);
          const m = await mutationTest(
            s,
            { configPath: join(root, out.syncConfig), restart, cwd: root, url: stack.powersync },
            syncYaml,
            { maxWorlds: mutateDatasets, seed: seed ?? 7, log },
          );
          const equivalent = m.equivalent.map((e) => ({ status: "ok" as const, check: "equivalent mutant", detail: `${e.description} (${e.reason})` }));
          section("Mutation", [...m.findings, ...equivalent]);
        }
      }
    } finally {
      await tearDown(s);
    }
  } finally {
    await db.end();
  }
  return report(findings, started);
}

async function auditMain(argv: string[]): Promise<number> {
  const { values } = parseArgs({
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
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
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
  const seed = values.seed === undefined ? undefined : int("seed", values.seed, 0, 0);
  const runs = int("runs", values.runs, 8);
  const timeLimitMs = int("time-limit", values["time-limit"], 120) * 1000;
  const syncPath = resolve(values["sync-config"] ?? "sync-config.yaml");
  if (!existsSync(syncPath)) {
    process.stderr.write(`No sync config at ${syncPath}; pass --sync-config.\n`);
    return 1;
  }
  const project = resolve(values.project ?? ".");
  const findings: Finding[] = [];
  const section = (title: string, f: Finding[]) => {
    findings.push(...f);
    process.stdout.write(`\n${title}\n${formatFindings(f)}\n`);
  };
  const startedAt = Date.now();
  const log = (line: string) => process.stdout.write(`  ${((Date.now() - startedAt) / 1000).toFixed(0)}s  ${line}\n`);
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
  const teardown = new Teardown(log);
  const stopListening = onSignals(teardown, log);
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
      section,
      log,
      projectDir: project,
      ...(ownService ? {} : { startPowerSync }),
      teardown,
    });
  } catch (e) {
    threw = true;
    throw e;
  } finally {
    // A run that broke down (an error, or datasets the run could not finish) shows the service's last words before they are removed.
    const brokeDown = threw || findings.some((f) => f.status === "fail" && /^the run failed: |\(then a run failed: /.test(f.detail));
    const left = (await started?.stop(brokeDown ? { logs: (text) => process.stderr.write(`\nPowerSync's last log lines:\n${text}\n`) } : {})) ?? (await teardown.run());
    stopListening();
    if (left.length) section("Clean-up", left.map((what) => ({ status: "warn" as const, check: "clean-up", detail: `could not remove ${what}; the next audit that starts PowerSync removes it` })));
    await client?.end();
    await db.end();
  }
  return report(findings, startedAt);
}

function report(findings: Finding[], started: number): number {
  const fails = findings.filter((f) => f.status === "fail").length;
  const warns = findings.filter((f) => f.status === "warn").length;
  const time = `${((Date.now() - started) / 1000).toFixed(0)}s`;
  process.stdout.write(`\n${fails ? `FAILED: ${fails} failing` : "PASSED"}${warns ? `, ${warns} warnings` : ""} (${time})\n`);
  return fails ? 1 : 0;
}

// PowerSync's worker threads can keep the process alive, so it exits explicitly, once the
// report has been written out.
// Output that has gone (| head, a closed terminal) is no reason to crash; during an audit,
// its teardown handles it (autostart/teardown.ts), and otherwise the run ends as it would,
// exiting 141 as on SIGPIPE.
let outputGone: number | undefined;
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    outputGone ??= e.code === "EPIPE" || e.code === "EIO" ? 141 : 1;
  });
}
// A failed write calls back before it emits 'error': the callbacks' own errors count too.
const exit = (code: number) => {
  let left = 2;
  const done = (e?: Error | null) => {
    if (e) outputGone ??= ["EPIPE", "EIO"].includes((e as NodeJS.ErrnoException).code ?? "") ? 141 : 1;
    if (--left === 0) process.exit(outputGone ?? code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
};
main(process.argv.slice(2)).then(exit, (e) => {
  process.stderr.write(`samesight-verify: ${(e as Error).message}\n`);
  exit(1);
});
