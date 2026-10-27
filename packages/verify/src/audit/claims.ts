/**
 * The token claims a project's rules read, found in its RLS policies (as Postgres prints
 * them, reading SQL wrapper functions one level) and its sync config, and what audit can
 * do about each: a user id it already gives (identity), a value every run user shares, a
 * value audit can set (app_metadata, user_metadata), one only an access token hook adds,
 * or a read it cannot follow. Every read audit cannot set or cannot follow is reported,
 * never skipped.
 */

import type pg from "pg";
import { type ClaimClass, type ClaimDialect, type ClaimValue, claimReads, classify, readSupabaseConfig } from "samesight/compiler";
import { rows } from "../db.ts";
import type { Finding } from "../report.ts";

/** One rule's SQL: a policy's USING or WITH CHECK, or a stream or bucket query. */
export interface RuleSql {
  where: string;
  sql: string;
  dialect: ClaimDialect;
}

/** Everything the rules read at one claim path. */
export interface ClaimUse {
  path: string[];
  /** The path for reports: app_metadata.role. */
  key: string;
  cls: ClaimClass;
  /** The rules that read it, in order. */
  rules: string[];
  /** Literal values compared with it, deduplicated, typed as the rules type them. */
  values: ClaimValue[];
  /** Columns compared with it, by bare name. */
  columns: string[];
  /** Other comparisons, as written: audit cannot tell what value they need. */
  other: string[];
  casts: string[];
}

export interface ClaimsPlan {
  uses: ClaimUse[];
  /** Reads this cannot follow, by rule. */
  unreadable: { where: string; text: string; reason: string }[];
  /** Columns compared with the user id (sub), for the data generator. */
  identityColumns: string[];
}

/** Each public policy's USING and WITH CHECK, in a stable order. */
export async function policyRules(client: Pick<pg.Client, "query">): Promise<RuleSql[]> {
  const policies = await rows<{ table: string; name: string; qual: string | null; with_check: string | null }>(
    client as pg.Client,
    "select tablename as table, policyname as name, qual, with_check from pg_policies where schemaname = 'public' order by tablename, policyname",
  );
  return policies.flatMap((p) => [
    ...(p.qual ? [{ where: `policy "${p.name}" on ${p.table} (USING)`, sql: p.qual, dialect: "postgres" as const }] : []),
    ...(p.with_check ? [{ where: `policy "${p.name}" on ${p.table} (WITH CHECK)`, sql: p.with_check, dialect: "postgres" as const }] : []),
  ]);
}

/**
 * The bodies of the functions public policies call (outside the auth and system schemas),
 * keyed by how a policy calls them: schema.name, and the bare name for public ones, which
 * Postgres prints unqualified.
 */
export async function policyFunctions(client: Pick<pg.Client, "query">): Promise<Map<string, string>> {
  const fns = await rows<{ schema: string; name: string; body: string | null }>(
    client as pg.Client,
    `select distinct fn.nspname as schema, f.proname as name,
            case when l.lanname = 'sql' then coalesce(pg_get_function_sqlbody(f.oid), f.prosrc) else f.prosrc end as body
       from pg_policy pol
       join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = pol.oid and d.refclassid = 'pg_proc'::regclass
       join pg_proc f on f.oid = d.refobjid join pg_namespace fn on fn.oid = f.pronamespace
       join pg_language l on l.oid = f.prolang
      where n.nspname = 'public' and f.pronargs = 0
        and fn.nspname not in ('pg_catalog', 'auth', 'extensions', 'information_schema')
      order by 1, 2`,
  );
  const out = new Map<string, string>();
  for (const f of fns) {
    if (f.body === null) continue;
    out.set(`${f.schema}.${f.name}`, f.body);
    if (f.schema === "public") out.set(f.name, f.body);
  }
  return out;
}

const valueKey = (v: ClaimValue) => JSON.stringify(v);

/** What the rules read, by claim path. */
export function planClaims(rules: RuleSql[], functions: ReadonlyMap<string, string> = new Map()): ClaimsPlan {
  const uses = new Map<string, ClaimUse>();
  const unreadable: ClaimsPlan["unreadable"] = [];
  const identityColumns = new Set<string>();
  for (const rule of rules) {
    const found = claimReads(rule.sql, rule.dialect, { functions });
    for (const u of found.unreadable) unreadable.push({ where: rule.where, ...u });
    for (const read of found.reads) {
      const key = read.path.join(".");
      const use = uses.get(key) ?? { path: read.path, key, cls: classify(read.path), rules: [], values: [], columns: [], other: [], casts: [] };
      uses.set(key, use);
      if (!use.rules.includes(rule.where)) use.rules.push(rule.where);
      for (const c of read.casts) if (!use.casts.includes(c)) use.casts.push(c);
      const c = read.compared;
      if (c.kind === "literals") {
        for (const v of c.values) if (!use.values.some((x) => valueKey(x) === valueKey(v))) use.values.push(v);
      } else if (c.kind === "column") {
        if (!use.columns.includes(c.column)) use.columns.push(c.column);
        if (use.cls === "identity") identityColumns.add(c.column);
      } else if (!use.other.includes(c.text)) use.other.push(c.text);
    }
  }
  for (const use of uses.values()) use.values.sort((a, b) => valueKey(a).localeCompare(valueKey(b)));
  return { uses: [...uses.values()].sort((a, b) => a.key.localeCompare(b.key)), unreadable, identityColumns: [...identityColumns].sort() };
}

