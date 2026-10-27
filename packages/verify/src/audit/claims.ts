/**
 * The token claims a project's rules read, found in its RLS policies (as Postgres prints
 * them, reading SQL wrapper functions one level) and its sync config, and what audit can
 * do about each: a user id it already gives (identity), a value every run user shares, a
 * value audit can set (app_metadata, user_metadata), one only an access token hook adds,
 * or a read it cannot follow. Every read audit cannot set or cannot follow is reported,
 * never skipped.
 */

import type pg from "pg";
import { type ClaimClass, type ClaimDialect, type ClaimValue, claimReads, classify, outputTable, readSupabaseConfig, type SyncConfig, tablesNamed } from "samesight/compiler";
import { rows } from "../db.ts";
import type { Finding } from "../report.ts";
import { type Assignment, type SetPath, show as plain } from "./assign.ts";

/** One rule's SQL: a policy's USING or WITH CHECK, or a stream or bucket query. */
export interface RuleSql {
  where: string;
  sql: string;
  dialect: ClaimDialect;
  /** The table whose rows the rule decides: a policy's table, a query's output table. */
  table?: string;
  /** Every table the rule's query names at its top level (a join's too), when known. */
  tables?: string[];
  /** The query's table aliases (o in JOIN orgs o), when known. */
  aliases?: Record<string, string>;
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
  /** Per column, the tables of the rules that compare it, where known. */
  columnTables: Record<string, string[]>;
  /** Other comparisons, as written: audit cannot tell what value they need. */
  other: string[];
  casts: string[];
  /** Some rule holds when the claim is not one of its values (<>, NOT IN, IS NOT TRUE). */
  negated: boolean;
}

export interface ClaimsPlan {
  uses: ClaimUse[];
  /** Reads this cannot follow, by rule. */
  unreadable: { where: string; text: string; reason: string }[];
  /** Columns compared with the user id (sub), for the data generator. */
  identityColumns: string[];
}

/**
 * Runs catalog reads with an empty search_path, so Postgres prints every function with its
 * schema (auth.jwt(), not a bare jwt() when auth happens to be on the path).
 */
export async function qualified<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  const { rows: current } = await client.query<{ path: string }>("select pg_catalog.current_setting('search_path') as path");
  await client.query("select pg_catalog.set_config('search_path', '', false)");
  const restore = () => client.query("select pg_catalog.set_config('search_path', $1, false)", [current[0]?.path ?? ""]);
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    // The read's own error is the one to report, even when restoring fails after it.
    await restore().catch(() => {});
    throw e;
  }
  await restore();
  return result;
}

/** Each stream's CTEs and queries, or each bucket's parameter and data queries. */
export function syncRules(config: SyncConfig): RuleSql[] {
  const dialect = config.kind === "streams" ? "streams" : "rules";
  return config.streams.flatMap((st) => [
    ...[...st.ctes].map(([name, sql]) => ({ where: `${st.name}.${name}`, sql, dialect }) as const),
    ...st.queries.map((q) => ({ where: `${st.name}.${q.label}`, sql: q.sql, dialect, ...outputOf(q.sql) }) as const),
  ]);
}

function outputOf(sql: string): { table?: string; tables?: string[]; aliases?: Record<string, string> } {
  try {
    const out = outputTable(sql);
    return { table: out.table, tables: out.reads, aliases: out.aliases };
  } catch {
    // Audit refuses a query it cannot read (an aliased output table, say); its tables are still worth knowing.
    try {
      const named = tablesNamed(sql);
      return named.length === 1 ? { tables: named } : {};
    } catch {
      return {};
    }
  }
}

/** Each public policy's USING and WITH CHECK, in a stable order. */
export async function policyRules(client: pg.Client): Promise<RuleSql[]> {
  const policies = await qualified(client, () =>
    rows<{ table: string; name: string; qual: string | null; with_check: string | null }>(
      client,
      "select tablename as table, policyname as name, qual, with_check from pg_catalog.pg_policies where schemaname = 'public' order by tablename, policyname",
    ),
  );
  return policies.flatMap((p) => [
    ...(p.qual ? [{ where: `policy "${p.name}" on ${p.table} (USING)`, sql: p.qual, dialect: "postgres" as const, table: p.table }] : []),
    ...(p.with_check ? [{ where: `policy "${p.name}" on ${p.table} (WITH CHECK)`, sql: p.with_check, dialect: "postgres" as const, table: p.table }] : []),
  ]);
}

/**
 * The bodies of the functions public policies call (in any schema but the system ones and
 * auth, whose token readers are read as such), and of every function the project defines
 * itself (outside the system and Supabase schemas and extensions), so a policy
 * whose function reads the token through another one is reported too. Keyed by how a call
 * names them: schema.name (policies are read with an empty search_path), and the bare name
 * for public ones. Functions with arguments are listed, so a call that reads the token is
 * reported even though it is not read through; of overloads, the one with no arguments
 * (the only kind read through) wins the key.
 */
