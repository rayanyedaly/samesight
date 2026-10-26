/**
 * The catalog checks that hold for any Supabase + PowerSync project, with no policy file
 * to compare against: RLS on every synced table, the policies pg_policies lists for it,
 * what anon can reach, the roles and the paths around RLS, and the publication PowerSync
 * replicates.
 */

import type pg from "pg";
import { rows } from "../db.ts";
import type { Finding } from "../report.ts";
import { checkBypasses, checkRoles } from "../static/catalog.ts";

/** The publication the PowerSync service replicates from. */
export const POWERSYNC_PUBLICATION = "powersync";

/** `reads`: tables the stream queries read without sending (joins, subqueries); they get the role and bypass checks too. */
export async function checkAuditCatalog(client: pg.Client, synced: string[], publication = POWERSYNC_PUBLICATION, reads: string[] = []): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (status: Finding["status"], check: string, detail: string) => out.push({ status, check, detail });

  const rls = await rows<{ name: string; on: boolean }>(
    client,
    `select c.relname as name, c.relrowsecurity as on
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname = any($1)`,
    [synced],
  );
  const missing = synced.filter((t) => !rls.some((r) => r.name === t));
  const off = rls.filter((r) => !r.on).map((r) => r.name);
  if (missing.length) add("fail", "row level security", `no table public.${missing.join(", public.")}, which the sync config sends`);
  if (off.length) add("fail", "row level security", `off on ${off.join(", ")}, so the REST API returns every row to anyone with a grant`);
  if (!missing.length && !off.length) add("ok", "row level security", `on for all ${synced.length} synced tables`);

  // What each table's policies are, as pg_policies lists them: the rules this audit compares with the sync config.
  const policies = await rows<{ table: string; name: string; cmd: string; roles: string[]; permissive: string }>(
    client,
    `select tablename as table, policyname as name, cmd, roles::text[] as roles, permissive
       from pg_policies where schemaname = 'public' and tablename = any($1) order by tablename, policyname`,
    [synced],
  );
  for (const t of synced.filter((t) => !missing.includes(t))) {
    const mine = policies.filter((p) => p.table === t);
    const reads = mine.filter((p) => (p.cmd === "SELECT" || p.cmd === "ALL") && p.permissive === "PERMISSIVE" && p.roles.some((r) => r === "authenticated" || r === "public"));
    const list = mine.map((p) => `"${p.name}" (${p.cmd} to ${p.roles.join(", ")}${p.permissive === "PERMISSIVE" ? "" : ", restrictive"})`).join("; ");
    if (!reads.length) add("warn", "policies", `${t}: no permissive policy lets authenticated read it, so RLS returns no row of it${list ? `; it has ${list}` : ""}`);
    else add("ok", "policies", `${t}: ${list}`);
  }

  // anon: a policy that applies to it, on a table it may select, reads rows without signing in.
  const anon = await rows<{ what: string }>(
    client,
    `select format('policy "%s" on %s applies to %s, and anon can select the table', p.policyname, p.tablename,
                   case when 'public' = any(p.roles) then 'public (anon included)' else 'anon' end) as what
       from pg_policies p
      where p.schemaname = 'public' and p.tablename = any($1) and p.cmd in ('SELECT', 'ALL')
        and ('public' = any(p.roles) or 'anon' = any(p.roles))
        and has_table_privilege('anon', format('public.%I', p.tablename), 'SELECT')`,
    [synced],
  );
  if (anon.length) for (const a of anon) add("warn", "anon", a.what);
  else add("ok", "anon", "no policy lets anon read a synced table");

  const covered = [...new Set([...synced, ...reads])];

  // A policy that calls a function reads whatever the function reads. Only SQL-standard bodies
  // record those tables; the audit generates no rows for tables an opaque body reads, so the
  // branches of the rule that depend on them go untested.
  const opaque = await rows<{ what: string }>(
    client,
    `select distinct format('policy "%s" on %s calls %s.%s', pol.polname, c.relname, fn.nspname, f.proname) as what
       from pg_policy pol
       join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = pol.oid and d.refclassid = 'pg_proc'::regclass
       join pg_proc f on f.oid = d.refobjid join pg_namespace fn on fn.oid = f.pronamespace
      where n.nspname = 'public' and c.relname = any($1) and f.prosqlbody is null
        and fn.nspname not in ('pg_catalog', 'auth', 'extensions', 'information_schema')
      order by 1`,
    [covered],
  );
  for (const o of opaque) {
    add("warn", "policies", `${o.what}, whose body the audit cannot read: the tables it reads get no generated rows unless a stream or policy names them`);
  }
  out.push(...(await checkRoles(client, covered)));
  out.push(...(await checkBypasses(client, covered)));

  // PowerSync replicates only what its publication lists.
  const pub = await rows<{ all: boolean; tables: string[]; filtered: string[]; ops: string[] }>(
    client,
    `select p.puballtables as all,
            array(select t.tablename from pg_publication_tables t where t.pubname = p.pubname and t.schemaname = 'public')::text[] as tables,
            array(select t.tablename from pg_publication_tables t where t.pubname = p.pubname and t.schemaname = 'public'
                     and (t.rowfilter is not null or cardinality(t.attnames) < (select count(*) from pg_attribute a
                          where a.attrelid = format('%I.%I', t.schemaname, t.tablename)::regclass and a.attnum > 0 and not a.attisdropped)))::text[] as filtered,
            array_remove(array[case when not p.pubinsert then 'insert' end, case when not p.pubupdate then 'update' end,
                               case when not p.pubdelete then 'delete' end, case when not p.pubtruncate then 'truncate' end], null)::text[] as ops
       from pg_publication p where p.pubname = $1`,
    [publication],
  );
  const pb = pub[0];
  if (!pb) add("fail", "publication", `no ${publication} publication, so PowerSync replicates nothing`);
  else {
    const lacking = synced.filter((t) => !pb.tables.includes(t));
    if (lacking.length) add("fail", "publication", `${publication} does not publish ${lacking.join(", ")}, so devices never receive changes to it`);
    if (pb.ops.length) add("fail", "publication", `${publication} does not publish ${pb.ops.join(", ")}, so devices keep rows the database has changed or removed`);
    const filtered = pb.filtered.filter((t) => synced.includes(t));
    if (filtered.length) add("warn", "publication", `${publication} filters rows or columns of ${filtered.join(", ")}, so devices may hold values the database has since changed`);
    if (!lacking.length && !pb.ops.length && !filtered.length) add("ok", "publication", `${publication} publishes every synced table${pb.all ? " (FOR ALL TABLES)" : ""}`);
  }
  return out;
}