/** The project's custom access token hook, from supabase/config.toml; undefined when none is enabled. */
export function accessTokenHook(projectDir: string): { uri: string } | undefined {
  const hook = readSupabaseConfig(projectDir)?.get("auth.hook.custom_access_token");
  return hook?.get("enabled") === "true" ? { uri: hook.get("uri") ?? "(no uri)" } : undefined;
}

/** A remote hook (http or https) runs on every sign-in, off this machine. */
export function remoteHook(uri: string): boolean {
  const m = /^https?:\/\/([^/:]+)/i.exec(uri);
  return m !== null && !/^(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)$/i.test(m[1] ?? "");
}

const show = (v: ClaimValue) => (typeof v === "string" ? `'${v}'` : String(v));
const rulesOf = (u: ClaimUse) => (u.rules.length === 1 ? (u.rules[0] as string) : `${u.rules.length} rules (${u.rules.join("; ")})`);

/**
 * The Claims section. `tokens` are the run users' decoded token claims, by label, when
 * users have signed in; without them (--static) nothing is said about what tokens carry.
 */
export function claimFindings(plan: ClaimsPlan, hook: { uri: string } | undefined, tokens?: Map<string, Record<string, unknown>>): Finding[] {
  const out: Finding[] = [];
  const add = (status: Finding["status"], detail: string) => out.push({ status, check: "claims", detail });
  if (hook && remoteHook(hook.uri)) add("warn", `the access token hook ${hook.uri} is not on this machine: every sign-in of a run user calls it`);
  for (const u of plan.uses) {
    const compared = [
      ...(u.values.length ? [`compared with ${u.values.map(show).join(", ")}`] : []),
      ...(u.columns.length ? [`compared with column ${u.columns.join(", ")}`] : []),
      ...(u.other.length ? [`used as ${u.other.join("; ")}`] : []),
    ].join("; ");
    const read = `${u.key}: read by ${rulesOf(u)}${compared ? `, ${compared}` : ""}`;
    switch (u.cls) {
      case "identity":
        break;
      case "shared":
        if (u.other.length === 0 && u.columns.length === 0 && u.values.every((v) => v === "authenticated" && u.key !== "iss")) {
          add("ok", `${read}; every run user is authenticated, so it holds for all of them`);
        } else add("warn", `${read}; every run user carries the same ${u.key}, so a rule that tells users apart by it is tested for that value only`);
        break;
      case "auth-state":
        add("warn", `${read}; every run user is a password user at aal1 with no other sign-in state, so rules reading ${u.key} are tested for that state only`);
        break;
      case "app_metadata":
      case "user_metadata":
        add("warn", `${read}; run users do not carry ${u.key}, so every user reads it as null`);
        break;
      case "hook":
        add("warn", hookDetail(read, u, hook, tokens));
        break;
      case "object":
        add("warn", `${read}; it reads ${u.key || "the whole token"} as one value, which audit cannot give users`);
        break;
    }
  }
  for (const x of plan.unreadable) add("warn", `${x.where} ${x.reason}: ${x.text}; audit cannot tell which claim or value it needs`);
  if (out.length === 0) add("ok", "no rule reads a token claim other than the user id");
  return out;
}

/** What a hook-only claim means for this run, from the tokens when users have signed in. */
function hookDetail(read: string, u: ClaimUse, hook: { uri: string } | undefined, tokens?: Map<string, Record<string, unknown>>): string {
  const held = tokens ? [...tokens].map(([label, claims]) => [label, at(claims, u.path)] as const) : undefined;
  const carried = held?.filter(([, v]) => v !== undefined && v !== null) ?? [];
  if (!hook) {
    if (!held) return `${read}; no Supabase token carries it unless an access token hook adds it, and supabase/config.toml enables none`;
    if (carried.length === 0) return `${read}; no run user's token carries it (and supabase/config.toml enables no access token hook), so every user reads it as null`;
  }
  const values = held ? ` (${held.map(([label, v]) => `${label}: ${v === undefined ? "null" : JSON.stringify(v)}`).join(", ")})` : "";
  const same = held && new Set(held.map(([, v]) => JSON.stringify(v ?? null))).size <= 1;
  const by = hook ? `added by the access token hook ${hook.uri}` : "carried by the run users' tokens";
  if (!held) return `${read}; ${by}. Users sign in before any rows are generated, so the hook sees none; steering hook claims is planned (B3b)`;
  return same
    ? `${read}; ${by}; users signed in before any rows were generated, so every token carries the same value${values}. Rules that read it are tested for that value only; steering hook claims is planned (B3b)`
    : `${read}; ${by}${values}; audit does not choose these values, so rules that read it are tested for them only`;
}

/** The value at a path in decoded token claims. */
export function at(claims: Record<string, unknown>, path: string[]): unknown {
  let x: unknown = claims;
  for (const k of path) {
    if (x === null || typeof x !== "object") return undefined;
    x = (x as Record<string, unknown>)[k];
  }
  return x;
}
