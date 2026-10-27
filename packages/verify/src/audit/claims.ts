/**
 * The token claims a project's rules read, found in its RLS policies (as Postgres prints
 * them, reading SQL wrapper functions two levels deep) and its sync config, and what audit can
 * do about each: a user id it already gives (identity), a value every run user shares, a
 * value audit can set (app_metadata, user_metadata), one only an access token hook adds,
 * or a read it cannot follow. Every read audit cannot set or cannot follow is reported,
 * never skipped.
 */

import type pg from "pg";
import { BODY_JOIN, type ClaimClass, type ClaimDialect, type ClaimValue, claimReads, classify, outputTable, readSupabaseConfig, type SyncConfig } from "samesight/compiler";
import { rows } from "../db.ts";
import type { Finding } from "../report.ts";
import { type Assignment, castFamily, type SetPath, show as plain, valueKeyFor } from "./assign.ts";
import { type HookPlan, showUri } from "./hook.ts";
import { SIGN_IN, signInDetail, signInKeyOf } from "./signin.ts";

/** One rule's SQL: a policy's USING or WITH CHECK, or a stream or bucket query. */
export interface RuleSql {
  where: string;
  sql: string;
  dialect: ClaimDialect;
  /** The table whose rows the rule decides: a policy's table, a query's output table. */
  table?: string;
  /** Every table the rule's query names in its FROM and joins, when known. */
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
  /** Every read casts it to a number, so its values compare as numbers ('01' and 1 are one). */
  numeric?: boolean;
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
    // A query audit cannot read (a select * across a join, say): its tables are unknown.
    return {};
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

/** Schemas Supabase itself manages: their functions are its own, not the project's. */
const SUPABASE_SCHEMAS = ["storage", "realtime", "_realtime", "graphql", "graphql_public", "vault", "pgsodium", "pgsodium_masks", "supabase_functions", "net", "pgbouncer", "cron", "supabase_migrations", "_analytics"];

/**
 * The bodies of the functions public policies call (in any schema but the system ones and
 * auth, whose token readers are read as such), and of every function the project defines
 * itself (outside the system and Supabase schemas and extensions), so a policy
 * whose function reads the token through another one is reported too. Keyed by how a call
 * names them: schema.name (policies are read with an empty search_path), and the bare name
 * for public ones; each overload also as name/min-max, the argument counts it takes, which
 * a call is matched to by its own count.
 */
export async function policyFunctions(client: pg.Client): Promise<Map<string, string>> {
  const fns = await qualified(client, () =>
    rows<{ schema: string; name: string; args: number; defaults: number; variadic: boolean; body: string | null }>(
      client,
      `select fn.nspname as schema, f.proname as name, f.pronargs as args, f.pronargdefaults as defaults, f.provariadic <> 0 as variadic,
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
      -- Overloads of one argument count by their arguments (names, then types) too, so their joined bodies keep one order.
      order by 1, 2, 3, pg_get_function_identity_arguments(f.oid)`,
    ),
  );
  const out = new Map<string, string>();
  // Each overload by the argument counts it takes (name/min-max), and the name alone for all
  // of them: their bodies together, so a call matched by name alone sees any that reads the token.
  const add = (key: string, body: string) => out.set(key, out.has(key) ? `${out.get(key)}${BODY_JOIN}${body}` : body);
  for (const f of fns) {
    if (f.body === null) continue;
    const range = `${f.args - f.defaults}-${f.variadic ? "*" : f.args}`;
    for (const name of f.schema === "public" ? [`${f.schema}.${f.name}`, f.name] : [`${f.schema}.${f.name}`]) {
      // Overloads that differ only by type take the same counts: their bodies go together.
      add(`${name}/${range}`, f.body);
      add(name, f.body);
    }
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
export function planClaims(rules: RuleSql[], functions: ReadonlyMap<string, string> = new Map(), options: { hook?: boolean } = {}): ClaimsPlan {
  // A claim Supabase Auth leaves out of a password user's token (client_id, jti) is the
  // hook's when the project enables one: only the hook could add it there.
  const classOf = (path: string[]): ClaimClass => {
    const cls = classify(path);
    return options.hook && cls === "auth-state" && path.length === 1 && SIGN_IN[signInKeyOf(claimKey(path))]?.kind === "absent" ? "hook" : cls;
  };
  const uses = new Map<string, ClaimUse>();
  const unreadable: ClaimsPlan["unreadable"] = [];
  const identityColumns = new Set<string>();
  for (const rule of rules) {
    const found = claimReads(rule.sql, rule.dialect, { functions });
    for (const u of found.unreadable) unreadable.push({ where: rule.where, ...u });
    for (const read of found.reads) {
      const key = claimKey(read.path);
      const use = uses.get(key) ?? { path: read.path, key, cls: classOf(read.path), rules: [], values: [], columns: [], columnTables: {}, other: [], casts: [], numeric: true, negated: false };
      uses.set(key, use);
      // A read compared as text or JSON ('01' is not '1' there) makes every value exact.
      const last = read.casts.at(-1);
      if (last === undefined || castFamily(last.toLowerCase()) !== "number") use.numeric = false;
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
        // Without the query's tables, a qualifier is trusted only beside a known table (a policy's own).
        const alias = q !== undefined && rule.aliases && Object.hasOwn(rule.aliases, q) ? rule.aliases[q] : undefined;
        const table =
          q === undefined ? rule.table : named === undefined ? (rule.table === undefined ? undefined : q) : (alias ?? (named.includes(q) ? q : named.length === 1 ? named[0] : undefined));
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
  for (const use of uses.values()) {
    // Read as a number everywhere: two spellings of one number are one value.
    const same = valueKeyFor(use.numeric);
    use.values = use.values.filter((v, i, all) => all.findIndex((x) => same(x) === same(v)) === i);
    use.values.sort((a, b) => valueKey(a).localeCompare(valueKey(b)));
  }
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
  hookPlan?: HookPlan,
): Finding[] {
  const out: Finding[] = [];
  const add = (status: Finding["status"], detail: string) => out.push({ status, check: "claims", detail });
  if (hook && remoteHook(hook.uri)) add("warn", `the access token hook ${showUri(hook.uri)} is not on this machine: every sign-in of a run user calls it`);
  out.push(...(hookPlan?.findings ?? []));
  if (hookPlan?.steer) {
    add("ok", hookPlan.steer.summary);
    // Rows that differ, yet tokens that do not: the hook reads something else, or cannot read them.
    const keys = plan.uses.filter((u) => u.cls === "hook");
    if (tokens && keys.length && keys.every((u) => new Set([...tokens.values()].map((t) => valueKeyFor(u.numeric)(at(t, u.path)))).size <= 1)) {
      add("warn", `every run user's token carries the same ${keys.map((u) => u.key).join(", ")}, although audit gave them different ${hookPlan.steer.perUser.join(", ")} rows; the hook may not read them`);
    }
  }
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
        add("warn", `${read}; ${signInDetail(signInKeyOf(u.key))}`);
        break;
      case "app_metadata":
      case "user_metadata": {
        const set = assignment?.paths.find((p) => p.key === u.key);
        const reason = assignment?.notSet.get(u.key);
        if (set) {
          // Generated rows hold the values in the columns compared with the claim, where they can.
          const placed = set.columns.length ? `; generated rows take them in ${set.columns.join(", ")}` : "";
          const notIn = [...set.skipped, ...set.unkeyed];
          const columns = `${placed}${notIn.length ? `; not in ${notIn.join("; ")}` : ""}`;
          // An unkeyed primary key is only a note when the values went into some column.
          const steered = set.skipped.length === 0 && (set.unkeyed.length === 0 || set.columns.length > 0);
          if (!tokens) {
            // Run user ids are minted per run: shown as whose they are.
            const given = set.users ? set.pool.map((_, i) => `u${i}'s id`) : set.pool.map(show);
            add(steered ? "ok" : "warn", `${read}; a full run gives users ${given.join(", ")}, and one user none of them (not run: --static)${columns}`);
          }
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
      case "hook": {
        const steered = hook && hookPlan?.steer ? steeredDetail(read, u, hook, hookPlan.steer, tokens) : undefined;
        if (steered) add(steered.status, steered.detail);
        else add("warn", hookDetail(read, u, hook, tokens, hookPlan));
        break;
      }
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
  const same = valueKeyFor(set.numeric);
  // Each value as audit gave it, and who holds it in any spelling the rules read alike.
  const by = new Map<string, { value: unknown; labels: string[] }>(set.pool.map((v) => [same(v), { value: v, labels: [] }]));
  const none: string[] = [];
  for (const [label, claims] of tokens) {
    const v = at(claims, set.path);
    if (v === undefined || v === null) none.push(label);
    else {
      const key = same(v);
      const held = by.get(key) ?? { value: v, labels: [] };
      held.labels.push(label);
      by.set(key, held);
    }
  }
  // A run user's id (a claim compared with a user column) shows as that user.
  const userOf = new Map([...tokens].map(([label, claims]) => [JSON.stringify(claims.sub), label]));
  const parts = [...by.values()].map(({ value, labels }) => `${userOf.has(JSON.stringify(value)) ? `${userOf.get(JSON.stringify(value))}'s id` : plain(value)} ${labels.length ? labels.join(" ") : "(nobody)"}`);
  if (none.length) parts.push(`none ${none.join(" ")}`);
  return { line: parts.join(", "), all: set.pool.every((v) => (by.get(same(v))?.labels ?? []).length > 0) };
}

/** A warning for each user whose token does not carry the value audit gave it. */
function mismatches(assignment: Assignment, tokens: Map<string, Record<string, unknown>>): Finding[] {
  const labels = [...tokens];
  return assignment.users.flatMap((values, i) => {
    const [label, claims] = labels[i] ?? [`u${i}`, {}];
    return assignment.paths.flatMap((p) => {
      const given = values.get(p.key) ?? null;
      const carried = at(claims, p.path) ?? null;
      const same = valueKeyFor(p.numeric);
      if (same(given) === same(carried)) return [];
      return [{ status: "warn" as const, check: "claims", detail: `${label} was given ${p.key}=${JSON.stringify(given)}, but its token carries ${JSON.stringify(carried)} (an auth.users trigger or the access token hook changed it); it is labelled and tested by what the token carries` }];
    });
  });
}

/** " (u0: "admin", u1: null)" when some token carries a value at the path, else undefined. */
function heldBy(tokens: Map<string, Record<string, unknown>>, path: string[]): string | undefined {
  const held = [...tokens].map(([label, claims]) => [label, at(claims, path)] as const);
  if (held.every(([, v]) => v === undefined || v === null)) return undefined;
  return ` (${held.map(([label, v]) => `${label}: ${v === undefined ? "null" : JSON.stringify(v)}`).join(", ")})`;
}

/** A claim the hook adds from the rows audit gave run users: who holds what, and which compared value none does. */
function steeredDetail(
  read: string,
  u: ClaimUse,
  hook: { uri: string },
  steer: NonNullable<HookPlan["steer"]>,
  tokens?: Map<string, Record<string, unknown>>,
): { status: Finding["status"]; detail: string } {
  const { perUser } = steer;
  const shown = showUri(hook.uri);
  if (!tokens) return { status: "ok", detail: `${read}; added by the access token hook ${shown}, which reads ${perUser.join(", ")}; a full run gives run users rows there before they sign in (not run: --static)` };
  const carried = [...tokens.values()].map((t) => at(t, u.path) ?? null);
  const same = valueKeyFor(u.numeric);
  const missing = u.values.filter((v) => !carried.some((c) => same(c) === same(v)));
  // A rule compared with a value goes both ways only if someone holds another value, or none.
  const other = carried.some((c) => !u.values.some((v) => same(v) === same(c)));
  const detail = `${read}; added by the access token hook ${shown} from rows audit gives each run user in ${perUser.join(", ")} before signing in; held: ${holders(tokens, u.path, steer.names, u.numeric)}${missing.length ? `; no token carries ${missing.map(show).join(", ")}` : ""}`;
  return { status: missing.length === 0 && other ? "ok" : "warn", detail };
}

/** What a hook-only claim means for this run, from the tokens when users have signed in. */
function hookDetail(read: string, u: ClaimUse, hook: { uri: string } | undefined, tokens?: Map<string, Record<string, unknown>>, hookPlan?: HookPlan): string {
  if (hook && hookPlan?.cannot) {
    const by = `added by the access token hook ${showUri(hook.uri)}, which audit cannot give rows to (${hookPlan.cannot})`;
    return tokens
      ? `${read}; ${by}; held: ${holders(tokens, u.path, undefined, u.numeric)}. Rules that read it are tested for these values only`
      : `${read}; ${by}. Rules that read it are tested only for the values run users' tokens carry`;
  }
  const held = tokens ? [...tokens].map(([label, claims]) => [label, at(claims, u.path)] as const) : undefined;
  const carried = held?.filter(([, v]) => v !== undefined && v !== null) ?? [];
  if (!hook) {
    if (!held) return `${read}; no Supabase token carries it unless an access token hook adds it, and supabase/config.toml enables none`;
    if (carried.length === 0) return `${read}; no run user's token carries it (and supabase/config.toml enables no access token hook), so every user reads it as null`;
  }
  const values = held ? ` (${held.map(([label, v]) => `${label}: ${v === undefined ? "null" : JSON.stringify(v)}`).join(", ")})` : "";
  const same = held && new Set(held.map(([, v]) => valueKeyFor(u.numeric)(v))).size <= 1;
  const by = hook ? `added by the access token hook ${showUri(hook.uri)}` : "carried by the run users' tokens";
  if (!held) return `${read}; ${by}, whose values audit does not choose`;
  return same
    ? `${read}; ${by}; every token carries the same value${values}. Rules that read it are tested for that value only`
    : `${read}; ${by}${values}; audit does not choose these values, so rules that read it are tested for them only`;
}

/** lead u0 u3, member u1, none u2: the users whose tokens carry each value at `path`. */
export function holders(tokens: Map<string, Record<string, unknown>>, path: string[], names: ReadonlyMap<string, string> = new Map(), numeric = false): string {
  const by = new Map<string, { value: unknown; labels: string[] }>();
  const none: string[] = [];
  const key = valueKeyFor(numeric);
  for (const [label, claims] of tokens) {
    const v = at(claims, path);
    if (v === undefined || v === null) none.push(label);
    else by.set(key(v), { value: by.get(key(v))?.value ?? v, labels: [...(by.get(key(v))?.labels ?? []), label] });
  }
  const name = (v: unknown) => (typeof v === "string" && names.has(v) ? (names.get(v) as string) : plain(v));
  return [...[...by.values()].map(({ value, labels }) => `${name(value)} ${labels.join(" ")}`), ...(none.length ? [`none ${none.join(" ")}`] : [])].join(", ");
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
