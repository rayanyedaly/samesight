/**
 * The access token hook supabase/config.toml enables, as audit reads it: the Postgres
 * function a pg-functions:// URI names, the public tables its body reads (and those of the
 * project functions it calls, two levels deep), what else it does on each sign-in, and
 * whether the role it runs as can read those tables. Audit gives run users rows in those
 * tables before they sign in, so the hook adds claims that differ between them.
 */

import type pg from "pg";
import { callsIn, codeOnly } from "samesight/compiler";
import { rows } from "../db.ts";
import type { Finding } from "../report.ts";

export type HookUri = { kind: "function"; schema: string; fn: string } | { kind: "remote" } | { kind: "unknown" };

/** pg-functions://<db>/<schema>/<fn>; http(s) is a hook off the database; anything else audit does not read. */
export function parseHookUri(uri: string): HookUri {
  const m = /^pg-functions:\/\/[^/]+\/([^/]+)\/([^/?#]+)$/.exec(uri.trim());
  if (m) return { kind: "function", schema: decodeURIComponent(m[1] as string), fn: decodeURIComponent(m[2] as string) };
  return /^https?:\/\//i.test(uri.trim()) ? { kind: "remote" } : { kind: "unknown" };
}

/** The URI as printed: an http(s) one without a user, password, query or fragment, which may hold secrets. */
export function showUri(uri: string): string {
  if (!/^https?:\/\//i.test(uri)) return uri;
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
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

/** schema.name after `lead`; a name followed by ( is a function (FROM json_each(...)), unless `parens` (INSERT INTO t (a, b)). */
function tablesAfter(text: string, lead: string, parens = false): string[] {
  const out: string[] = [];
  const end = parens ? String.raw`(?![A-Za-z0-9_$"]|\s*\.)` : String.raw`(?![A-Za-z0-9_$"]|\s*[.(])`;
  for (const m of text.matchAll(new RegExp(String.raw`(?<![A-Za-z0-9_$"])${lead}\s+(?:only\s+)?${NAME}(?:\s*\.\s*${NAME})?${end}`, "gi"))) {
    const [schema, name] = m[2] === undefined ? ["public", unquote(m[1] as string)] : [unquote(m[1] as string), unquote(m[2])];
    if (!NOT_TABLES.has(name)) out.push(`${schema}.${name}`);
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
  // DELETE FROM x reads as FROM x too: a table only written is not read.
  const deleted = new Set(tablesAfter(text, "delete\\s+from"));
  const reads = [...tablesAfter(text, "from"), ...tablesAfter(text, "join")].filter((t) => !deleted.has(t));
  // Paths are string literals, which codeOnly blanks: read from the body, comments aside.
  const raw = body.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const metadataWrites = new Set<string>();
  for (const m of raw.matchAll(/jsonb_set\s*\(\s*[^,]+,\s*'\{\s*(?:"?claims"?\s*,\s*)?"?(app_metadata|user_metadata)"?\s*(?:,\s*"?([^,}"]+)"?)?/gi)) {
    metadataWrites.add(m[2] ? `${(m[1] as string).toLowerCase()}.${m[2].trim()}` : (m[1] as string).toLowerCase());
  }
  for (const m of raw.matchAll(/jsonb_build_object\s*\(([^;]*?)\)/gi)) {
    for (const k of (m[1] as string).matchAll(/'(app_metadata|user_metadata)'\s*,/gi)) metadataWrites.add((k[1] as string).toLowerCase());
  }
  return {
    reads: [...new Set(reads)],
    writes: [...new Set(writes)],
    calls: callsIn(body),
    dynamic: /(?<![A-Za-z0-9_$"])execute(?![A-Za-z0-9_$"])/i.test(text),
    metadataWrites: [...metadataWrites],
  };
}

/** Calls that reach off the database or to listeners: each run user's sign-in makes them. */
const OUTSIDE = /^(net\.http_\w+|http(_\w+)?|extensions\.http(_\w+)?|dblink(_\w+)?|pg_notify)$/;

/** The bodies a call may run: schema.name exactly; a bare name, any schema's (search_path decides). */
function bodiesOf(call: string, functions: ReadonlyMap<string, string>): string[] {
  if (call.includes(".")) return functions.has(call) ? [functions.get(call) as string] : [];
  // A public function is listed as public.f and f, with one body: each body once.
  return [...new Set([...functions].filter(([k]) => !k.includes("/") && (k === call || k.endsWith(`.${call}`))).map(([, b]) => b))];
}

/** The scans of a body and of the functions it calls, `levels` deep, each function once. */
export function scanDeep(body: string, functions: ReadonlyMap<string, string>, levels = 2): BodyScan[] {
  const out = [scanBody(body)];
  const seen = new Set<string>();
  let frontier = out[0]?.calls ?? [];
  for (let level = 0; level < levels && frontier.length; level++) {
    const next: string[] = [];
    for (const call of frontier) {
      if (seen.has(call)) continue;
      seen.add(call);
      for (const b of bodiesOf(call, functions)) {
        const scan = scanBody(b);
        out.push(scan);
        next.push(...scan.calls);
      }
    }
    frontier = next;
  }
  return out;
}

export interface HookPlan {
  uri: string;
  /** The function, when the URI names one that exists. */
  fn?: { schema: string; name: string; body: string };
  /** The role its body runs as: its owner when SECURITY DEFINER, else supabase_auth_admin. */
  role?: string;
  /** The public tables it reads, as the database names them. */
  tables: string[];
  /** Why audit cannot give run users rows the hook reads, when it cannot. */
  cannot?: string;
  findings: Finding[];
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

  const [depends] = await rows<{ tables: string[] }>(
    client,
    `select coalesce(array_agg(distinct n.nspname || '.' || c.relname), '{}') as tables
       from pg_depend d join pg_class c on c.oid = d.refobjid join pg_namespace n on n.oid = c.relnamespace
      where d.classid = 'pg_proc'::regclass and d.objid = $1 and d.refclassid = 'pg_class'::regclass and c.relkind in ('r', 'p')`,
    [fn.oid],
  );
  const read = [...new Set([...(depends?.tables ?? []), ...scans.flatMap((s) => s.reads)])].filter((t) => !written.has(t));
  // auth.users holds the run users already; other schemas get no rows from audit.
  const elsewhere = read.filter((t) => !t.startsWith("public.") && t !== "auth.users");
  const named = read.filter((t) => t.startsWith("public.")).map((t) => t.slice("public.".length));
  const existing = await rows<{ name: string }>(
    client,
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname = any($1) order by 1`,
    [named],
  );
  const tables = existing.map((t) => t.name);
  // Names that are no table (a CTE, a function's FROM) are dropped; another schema's tables are named.
  const known = new Set((await rows<{ name: string }>(client, "select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1)", [elsewhere])).map((r) => r.name));
  const other = elsewhere.filter((t) => known.has(t));
  if (other.length) findings.push(warn(`the access token hook ${shown} reads ${other.join(", ")}, outside public, where audit gives run users no rows`));
  const role = fn.definer ? fn.owner : "supabase_auth_admin";
  findings.push(...(await hookAccess(client, role, tables, shown)));
  const plan: HookPlan = { uri, fn: { schema: parsed.schema, name: parsed.fn, body: fn.body }, role, tables, findings };
  if (!tables.length) plan.cannot = "its body reads no public table";
  return plan;
}

/**
 * Whether `role` can read each table: USAGE on public, a SELECT grant, and, with RLS on
 * and no bypass, a policy that lets it read. Skipped for a role that does not exist, a
 * superuser, or the owner of a table without FORCE ROW LEVEL SECURITY.
 */
export async function hookAccess(client: pg.Client, role: string, tables: string[], shown: string): Promise<Finding[]> {
  const [r] = await rows<{ oid: number; bypass: boolean }>(client, "select oid, rolsuper or rolbypassrls as bypass from pg_roles where rolname = $1", [role]);
  if (!r || !tables.length) return [];
  const [usage] = await rows<{ ok: boolean }>(client, "select has_schema_privilege($1, 'public', 'usage') as ok", [role]);
  if (!usage?.ok) return [warn(`${role} has no USAGE on schema public, so the access token hook ${shown} may find no rows for run users`)];
  const access = await rows<{ name: string; grant: boolean; rls: boolean; owner: boolean; policy: boolean }>(
    client,
    `select c.relname as name,
            has_table_privilege($1, c.oid, 'select') as grant,
            c.relrowsecurity as rls,
            c.relowner = $2 and not c.relforcerowsecurity as owner,
            exists (select from pg_policy p, unnest(p.polroles) pr(oid)
                     where p.polrelid = c.oid and p.polcmd in ('r', '*') and p.polpermissive
                       and (pr.oid = 0 or pg_has_role($1, pr.oid, 'member'))) as policy
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($3) order by 1`,
    [role, r.oid, tables],
  );
  return access.flatMap((t) => {
    const why = !t.grant ? "no SELECT grant" : t.rls && !r.bypass && !t.owner && !t.policy ? "RLS is on and no policy lets it read" : undefined;
    return why ? [warn(`${role} cannot read ${t.name} (${why}), so the access token hook ${shown} may find no rows for run users`)] : [];
  });
}
