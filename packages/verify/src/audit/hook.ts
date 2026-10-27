/**
 * The access token hook supabase/config.toml enables, as audit reads it: the Postgres
 * function a pg-functions:// URI names, the public tables its body reads (and those of the
 * project functions it calls, two levels deep), what else it does on each sign-in, and
 * whether the role it runs as can read those tables. Audit gives run users rows in those
 * tables before they sign in, so the hook adds claims that differ between them.
 */

import type pg from "pg";
import { BODY_JOIN, callsIn, codeOnly, ident } from "samesight/compiler";
import { rows } from "../db.ts";
import type { Finding } from "../report.ts";

export type HookUri = { kind: "function"; schema: string; fn: string } | { kind: "remote" } | { kind: "unknown" };

/** pg-functions://<db>/<schema>/<fn>; http(s) is a hook off the database; anything else audit does not read. */
export function parseHookUri(uri: string): HookUri {
  const m = /^pg-functions:\/\/[^/]+\/([^/]+)\/([^/?#]+)$/.exec(uri.trim());
  if (m) return { kind: "function", schema: decodeURIComponent(m[1] as string), fn: decodeURIComponent(m[2] as string) };
  return /^https?:\/\//i.test(uri.trim()) ? { kind: "remote" } : { kind: "unknown" };
}

/**
 * The URI as printed: a pg-functions one in full; an http(s) one as its host alone, since a
 * user, password, path or query may hold a secret; anything else as its scheme.
 */
export function showUri(uri: string): string {
  const trimmed = uri.trim();
  if (/^pg-functions:\/\/[^@]*$/i.test(trimmed)) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) return /^[a-z][a-z0-9+.-]*:/i.exec(trimmed)?.[0].concat("...") ?? "(a hook uri audit does not read)";
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : "/..."}`;
  } catch {
    return "(an http hook)";
  }
}

/** What one body does, read leniently: comments and strings left out, names lowercased unless quoted. */
export interface BodyScan {
  /** Tables read after FROM or JOIN, as schema.name (bare names as public). */
  reads: string[];
  /** Tables written (INSERT INTO, UPDATE, DELETE FROM, MERGE INTO), as schema.name. */
  writes: string[];
  /** Functions called, as callsIn names them. */
  calls: string[];
  /** EXECUTE: SQL built at run time, which no reader of the body can follow. */
  dynamic: boolean;
  /** Metadata paths it sets in the claims (app_metadata.role, from '{app_metadata,role}' or '{claims,app_metadata,role}'), or the object. */
  metadataWrites: string[];
}

const NAME = String.raw`("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const unquote = (x: string) => (x.startsWith('"') ? x.slice(1, -1).replace(/""/g, '"') : x.toLowerCase());
/** Words that can follow UPDATE without naming a table (FOR UPDATE, DO UPDATE SET). */
const NOT_TABLES = new Set(["set", "of", "nowait", "skip", "only"]);

/** Words after a table that are no alias of it. */
const NOT_ALIASES = new Set(["where", "join", "inner", "left", "right", "full", "cross", "natural", "on", "using", "group", "order", "limit", "offset", "having", "union", "except", "intersect", "for", "into", "returning", "set", "values", "when", "then", "window", "loop", "lateral", "tablesample"]);

/**
 * schema.name after `lead`; a name followed by ( is a function (FROM json_each(...)), unless
 * `parens` (INSERT INTO t (a, b)). With `list`, the names after it too, as in FROM a x, b y.
 */
function tablesAfter(text: string, lead: string, parens = false, list = false): string[] {
  const out: string[] = [];
  const end = parens ? String.raw`(?![A-Za-z0-9_$"]|\s*\.)` : String.raw`(?![A-Za-z0-9_$"]|\s*[.(])`;
  const ref = String.raw`(?:only\s+)?${NAME}(?:\s*\.\s*${NAME})?${end}`;
  const push = (a: string, b: string | undefined) => {
    const [schema, name] = b === undefined ? ["public", unquote(a)] : [unquote(a), unquote(b)];
    if (!NOT_TABLES.has(name)) out.push(`${schema}.${name}`);
  };
  for (const m of text.matchAll(new RegExp(String.raw`(?<![A-Za-z0-9_$"])${lead}\s+${ref}`, "gi"))) {
    push(m[1] as string, m[2]);
    if (!list) continue;
    // , next [AS] alias: each table of a comma list, until something else follows.
    let at = (m.index ?? 0) + m[0].length;
    const next = new RegExp(String.raw`^(?:\s+(?:as\s+)?(${NAME.slice(1, -1)}))?\s*,\s*${ref}`, "i");
    for (;;) {
      const n = next.exec(text.slice(at));
      if (!n || (n[1] !== undefined && NOT_ALIASES.has(n[1].toLowerCase()))) break;
      push(n[2] as string, n[3]);
      at += n[0].length;
    }
  }
  return out;
}

export function scanBody(body: string): BodyScan {
  const text = codeOnly(body);
  const writes = [
    ...tablesAfter(text, "insert\\s+into", true),
    ...tablesAfter(text, "(?<!for\\s+|do\\s+|key\\s+)update"),
    ...tablesAfter(text, "delete\\s+from"),
    ...tablesAfter(text, "merge\\s+into"),
  ];
  // DELETE FROM x is no read of x: its FROM is blanked, so a read of x elsewhere still counts.
  const scanned = text.replace(/(?<![A-Za-z0-9_$"])(delete\s+)from(?![A-Za-z0-9_$"])/gi, (_, d: string) => `${d}    `);
  const reads = [...tablesAfter(scanned, "from", false, true), ...tablesAfter(scanned, "join"), ...tablesAfter(scanned, "using", false, true)];
  // Paths are string literals, which codeOnly blanks: read from the body, comments aside.
  const raw = body.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const metadataWrites = new Set<string>();
  // A path literal ('{app_metadata,role}', '{claims,app_metadata}') a function sets, not one #> reads.
  for (const m of raw.matchAll(/(#>>?\s*)?'\{\s*(?:"?claims"?\s*,\s*)?"?(app_metadata|user_metadata)"?\s*(?:,\s*"?([^,}"]+)"?)?/gi)) {
    if (m[1]) continue;
    metadataWrites.add(m[3] ? `${(m[2] as string).toLowerCase()}.${m[3].trim()}` : (m[2] as string).toLowerCase());
  }
  // A key of an object built in place: jsonb_build_object('app_metadata', ...), or '{"app_metadata": ...}'.
  for (const m of raw.matchAll(/(?<!->>?\s*)'(app_metadata|user_metadata)'\s*,|"(app_metadata|user_metadata)"\s*:/gi)) metadataWrites.add(((m[1] ?? m[2]) as string).toLowerCase());
  return {
    reads: [...new Set(reads)],
    writes: [...new Set(writes)],
    // INSERT INTO t (a, b) reads as a call of t.
    calls: callsIn(body).filter((c) => !writes.includes(c.includes(".") ? c : `public.${c}`)),
    dynamic: /(?<![A-Za-z0-9_$"])execute(?![A-Za-z0-9_$"])/i.test(text),
    metadataWrites: [...metadataWrites],
  };
}

/** Calls that reach off the database or to listeners, in any schema: each run user's sign-in makes them. */
const OUTSIDE = /^(?:\w+\.)?(?:http(?:_(?:get|post|put|patch|delete|head|request|set_curlopt|reset_curlopt|list_curlopt))?|dblink\w*|pg_notify)$|^net\.http_\w+$/;

/** The bodies a call may run: schema.name exactly; a bare name, any schema's (search_path decides). */
function bodiesOf(call: string, functions: ReadonlyMap<string, string>): string[] {
  if (call.includes(".")) return functions.has(call) ? [functions.get(call) as string] : [];
  // A public function is listed as public.f and f, with one body: each body once.
  return [...new Set([...functions].filter(([k]) => !k.includes("/") && (k === call || k.endsWith(`.${call}`))).map(([, b]) => b))];
}

/** One body's scan, the body, and the calls that led to it from the hook (none for the hook's own). */
export interface DeepScan extends BodyScan {
  body: string;
  via: string[];
}

/** The scans of a body and of the functions it calls, `levels` deep, each function once. */
export function scanDeep(body: string, functions: ReadonlyMap<string, string>, levels = 2): DeepScan[] {
  const out: DeepScan[] = [{ ...scanBody(body), body, via: [] }];
  const seen = new Set<string>();
  let frontier = (out[0]?.calls ?? []).map((call) => ({ call, via: [] as string[] }));
  for (let level = 0; level < levels && frontier.length; level++) {
    const next: typeof frontier = [];
    for (const { call, via } of frontier) {
      if (seen.has(call)) continue;
      seen.add(call);
      for (const b of bodiesOf(call, functions)) {
        const scan = { ...scanBody(b), body: b, via: [...via, call] };
        out.push(scan);
        next.push(...scan.calls.map((c) => ({ call: c, via: scan.via })));
      }
    }
    frontier = next;
  }
  return out;
}

/** The calls the deepest bodies scanned make to functions with bodies of their own: scanDeep does not follow them. */
export function unfollowed(scans: DeepScan[], functions: ReadonlyMap<string, string>, levels = 2): string[] {
  // By body, not name: team_of and public.team_of may run one body, already scanned.
  const scanned = new Set(scans.map((s) => s.body));
  const deepest = scans.filter((s) => s.via.length === levels).flatMap((s) => s.calls);
  return [...new Set(deepest.filter((c) => bodiesOf(c, functions).some((b) => !scanned.has(b))))];
}

/** A select of every column: select *, select t.*; not exists (select * ...), which reads none. */
export const SELECTS_ALL = /(?<![A-Za-z0-9_$])(?<!exists\s*\(\s*)select\s+(?:[A-Za-z_][A-Za-z0-9_$]*\.)?\*/i;

/**
 * The tables a body may select every column of, as schema.name: every table a statement with
 * a select * reads (select * into r from t, a join, t.* of one of several), not those of its
 * other statements.
 */
export function starredTables(body: string): string[] {
  return [...new Set(codeOnly(body).split(";").filter((x) => SELECTS_ALL.test(x)).flatMap((x) => scanBody(x).reads))];
}

export interface HookPlan {
  uri: string;
  /**
   * The function, when the URI names one that exists; `read`, its body and those of the
   * functions it calls, as scanned; `starred`, the public tables a function it calls reads
   * with select *, every column of which it reads.
   */
  fn?: { schema: string; name: string; body: string; read: string; starred: string[] };
  /** The role its body runs as: its owner when SECURITY DEFINER, else supabase_auth_admin. */
  role?: string;
  /** The public tables it reads, as the database names them. */
  tables: string[];
  /** Why audit cannot give run users rows the hook reads, when it cannot. */
  cannot?: string;
  findings: Finding[];
  /** When audit gives the hook rows (planRun): the tables with a row per run user, and the run's plan, said once. */
  steer?: { perUser: string[]; summary: string; names?: ReadonlyMap<string, string> };
}

const warn = (detail: string): Finding => ({ status: "warn", check: "access token hook", detail });

/** What audit makes of the hook: its function, the tables it reads, and what to warn about. */
export async function planHook(client: pg.Client, uri: string, functions: ReadonlyMap<string, string>): Promise<HookPlan> {
  const shown = showUri(uri);
  const parsed = parseHookUri(uri);
  if (parsed.kind === "remote") return { uri, tables: [], cannot: "it is an HTTP hook, which runs off this database", findings: [] };
  if (parsed.kind === "unknown") return { uri, tables: [], cannot: "audit reads only pg-functions:// hooks", findings: [] };
  const [fn] = await rows<{ oid: number; definer: boolean; owner: string; body: string | null }>(
    client,
    `select p.oid, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner,
            case when l.lanname = 'sql' then coalesce(pg_get_function_sqlbody(p.oid), p.prosrc) else p.prosrc end as body
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
      where n.nspname = $1 and p.proname = $2 and p.pronargs = 1 and p.proargtypes[0] = 'jsonb'::regtype`,
    [parsed.schema, parsed.fn],
  );
  const qualified = `${parsed.schema}.${parsed.fn}(jsonb)`;
  // As SQL: a name with capitals or other characters quoted.
  const fnSql = `${ident(parsed.schema)}.${ident(parsed.fn)}(jsonb)`;
  if (!fn || fn.body === null) {
    const cannot = `it names no function ${qualified} in the database`;
    return { uri, tables: [], cannot, findings: [warn(`the access token hook ${shown} names no function ${qualified} in the database; its claims are not steered`)] };
  }
  const findings: Finding[] = [];
  const scans = scanDeep(fn.body, functions);
  const written = new Set(scans.flatMap((s) => s.writes));
  if (scans.some((s) => s.dynamic)) findings.push(warn(`the access token hook ${shown} runs SQL it builds at run time (EXECUTE), which audit cannot read: it may read tables audit gives no rows`));
  if (written.size) findings.push(warn(`the access token hook ${shown} writes to ${[...written].join(", ")}: each run user's sign-in runs it`));
  const outside = [...new Set(scans.flatMap((s) => s.calls).filter((c) => OUTSIDE.test(c)))];
  if (outside.length) findings.push(warn(`the access token hook ${shown} calls ${outside.join(", ")}: each run user's sign-in runs it`));
  const sets = [...new Set(scans.flatMap((s) => s.metadataWrites))];
  if (sets.length) findings.push(warn(`the access token hook ${shown} sets ${sets.join(", ")} in the token, over what audit gives run users`));
  const deeper = unfollowed(scans, functions);
  if (deeper.length) findings.push(warn(`the access token hook ${shown} calls ${deeper.join(", ")} three or more calls deep, which audit does not read: ${deeper.length === 1 ? "it" : "they"} may read tables audit gives no rows`));
  // Who else may run it: Postgres grants EXECUTE on a new function to PUBLIC, and Supabase to its API roles.
  const callers = await rows<{ name: string }>(
    client,
    "select r.rolname as name from pg_roles r where r.rolname in ('anon', 'authenticated') and has_function_privilege(r.oid, $1::oid, 'execute') order by 1",
    [fn.oid],
  );
  if (callers.length) {
    findings.push(
      warn(
        `${callers.map((r) => r.name).join(", ")} can execute the access token hook ${shown} (new functions are executable by them by default): when its schema is exposed through the API, they may run it for any user id and read the claims it adds; as Supabase's guide does, grant execute on function ${fnSql} to supabase_auth_admin, then revoke execute on function ${fnSql} from public, anon, authenticated`,
      ),
    );
  }

  const [depends] = await rows<{ tables: string[] }>(
    client,
    `select coalesce(array_agg(distinct n.nspname || '.' || c.relname), '{}') as tables
       from pg_depend d join pg_class c on c.oid = d.refobjid join pg_namespace n on n.oid = c.relnamespace
      where d.classid = 'pg_proc'::regclass and d.objid = $1 and d.refclassid = 'pg_class'::regclass and c.relkind in ('r', 'p')`,
    [fn.oid],
  );
  const read = [...new Set([...(depends?.tables ?? []), ...scans.flatMap((s) => s.reads)])];
  // auth.users holds the run users already; other schemas get no rows from audit.
  const elsewhere = read.filter((t) => !t.startsWith("public.") && t !== "auth.users");
  const named = read.filter((t) => t.startsWith("public.")).map((t) => t.slice("public.".length));
  const relations = await rows<{ name: string; kind: string }>(
    client,
    `select c.relname as name, c.relkind::text as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') and c.relname = any($1) order by 1`,
    [named],
  );
  const tables = relations.filter((r) => r.kind === "r" || r.kind === "p").map((r) => r.name);
  const views = relations.filter((r) => !tables.includes(r.name)).map((r) => r.name);
  if (views.length) findings.push(warn(`the access token hook ${shown} reads ${views.join(", ")}, which ${views.length === 1 ? "is not a table" : "are not tables"} (a view, say): audit gives rows only to tables, and does not follow it to the tables beneath`));
  // Names that are no table (a CTE, a function's FROM) are dropped; another schema's tables are named.
  const known = new Set((await rows<{ name: string }>(client, "select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1)", [elsewhere])).map((r) => r.name));
  const other = elsewhere.filter((t) => known.has(t));
  if (other.length) findings.push(warn(`the access token hook ${shown} reads ${other.join(", ")}, outside public, where audit gives run users no rows`));
  const role = fn.definer ? fn.owner : "supabase_auth_admin";
  // A SECURITY DEFINER helper reads as its own owner: its tables are not checked as the hook's role.
  const calls = [...new Set(scans.flatMap((x) => x.via))];
  const definers = await rows<{ name: string; bare: string }>(
    client,
    `select n.nspname || '.' || p.proname as name, p.proname as bare from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and (n.nspname || '.' || p.proname = any($1) or p.proname = any($1))`,
    [calls],
  );
  const definer = (call: string) => definers.some((d) => (call.includes(".") ? d.name === call : d.bare === call));
  const asHook = new Set([...(depends?.tables ?? []), ...scans.filter((x) => !x.via.some(definer)).flatMap((x) => x.reads)]);
  findings.push(...(await hookAccess(client, role, tables.filter((t) => asHook.has(`public.${t}`)), shown)));
  // The hook's own select * reads every column of every table it reads (hookDims); a helper's, those of the table it selects from.
  const starred = [...new Set(scans.filter((x) => x.via.length > 0).flatMap((x) => starredTables(x.body)))].filter((t) => t.startsWith("public.")).map((t) => t.slice("public.".length));
  const plan: HookPlan = { uri, fn: { schema: parsed.schema, name: parsed.fn, body: fn.body, read: scans.map((x) => x.body).join(BODY_JOIN), starred }, role, tables, findings };
  if (!tables.length) plan.cannot = views.length ? `it reads no public table, only ${views.join(", ")}` : "its body reads no public table";
  return plan;
}

/**
 * Whether `role` can read each table: USAGE on public, a SELECT grant, and, with RLS on
 * and no bypass, a policy that lets it read. Skipped for a role that does not exist, a
 * superuser, or the owner of a table without FORCE ROW LEVEL SECURITY.
 */
export async function hookAccess(client: pg.Client, role: string, tables: string[], shown: string): Promise<Finding[]> {
  const [r] = await rows<{ bypass: boolean }>(client, "select rolsuper or rolbypassrls as bypass from pg_roles where rolname = $1", [role]);
  if (!r || !tables.length) return [];
  const [usage] = await rows<{ ok: boolean }>(client, "select has_schema_privilege($1, 'public', 'usage') as ok", [role]);
  if (!usage?.ok) return [warn(`${role} has no USAGE on schema public, so the access token hook ${shown} may find no rows for run users`)];
  const access = await rows<{ name: string; grant: boolean; rls: boolean; owner: boolean; policy: boolean }>(
    client,
    `select c.relname as name,
            has_table_privilege($1, c.oid, 'select') as grant,
            c.relrowsecurity as rls,
            pg_has_role($1, c.relowner, 'usage') and not c.relforcerowsecurity as owner,
            exists (select from pg_policy p, unnest(p.polroles) pr(oid)
                     where p.polrelid = c.oid and p.polcmd in ('r', '*') and p.polpermissive
                       and (pr.oid = 0 or pg_has_role($1, pr.oid, 'usage'))) as policy
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($2) order by 1`,
    [role, tables],
  );
  return access.flatMap((t) => {
    const why = !t.grant ? "no SELECT grant" : t.rls && !r.bypass && !t.owner && !t.policy ? "RLS is on and no policy lets it read" : undefined;
    return why ? [warn(`${role} cannot read ${t.name} (${why}), so the access token hook ${shown} may find no rows for run users`)] : [];
  });
}
