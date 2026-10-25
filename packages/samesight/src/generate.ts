/**
 * Plans every generated file from a policy and a schema: the same plan backs `generate`
 * (which writes it) and `check` (which compares it with what is on disk).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, win32 } from "node:path";
import { emitClientSchema, emitManifest, emitPolicyTypes, emitServiceConfig } from "./emit/client.ts";
import { emitMigration } from "./emit/migration.ts";
import { emitSyncConfig } from "./emit/sync.ts";
import { buildIR } from "./ir.ts";
import type { OutputPaths, Policy } from "./policy.ts";
import type { SchemaInfo } from "./schema.ts";

export const DEFAULT_OUTPUT: Required<OutputPaths> = {
  migrations: "supabase/migrations",
  syncConfig: "powersync/sync-config.yaml",
  serviceConfig: "powersync/service.yaml",
  clientSchema: "src/samesight/app-schema.ts",
  policyTypes: "src/samesight/policy-types.ts",
  manifest: "samesight/manifest.json",
  schemaSnapshot: "samesight/schema.json",
};

const MIGRATION_SUFFIX = "_samesight.sql";

export interface Plan {
  /** Paths relative to the project root (the policy file's directory). */
  files: Map<string, string>;
  /** The access migration's content, and the latest one already in the migrations directory. */
  migration: { content: string; latest: { path: string; content: string } | null; next: string };
  warnings: string[];
}

/** The policy's output paths over the defaults; each must stay inside the project and be distinct. */
export function outputPaths(policy: Policy): Required<OutputPaths> {
  const given = Object.entries(policy.spec.output ?? {}).filter(([, v]) => v !== undefined);
  const out = { ...DEFAULT_OUTPUT, ...Object.fromEntries(given) } as Required<OutputPaths>;
  const seen = new Map<string, string>();
  for (const [key, value] of Object.entries(out)) {
    const p = typeof value === "string" ? posix.normalize(toPosix(value)) : "";
    if (!p || p === "." || isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || p === ".." || p.startsWith("../")) {
      throw new Error(`output.${key} must be a relative path inside the project, not "${value}"`);
    }
    // Case-insensitive, as on Windows and macOS file systems.
    const clash = seen.get(p.toLowerCase());
    if (clash) throw new Error(`output.${key} and output.${clash} are the same path`);
    seen.set(p.toLowerCase(), key);
  }
  return out;
}

export function plan(policy: Policy, schema: SchemaInfo, root: string, now = new Date()): Plan {
  const ir = buildIR(policy, schema);
  const out = outputPaths(policy);
  const files = new Map<string, string>();
  files.set(out.syncConfig, emitSyncConfig(ir));
  files.set(
    out.serviceConfig,
    emitServiceConfig({
      syncConfigPath: toPosix(relative(dirname(out.serviceConfig), out.syncConfig)),
      jwksUri: "http://kong:8000/auth/v1/.well-known/jwks.json",
    }),
  );
  files.set(out.clientSchema, emitClientSchema(ir, policy.spec.client));
  files.set(out.policyTypes, emitPolicyTypes(ir));
  files.set(out.schemaSnapshot, `${JSON.stringify(schema, null, 2)}\n`);

  const migration = emitMigration(ir);
  const existing = migrations(join(root, out.migrations));
  const next = toPosix(join(out.migrations, `${nextVersion(existing.newest, now)}${MIGRATION_SUFFIX}`));
  const latest = existing.latest && { path: toPosix(join(out.migrations, existing.latest.file)), content: existing.latest.content };

  // The manifest ties the policy to the exact outputs, the migration by content.
  const hashed = Object.fromEntries([...files].filter(([p]) => p !== out.schemaSnapshot));
  files.set(out.manifest, emitManifest(ir, { ...hashed, migration }));

  return {
    files,
    migration: { content: migration, latest, next },
    warnings: ir.warnings,
  };
}

function migrations(dir: string): { latest: { file: string; content: string } | null; newest?: string } {
  if (!existsSync(dir)) return { latest: null };
  const all = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // The Supabase CLI applies files in name order, so a version that is not a timestamp
  // would sort apart from ours; ask for timestamps rather than guess.
  const odd = all.find((f) => version(f).length !== 14);
  if (odd) throw new Error(`${odd}: samesight expects migration versions to be timestamps (yyyymmddhhmmss)`);
  const last = all.filter((f) => f.endsWith(MIGRATION_SUFFIX)).at(-1);
  return {
    latest: last ? { file: last, content: readFileSync(join(dir, last), "utf8") } : null,
    // The newest migration of any kind fixes the next version, so ours always applies last.
    newest: all.length ? version(all.at(-1) as string) : undefined,
  };
}

function version(file: string): string {
  return file.slice(0, file.indexOf("_"));
}

/** A Supabase migration version (UTC yyyymmddhhmmss) after both now and the newest one. */
export function nextVersion(after: string | undefined, now: Date): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  if (!after || stamp > after) return stamp;
  const d = new Date(
    Date.UTC(+after.slice(0, 4), +after.slice(4, 6) - 1, +after.slice(6, 8), +after.slice(8, 10), +after.slice(10, 12), +after.slice(12, 14) + 1),
  );
  const next = d.toISOString().replace(/\D/g, "").slice(0, 14);
  // A version that is not a real date (month 13) can roll Date over to an earlier string.
  if (next.length !== 14 || next <= after) throw new Error(`cannot find a migration version after ${after}`);
  return next;
}

function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}
