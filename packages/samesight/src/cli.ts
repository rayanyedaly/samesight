#!/usr/bin/env node
/**
 * samesight init | generate | check | doctor
 *
 * Runs on Node's built-in TypeScript support (type stripping), so a policy file is
 * imported as written. Paths in the policy's `output` are relative to the policy file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { doctor, type Finding } from "./doctor.ts";
import { outputPaths, plan } from "./generate.ts";
import { DEFAULT_DB_URL, introspect } from "./introspect.ts";
import { buildIR, CompileError } from "./ir.ts";
import { isPolicy, type Policy } from "./policy.ts";
import type { SchemaInfo } from "./schema.ts";

const USAGE = `Usage: samesight <command> [options]

Commands:
  init       write a starter samesight.policy.ts
  generate   read the local database, write the migration, sync config and client files
  check      regenerate from the saved schema snapshot and fail if anything on disk differs
  doctor     check the local database against the policy (RLS, publication, hook, replication lag)

Options:
  --policy <file>   policy file (default: samesight.policy.ts)
  --db <url>        local database URL (default: $SAMESIGHT_DB_URL or the Supabase CLI database)
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { policy: { type: "string" }, db: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 1;
  }
  const policyPath = resolve(values.policy ?? "samesight.policy.ts");
  const root = dirname(policyPath);
  const db = values.db ?? process.env.SAMESIGHT_DB_URL ?? DEFAULT_DB_URL;

  switch (command) {
    case "init":
      return init(policyPath);
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

async function loadPolicy(path: string): Promise<Policy> {
  if (!existsSync(path)) throw new Error(`No policy file at ${path}; run \`samesight init\`.`);
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  if (!isPolicy(mod.default)) throw new Error(`${path} must \`export default definePolicy(...)\`.`);
  return mod.default;
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

function init(path: string): number {
  if (existsSync(path)) {
    console.error(`${path} already exists.`);
    return 1;
  }
  writeFileSync(
    path,
    `import { claim, col, definePolicy, table } from "samesight";
// Generate with: supabase gen types typescript --local > supabase/types.ts
import type { Database } from "./supabase/types";

export default definePolicy<Database>({
  auth: "supabase",
  claims: {
    tenant: claim.uuid("tenant_id"),
    role: claim.oneOf("app_role", ["ADMIN", "MEMBER"]),
  },
  // Where the access token hook finds a signing-in user's tenant and role.
  membership: { table: "Membership", user: "userId", tenant: "tenantId", role: "role" },
  tables: {
    // Membership: table({ tenant: "tenantId", read: { ADMIN: true, MEMBER: col("userId").eq(claim.user) } }),
  },
});
`,
  );
  console.log(`wrote ${path}. Fill in the tables, then run \`samesight generate\`.`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof CompileError ? error.message : error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
