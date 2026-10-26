#!/usr/bin/env node
/**
 * samesight init | generate | check | doctor | explain
 *
 * Runs on Node's built-in TypeScript support (type stripping), so a policy file is
 * imported as written. Paths in the policy's `output` are relative to the policy file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { doctor, type Finding } from "./doctor.ts";
import { explainPolicy } from "./explain.ts";
import { outputPaths, plan } from "./generate.ts";
import { draftPolicy, findMembership, roleValues } from "./init.ts";
import { DEFAULT_DB_URL, introspect, withLocalClient } from "./introspect.ts";
import { buildIR, CompileError } from "./ir.ts";
import { loadPolicy, POLICY_FILES, resolvePolicyPath, tsIsModule } from "./load.ts";
import type { Policy } from "./policy.ts";
import type { SchemaInfo } from "./schema.ts";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const USAGE = `Usage: samesight <command> [options]

Commands:
  init       draft samesight.policy.ts from the local database (a template without one)
  generate   read the local database, write the migration, sync config and client files
  check      regenerate from the saved schema snapshot and fail if anything on disk differs
  doctor     check the local database against the policy (RLS, publication, hook, replication lag)
  explain    print who can read and write what, in plain words, from the saved schema snapshot

Options:
  --policy <file>   policy file (default: samesight.policy.ts, or samesight.policy.mts)
  --db <url>        local database URL (default: $SAMESIGHT_DB_URL or the Supabase CLI database)
  --table <name>    explain: one table only
  -v, --version     print the version
  -h, --help        print this help

Docs: https://github.com/rayanyedaly/samesight#readme
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      policy: { type: "string" },
      db: { type: "string" },
      table: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const command = positionals[0];
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 1;
  }
  const policyPath = resolvePolicyPath(values.policy);
  const root = dirname(policyPath);
  const db = values.db ?? process.env.SAMESIGHT_DB_URL ?? DEFAULT_DB_URL;

  switch (command) {
    case "init":
      return init(values.policy, db);
    case "explain": {
      const policy = await loadPolicy(policyPath);
      const snapshot = join(root, outputPaths(policy).schemaSnapshot);
      if (!existsSync(snapshot)) {
        console.error(`No schema snapshot at ${snapshot}; run \`samesight generate\` first.`);
        return 1;
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
        console.error(`No schema snapshot at ${snapshot}; run \`samesight generate\` first.`);
        return 1;
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
      const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
      for (const f of findings) console.log(`${mark[f.status]}  ${f.check}: ${f.detail}`);
      return findings.some((f) => f.status === "fail") ? 1 : 0;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
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
      console.error(`${p} already exists.`);
      return 1;
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

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof CompileError ? error.message : error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