/** Schemas Supabase itself manages: their functions are its own, not the project's. */
const SUPABASE_SCHEMAS = ["storage", "realtime", "_realtime", "graphql", "graphql_public", "vault", "pgsodium", "pgsodium_masks", "supabase_functions", "net", "pgbouncer", "cron", "supabase_migrations", "_analytics"];

export async function policyFunctions(client: pg.Client): Promise<Map<string, string>> {
  const fns = await qualified(client, () =>
    rows<{ schema: string; name: string; args: number; body: string | null }>(
      client,
      `select fn.nspname as schema, f.proname as name, f.pronargs as args,
            case when l.lanname = 'sql' then coalesce(pg_get_function_sqlbody(f.oid), f.prosrc) else f.prosrc end as body
       from pg_proc f join pg_namespace fn on fn.oid = f.pronamespace join pg_language l on l.oid = f.prolang
      where f.prokind = 'f'
        and fn.nspname not in ('pg_catalog', 'auth', 'information_schema')
        and (f.oid in (select d.refobjid
                         from pg_policy pol
                         join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
                         join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = pol.oid and d.refclassid = 'pg_proc'::regclass
                        where n.nspname = 'public')
             or (not starts_with(fn.nspname, 'pg_')
                 and fn.nspname not in ('extensions', ${SUPABASE_SCHEMAS.map((x) => `'${x}'`).join(", ")})
                 and not exists (select from pg_depend e where e.classid = 'pg_proc'::regclass and e.objid = f.oid and e.deptype = 'e')))
      order by 1, 2, 3 desc`,
    ),
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

/**
 * A claim path as reports name it: app_metadata.role. A key that is not a plain name is
 * quoted, so the top-level key "app_metadata.role" (auth.parameter('app_metadata.role'))
 * is never taken for the role inside app_metadata.
 */
export const claimKey = (path: readonly string[]) => path.map((k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k))).join(".");

/** What the rules read, by claim path. */
export function planClaims(rules: RuleSql[], functions: ReadonlyMap<string, string> = new Map()): ClaimsPlan {
  const uses = new Map<string, ClaimUse>();
  const unreadable: ClaimsPlan["unreadable"] = [];
  const identityColumns = new Set<string>();
  for (const rule of rules) {
    const found = claimReads(rule.sql, rule.dialect, { functions });
    for (const u of found.unreadable) unreadable.push({ where: rule.where, ...u });
    for (const read of found.reads) {
      const key = claimKey(read.path);
      const use = uses.get(key) ?? { path: read.path, key, cls: classify(read.path), rules: [], values: [], columns: [], columnTables: {}, other: [], casts: [], negated: false };
      uses.set(key, use);
      if (!use.rules.includes(rule.where)) use.rules.push(rule.where);
      for (const c of read.casts) if (!use.casts.includes(c)) use.casts.push(c);
      const c = read.compared;
      if (c.kind === "literals") {
        if (c.negated) use.negated = true;
        for (const v of c.values) if (!use.values.some((x) => valueKey(x) === valueKey(v))) use.values.push(v);
      } else if (c.kind === "column") {
        if (!use.columns.includes(c.column)) use.columns.push(c.column);
        // A column in a subquery is another table's: only the rule's own table is known, or
        // the table a qualifier names (a join's; an alias names no table, so it matches none).
        // An alias (documents d) is no table name: with one table it is that table's, else unknown.
        const named = rule.tables;
        const q = c.qualifier;
        const table =
          q === undefined || named === undefined ? (q ?? rule.table) : (rule.aliases?.[q] ?? (named.includes(q) ? q : named.length === 1 ? named[0] : undefined));
        if (table !== undefined && !read.inSubquery) {
          const tables = use.columnTables[c.column] ?? [];
          use.columnTables[c.column] = tables;
          if (!tables.includes(table)) tables.push(table);
        }
        // By bare name, as the generator applies them (a membership table's user_id in a
        // subquery included); it never gives user ids to a primary or foreign key.
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
  const m = /^https?:\/\/(\[[^\]]*\]|[^/:]+)/i.exec(uri);
  return m !== null && !/^(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)$/i.test(m[1] ?? "");
}

const show = (v: ClaimValue) => (typeof v === "string" ? `'${v}'` : String(v));
const rulesOf = (u: ClaimUse) => (u.rules.length === 1 ? (u.rules[0] as string) : `${u.rules.length} rules (${u.rules.join("; ")})`);

/**
 * The Claims section. `tokens` are the run users' decoded token claims, by label (u0, u1),
 * in user order, when users have signed in; without them (--static) nothing is said about
 * what tokens carry. `assignment` is what the run gives users in their metadata.
 */
export function claimFindings(
  plan: ClaimsPlan,
  hook: { uri: string } | undefined,
  tokens?: Map<string, Record<string, unknown>>,
  assignment?: Assignment,
): Finding[] {
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
        if (!u.negated && u.other.length === 0 && u.columns.length === 0 && u.values.every((v) => v === "authenticated" && u.key !== "iss")) {
          add("ok", `${read}; every run user is authenticated, so it holds for all of them`);
        } else add("warn", `${read}; every run user carries the same ${u.key}, so a rule that tells users apart by it is tested for that value only`);
        break;
      case "auth-state":
        add("warn", `${read}; ${AUTH_STATE[u.key] ?? `every run user is a password user at aal1 with no other sign-in state, so rules reading ${u.key} are tested for that state only`}`);
        break;
      case "app_metadata":
      case "user_metadata": {
        const set = assignment?.paths.find((p) => p.key === u.key);
        const reason = assignment?.notSet.get(u.key);
        if (set) {
          // Generated rows hold the values in the columns compared with the claim, where they can.
          const placed = set.columns.length ? `; generated rows take them in ${set.columns.join(", ")}` : "";
          const columns = `${placed}${set.skipped.length ? `; not in ${set.skipped.join("; ")}` : ""}`;
          const steered = set.skipped.length === 0;
          if (!tokens) add(steered ? "ok" : "warn", `${read}; a full run gives users ${set.pool.map(show).join(", ")}, and one user none of them (not run: --static)${columns}`);
          else {
            const { line, all } = heldLine(tokens, set);
            add(all && steered ? "ok" : "warn", `${read}; held: ${line}${columns}`);
          }
          break;
        }
        if (reason) {
          add("warn", `${read}; not set: ${reason}`);
          break;
        }
        const values = tokens ? heldBy(tokens, u.path) : undefined;
        add("warn", values ? `${read}; the run users' tokens carry it, though audit did not set it${values}` : `${read}; run users do not carry ${u.key}, so every user reads it as null`);
        break;
      }
      case "hook":
        add("warn", hookDetail(read, u, hook, tokens));
        break;
      case "object":
        add("warn", `${read}; it reads ${u.key || "the whole token"} as one value, which audit cannot give users`);
        break;
    }
  }
  if (assignment) {
    out.push(...assignment.findings);
    if (tokens) out.push(...mismatches(assignment, tokens));
  }
  for (const x of plan.unreadable) add("warn", `${x.where} ${x.reason}: ${x.text}; audit cannot tell which claim or value it needs`);
  if (out.length === 0) add("ok", "no rule reads a token claim other than the user id");
  return out;
}

/** admin u0 u3, editor u1, samesight-other u2, none u4: who holds each value, from the tokens. */
function heldLine(tokens: Map<string, Record<string, unknown>>, set: SetPath): { line: string; all: boolean } {
  const by = new Map<string, string[]>(set.pool.map((v) => [JSON.stringify(v), []]));
  const none: string[] = [];
  for (const [label, claims] of tokens) {
    const v = at(claims, set.path);
    if (v === undefined || v === null) none.push(label);
    else {
      const key = JSON.stringify(v);
      by.set(key, [...(by.get(key) ?? []), label]);
    }
  }
  const parts = [...by].map(([v, labels]) => `${plain(JSON.parse(v))} ${labels.length ? labels.join(" ") : "(nobody)"}`);
  if (none.length) parts.push(`none ${none.join(" ")}`);
  return { line: parts.join(", "), all: set.pool.every((v) => (by.get(JSON.stringify(v)) ?? []).length > 0) };
}

/** A warning for each user whose token does not carry the value audit gave it. */
function mismatches(assignment: Assignment, tokens: Map<string, Record<string, unknown>>): Finding[] {
  const labels = [...tokens];
  return assignment.users.flatMap((values, i) => {
    const [label, claims] = labels[i] ?? [`u${i}`, {}];
    return assignment.paths.flatMap((p) => {
      const given = values.get(p.key) ?? null;
      const carried = at(claims, p.path) ?? null;
      if (JSON.stringify(given) === JSON.stringify(carried)) return [];
      return [{ status: "warn" as const, check: "claims", detail: `${label} was given ${p.key}=${JSON.stringify(given)}, but its token carries ${JSON.stringify(carried)} (an auth.users trigger or the access token hook changed it); it is labelled and tested by what the token carries` }];
    });
  });
}

/** Auth-state claims that differ per user, or that no run user has. */
const AUTH_STATE: Record<string, string> = {
  email: "each run user has its own email, which audit does not put in generated rows, so rules matching it are tested on rows that do not match it",
  session_id: "each sign-in has its own session_id, which audit does not put in generated rows, so rules matching it are tested on rows that do not match it",
  phone: "run users have no phone: every token carries an empty one",
};

/** " (u0: "admin", u1: null)" when some token carries a value at the path, else undefined. */
function heldBy(tokens: Map<string, Record<string, unknown>>, path: string[]): string | undefined {
  const held = [...tokens].map(([label, claims]) => [label, at(claims, path)] as const);
  if (held.every(([, v]) => v === undefined || v === null)) return undefined;
  return ` (${held.map(([label, v]) => `${label}: ${v === undefined ? "null" : JSON.stringify(v)}`).join(", ")})`;
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
