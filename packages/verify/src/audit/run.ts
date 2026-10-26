/**
 * Audit mode: the verifier on a project with no Samesight policy, only its own RLS and
 * sync config. Steps 1 to 3 of the verifier (static, catalog, differential and write path)
 * run on what pg_policies and the sync config say; the mutation test needs a policy to
 * mutate, so it does not.
 */

import fc from "fast-check";
import type pg from "pg";
import { rows } from "../db.ts";
import { sqlHints } from "../differential/model.ts";
import { differential, setUpUsers, tearDown } from "../differential/run.ts";
import { worldArbitrary } from "../differential/world.ts";
import { failed, type Finding } from "../report.ts";
import type { Stack } from "../stack.ts";
import { checkAuditCatalog, checkUserEditableClaims } from "./catalog.ts";
import { auditScope } from "./scope.ts";
import { parseSyncConfig } from "./sync-config.ts";
import { checkWriteEscape } from "./writes.ts";

export interface AuditOptions {
  /** The sync config's text, and its path for reports. */
  syncConfig: { path: string; text: string };
  publication?: string;
  /** Static and catalog checks only. */
  staticOnly?: boolean;
  runs: number;
  seed?: number;
  timeLimitMs: number;
  section: (title: string, findings: Finding[]) => void;
  log: (line: string) => void;
}

/**
 * The synced tables and the tables their queries read, then, repeatedly, every public table
 * those reference (generated rows need parents) and every table their RLS policies read
 * (memberships, shares), so each branch of a rule has rows to match.
 */
export async function auditTables(client: pg.Client, start: string[]): Promise<string[]> {
  const found = await rows<{ name: string }>(
    client,
    `with recursive t(oid) as (
       select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any($1)
       union
       select r.oid from t
         join lateral (
           select k.confrelid as oid from pg_constraint k where k.conrelid = t.oid and k.contype = 'f'
           union
           select d.refobjid from pg_policy pol
             join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = pol.oid and d.refclassid = 'pg_class'::regclass
            where pol.polrelid = t.oid
           union
           -- Tables a policy reads through a function with a SQL-standard body (BEGIN ATOMIC or
           -- RETURN), which Postgres records; other bodies are opaque (the catalog warns).
           select fd.refobjid from pg_policy pol
             join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = pol.oid and d.refclassid = 'pg_proc'::regclass
             join pg_depend fd on fd.classid = 'pg_proc'::regclass and fd.objid = d.refobjid and fd.refclassid = 'pg_class'::regclass
            where pol.polrelid = t.oid
         ) x on true
         join pg_class r on r.oid = x.oid join pg_namespace rn on rn.oid = r.relnamespace
        where rn.nspname = 'public' and r.relkind in ('r', 'p')
     )
     select c.relname as name from t join pg_class c on c.oid = t.oid order by 1`,
    [start],
  );
  return found.map((r) => r.name);
}

/** Runs the audit; the findings are reported through `section` as each step ends. */
export async function audit(client: pg.Client, stack: Stack, o: AuditOptions): Promise<Finding[]> {
  const findings: Finding[] = [];
  const section = (title: string, f: Finding[]) => {
    findings.push(...f);
    o.section(title, f);
  };

  let scope: ReturnType<typeof auditScope>;
  let warnings: Finding[];
  let streamSql: { where: string; sql: string }[];
  try {
    const config = parseSyncConfig(o.syncConfig.text);
    streamSql = config.streams.flatMap((st) => [
      ...[...st.ctes].map(([name, sql]) => ({ where: `${st.name}.${name}`, sql })),
      ...st.queries.map((q) => ({ where: `${st.name}.${q.label}`, sql: q.sql })),
    ]);
    scope = auditScope(config.streams, config.kind);
    warnings = config.findings;
  } catch (e) {
    section("Sync config", [{ status: "fail", check: "sync config", detail: `${o.syncConfig.path}: ${(e as Error).message}` }]);
    return findings;
  }
  section("Sync config", [...scope.findings, ...warnings]);
  if (failed(findings)) return findings;

  const policies = await rows<{ table: string; name: string; qual: string | null; with_check: string | null }>(
    client,
    "select tablename as table, policyname as name, qual, with_check from pg_policies where schemaname = 'public'",
  );
  const rules = [
    ...policies.map((p) => ({ where: `policy "${p.name}" on ${p.table}`, sql: `${p.qual ?? ""} ${p.with_check ?? ""}` })),
    ...streamSql,
  ];
  section("Database catalog", [...(await checkAuditCatalog(client, scope.synced, o.publication, scope.reads)), ...checkUserEditableClaims(rules)]);
  if (o.staticOnly) return findings;
  if (failed(findings)) {
    o.log("skipping the differential: fix the failures above first");
    return findings;
  }

  const tables = await auditTables(client, [...new Set([...scope.synced, ...scope.reads])]);
  o.log(`signing up users; generating rows for ${tables.join(", ")}`);
  // The literals and user comparisons in the project's own rules steer the generated data.
  const { hints, users } = sqlHints(rules.map((r) => r.sql).join("\n"));
  const s = await setUpUsers(client, stack, { tables: tables.map((name) => ({ name, hints, userColumns: users })), synced: scope.synced });
  try {
    o.log("generating datasets for the differential");
    const result = await differential(s, { runs: o.runs, timeLimitMs: o.timeLimitMs, ...(o.seed !== undefined ? { seed: o.seed } : {}) });
    section(`Differential (${s.fixed.users.length} users, ${result.runs} datasets)`, result.findings);
    o.log("writing as each user");
    const [world] = fc.sample(worldArbitrary(s.tables, { minRows: 8, maxRows: 16 }), { numRuns: 1, seed: o.seed ?? 7 });
    section("Write path", world ? await checkWriteEscape(s, world, undefined, scope.reads) : [{ status: "fail", check: "write path", detail: "no dataset was generated" }]);
  } finally {
    await tearDown(s);
  }
  return findings;
}
