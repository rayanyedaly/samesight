/**
 * Audit mode: the verifier on a project with no Samesight policy, only its own RLS and
 * sync config. Steps 1 to 3 of the verifier (static, catalog, differential and write path)
 * run on what pg_policies and the sync config say; the mutation test needs a policy to
 * mutate, so it does not.
 */

import fc from "fast-check";
import type pg from "pg";
import { rows } from "../db.ts";
import { readModel, sqlHints } from "../differential/model.ts";
import type { Teardown } from "../autostart/teardown.ts";
import { differential, PREFIX, type Run, runUserIds, setUpUsers, stoppable, type UserClaims } from "../differential/run.ts";
import { prefixedUuid, worldArbitrary } from "../differential/world.ts";
import { type Assignment, assignClaims, MAX_USERS, metadataOf } from "./assign.ts";
import { failed, type Finding } from "../report.ts";
import type { Stack } from "../stack.ts";
import { checkAuditCatalog, checkUserEditableClaims } from "./catalog.ts";
import { accessTokenHook, at, claimFindings, type ClaimsPlan, planClaims, policyFunctions, policyRules, type RuleSql, syncRules } from "./claims.ts";
import { auditScope } from "samesight/compiler";
import { parseSyncConfig, type SyncConfig } from "samesight/compiler";
import { coverageFindings, coverageScope, coverageTitle, qualifyDifferential } from "./coverage.ts";
import { type Dim, type FixedPlan, type FixedRow, fixedPlan, fixedRows, hookDims } from "./fixed.ts";
import { type HookPlan, planHook, showUri } from "./hook.ts";
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
  /** The directory holding supabase/, to read its access token hook settings. */
  projectDir?: string;
  /**
   * Starts a PowerSync service for the differential, once the sync config and catalog
   * have passed, given the public tables it must read; resolves with where it runs.
   * Without it, the stack's own service is used.
   */
  startPowerSync?: (tables: string[]) => Promise<Pick<Stack, "powersync" | "slotPrefix">>;
  /** What a signal runs (see autostart/teardown.ts): given, a stopped run removes its users and rows. */
  teardown?: Teardown;
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
export async function audit(client: pg.Client, given: Stack, o: AuditOptions): Promise<Finding[]> {
  const findings: Finding[] = [];
  const section = (title: string, f: Finding[]) => {
    findings.push(...f);
    o.section(title, f);
  };

  let scope: ReturnType<typeof auditScope>;
  let warnings: Finding[];
  let streamSql: RuleSql[];
  let config: SyncConfig;
  try {
    config = parseSyncConfig(o.syncConfig.text);
    streamSql = syncRules(config);
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
  const p = await planRun(client, config, o.projectDir);
  const { claims, hook, hookPlan, assignment, tables, named } = p;
  if (o.staticOnly || failed(findings)) {
    section("Claims", claimFindings(claims, hook, undefined, assignment, hookPlan));
    if (!o.staticOnly) o.log("skipping the differential: fix the failures above first");
    return findings;
  }

  // Only the tables that exist: a query can read from a function (json_each) too.
  const stack = o.startPowerSync ? { ...given, ...(await o.startPowerSync(named.filter((t) => tables.includes(t)).sort())) } : given;
  const fixedTables = p.setUp.scope.fixed?.tables ?? [];
  o.log(`signing up users; generating rows for ${tables.filter((t) => !fixedTables.includes(t)).join(", ")}${fixedTables.length ? `; rows the access token hook reads in ${fixedTables.join(", ")}` : ""}`);
  // Added before any user exists, so a run stopped at any point after removes what it made.
  const stop = await stoppable(client, stack, p.setUp.scope.tables, o.log);
  o.teardown?.add("the run's users and rows", stop.step);
  let s: Run;
  try {
    const setUp = () => setUpUsers(client, stack, p.setUp.scope, p.setUp.claims);
    // Users are made over HTTP, which ending the connection does not stop: a signal waits for this.
    s = await (o.teardown ? o.teardown.step(setUp) : setUp());
  } catch (e) {
    // Users could not sign in (a rate limit, say): the claims are still worth showing.
    section("Claims", claimFindings(claims, hook, undefined, assignment, hookPlan));
    throw e;
  }
  try {
    const tokens = new Map(s.fixed.users.map((u) => [u.label.split(" ")[0] as string, s.sessions.get(u.id)?.claims ?? {}]));
    const given = s.fixedRefused ?? [];
    const refused: Finding[] = given.length
      ? [{ status: "warn", check: "claims", detail: `the database refused ${given.length === 1 ? "a row" : `${given.length} rows`} audit gave for the access token hook, so ${given.length === 1 ? "that user holds" : "those users hold"} none there: ${given.slice(0, 3).join("; ")}${given.length > 3 ? `; and ${given.length - 3} more` : ""}` }]
      : [];
    section("Claims", [...claimFindings(claims, hook, tokens, assignment, hookPlan), ...refused]);
    o.log("generating datasets for the differential");
    // Claims users hold values of: what audit set, and what the hook added from their rows when tokens differ.
    const held = new Set([...assignment.paths.map((x) => x.key), ...hookKeysHeld(claims, tokens)]);
    const coverage = await coverageScope(client, scope.synced, config.streams, p.functions, config.kind, held);
    const result = await differential(s, { runs: o.runs, timeLimitMs: o.timeLimitMs, coverage, ...(o.seed !== undefined ? { seed: o.seed } : {}) });
    section(`Differential (${s.fixed.users.length} users, ${result.runs} datasets)`, qualifyDifferential(result.findings, coverage));
    section(coverageTitle(coverage, result), coverageFindings(coverage, held, assignment.partial));
    o.log("writing as each user");
    const [world] = fc.sample(worldArbitrary(s.tables, { minRows: 8, maxRows: 16 }), { numRuns: 1, seed: o.seed ?? 7 });
    section("Write path", world ? await checkWriteEscape(s, world, undefined, scope.reads) : [{ status: "fail", check: "write path", detail: "no dataset was generated" }]);
  } finally {
    await stop.tearDown(s);
  }
  return findings;
}

/** Everything the run is given before users sign in: claims, the hook's rows, users' values. */
export interface RunPlan {
  functions: Map<string, string>;
  claims: ClaimsPlan;
  hook: { uri: string } | undefined;
  hookPlan: HookPlan | undefined;
  /** The tables of the run, generated and fixed. */
  tables: string[];
  /** The tables the streams send and read. */
  named: string[];
  assignment: Assignment;
  /** What setUpUsers takes. */
  setUp: { scope: Parameters<typeof setUpUsers>[2]; claims: UserClaims };
}

/**
 * The run's plan from the database and the sync config: the claims the rules read, the
 * access token hook's tables and the rows run users get there, the values each user holds,
 * and the tables rows are generated for.
 */
export async function planRun(client: pg.Client, config: SyncConfig, projectDir?: string): Promise<RunPlan> {
  const streamSql = syncRules(config);
  const scope = auditScope(config.streams, config.kind);
  const policies = await rows<{ qual: string | null; with_check: string | null }>(client, "select qual, with_check from pg_policies where schemaname = 'public'");
  const functions = await policyFunctions(client);
  const claims = planClaims([...(await policyRules(client)), ...streamSql], functions);
  const hook = projectDir === undefined ? undefined : accessTokenHook(projectDir);
  // Its function, the tables it reads, and what it does on each sign-in.
  const hookPlan = hook ? await planHook(client, hook.uri, functions) : undefined;
  const named = [...new Set([...scope.synced, ...scope.reads])];
  // The literals and user comparisons in the project's own rules steer the generated data.
  const { hints, users } = sqlHints([...policies.map((x) => `${x.qual ?? ""} ${x.with_check ?? ""}`), ...streamSql.map((r) => r.sql)].join("\n"));
  // Columns compared with the user id in any spelling (auth.uid(), auth.jwt() ->> 'sub', token_parameters.user_id).
  const userColumns = new Set([...users, ...claims.identityColumns]);
  const modelOf = async (names: string[]) => readModel(client, names.map((name) => ({ name, hints, userColumns })));

  // The hook's tables with a column for a user get a row per run user, and the tables those point at a few rows.
  let fixed: FixedPlan | undefined;
  const notes: string[] = [];
  if (hookPlan?.fn && !hookPlan.cannot) {
    const candidate = await modelOf(await auditTables(client, [...named, ...hookPlan.tables]));
    const planned = fixedPlan(candidate, hookPlan.tables);
    notes.push(...planned.notes);
    if (planned.refusal) hookPlan.cannot = planned.refusal;
    else if (!planned.perUser.length) hookPlan.cannot = "no table it reads has a column pointing at auth.users";
    else fixed = planned;
  }
  const tables = await auditTables(client, [...named, ...(fixed?.perUser ?? [])]);
  const model = await modelOf(tables);
  const dims = fixed && hookPlan?.fn ? hookDims(model, fixed, hookPlan.fn.body) : [];
  // Run users' ids are minted up front, so a claim compared with a user column can hold two of
  // them, and the hook's rows can point at them.
  const userIds = runUserIds(MAX_USERS);
  const mint = () => prefixedUuid(PREFIX);
  // A uuid none of the rules name is one of the run's own (its prefix), so cleanup finds it.
  const assignment = assignClaims(claims, mint, model, userIds, dims);
  const rowsGiven = fixed ? fixedRows(model, fixed, dims, assignment.hookPicks, userIds, mint, undefined, (t) => assignment.keyPools.get(t)) : [];
  const names = new Map<string, string>();
  if (fixed) {
    for (const t of fixed.tables.filter((x) => !fixed?.perUser.includes(x))) {
      const key = model.find((m) => m.name === t)?.primaryKey[0] as string;
      for (const [i, r] of rowsGiven.filter((x) => x.table === t).entries()) names.set(String(r.row[key]), `${t} row ${i + 1}`);
    }
  }
  if (hookPlan && fixed) hookPlan.steer = { perUser: fixed.perUser, summary: steerSummary(hookPlan, fixed, dims, assignment.hookPicks, rowsGiven), names };
  if (hookPlan) hookPlan.findings.push(...notes.map((detail): Finding => ({ status: "warn", check: "access token hook", detail })));

  const scopeTables = tables.map((name) => {
    const pool = assignment.keyPools.get(name);
    return { name, hints, userColumns, claimValues: assignment.claimValues.get(name) ?? new Map(), ...(pool ? { keyPool: pool } : {}) };
  });
  // Hook claims label users too, after the metadata they were given.
  const hookPaths = claims.uses.filter((u) => u.cls === "hook").map((u) => u.path);
  return {
    functions,
    claims,
    hook,
    hookPlan,
    tables,
    named,
    assignment,
    setUp: {
      scope: {
        tables: scopeTables,
        synced: scope.synced,
        deviceTables: scope.deviceTables,
        ...(fixed ? { fixed: { tables: fixed.tables, rows: rowsGiven, ...(hook ? { hook: hook.uri } : {}), names } } : {}),
      },
      claims: {
        metadata: assignment.users.map((values) => metadataOf(assignment.paths, values)),
        paths: [...assignment.paths.map((x) => x.path), ...hookPaths],
        ids: userIds,
      },
    },
  };
}

/** the access token hook ... reads memberships: audit gives each run user but u7 one row there ... */
function steerSummary(hookPlan: HookPlan, fixed: FixedPlan, dims: Dim[], picks: (number[] | undefined)[], given: FixedRow[]): string {
  const without = picks.map((_, i) => i).filter((i) => !given.some((r) => r.user === i)).map((i) => `u${i}`);
  const varied = dims.filter((d) => d.column !== null).map((d) => (d.parent ? `${d.table}.${d.column}: ${d.options.length} ${d.parent} rows` : `${d.table}.${d.column}: ${d.options.map((o) => (typeof o === "string" ? o : String(o))).join(", ")}`));
  const parents = fixed.tables.filter((t) => !fixed.perUser.includes(t)).map((t) => `${t} gets ${given.filter((r) => r.table === t).length} rows`);
  const each = `audit gives each run user${without.length ? ` but ${without.join(" ")}` : ""} one row there before signing in${varied.length ? ` (${varied.join("; ")})` : ""}, and keeps them for the run`;
  return `the access token hook ${showUri(hookPlan.uri)} reads ${fixed.perUser.join(", ")}: ${each}${parents.length ? `; ${parents.join(", ")}` : ""}`;
}

/** Hook claims run users' tokens carry at least two values of (none counting as one): their rules can go both ways. */
export function hookKeysHeld(claims: ClaimsPlan, tokens: Map<string, Record<string, unknown>>): string[] {
  return claims.uses
    .filter((u) => u.cls === "hook")
    .filter((u) => new Set([...tokens.values()].map((t) => JSON.stringify(at(t, u.path) ?? null))).size >= 2)
    .map((u) => u.key);
}
