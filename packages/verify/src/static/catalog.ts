/**
 * What the database actually enforces, read from the catalog and compared with the
 * policy's manifest (samesight/manifest.json):
 *   - row level security is on for every policy table and samesight."RejectedWrite";
 *   - exactly the generated policies exist on those tables, with the generated command,
 *     roles and mode (their bodies are compared by the catalog parity check);
 *   - anon and authenticated bypass nothing: no BYPASSRLS, no role membership, no table
 *     they own;
 *   - nothing reaches anon: no policy, table or column privilege (inherited and PUBLIC
 *     included), or generated function;
 *   - no view anon or authenticated can select reads a protected table, at any depth,
 *     through a view that runs with its owner's rights; SECURITY DEFINER functions they
 *     can call are listed;
 *   - only supabase_auth_admin can run the access token hook;
 *   - the publication lists exactly the synced tables, unfiltered, and publishes deletes;
 *   - append-only tables carry their triggers, enabled for normal sessions.
 */

import type pg from "pg";
import { ident } from "samesight/compiler";
import { rows } from "../db.ts";
import type { Finding } from "../report.ts";
import type { Manifest } from "./manifest.ts";

const OPS = { read: "SELECT", insert: "INSERT", update: "UPDATE", delete: "DELETE" } as const;
const HOOK = "samesight.custom_access_token_hook(jsonb)";
/** The functions the generator writes in public, where PostgREST exposes them. */
export const PUBLIC_FUNCTIONS = ["apply_batch", "record_rejection"];
/** Schemas Supabase manages; their definer functions are not the project's to review. */
const PLATFORM = [
  "pg_catalog",
  "information_schema",
  "auth",
  "storage",
  "extensions",
  "graphql",
  "graphql_public",
  "realtime",
  "vault",
  "pgbouncer",
  "supabase_functions",
  "net",
  "cron",
  "pgsodium",
  "pgsodium_masks",
  "supabase_migrations",
];
/** The policy tables plus samesight."RejectedWrite", as a condition on c and n; $1 is the policy table names. */
const PROTECTED = `((n.nspname = 'public' and c.relname = any($1)) or (n.nspname = 'samesight' and c.relname = 'RejectedWrite'))`;
/** A schema anon or authenticated can reach (PostgREST, pg_graphql, or any SQL path). */
const REACHABLE = (ns: string) => `(has_schema_privilege('anon', ${ns}.oid, 'USAGE') or has_schema_privilege('authenticated', ${ns}.oid, 'USAGE'))`;
/** A relation that reads its sources with its owner's rights: a materialized view, or a view without security_invoker. */
const OWNER_RIGHTS = (c: string) =>
  `(${c}.relkind = 'm' or (${c}.relkind = 'v' and not exists (select 1 from unnest(coalesce(${c}.reloptions, '{}')) o
     where lower(replace(o, ' ', '')) in ('security_invoker=true', 'security_invoker=on', 'security_invoker=yes', 'security_invoker=1'))))`;

interface ExpectedPolicy {
  cmd: string;
  roles: string[];
}

/** The policies the generator writes for a manifest: name, command and roles. */
export function expectedPolicies(m: Manifest): Map<string, Map<string, ExpectedPolicy>> {
  const out = new Map<string, Map<string, ExpectedPolicy>>();
  for (const t of m.tables) {
    const policies = new Map<string, ExpectedPolicy>();
    for (const [op, cmd] of Object.entries(OPS) as [keyof typeof OPS, string][]) {
      if (Object.keys(t[op]).length > 0) policies.set(`${t.name}: ${op}`, { cmd, roles: ["authenticated"] });
    }
    out.set(t.name, policies);
  }
  out.get(m.membership.table)?.set(`${m.membership.table}: auth hook reads`, { cmd: "SELECT", roles: ["supabase_auth_admin"] });
  return out;
}

export async function checkCatalog(client: pg.Client, m: Manifest, publication: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (status: Finding["status"], check: string, detail: string) => out.push({ status, check, detail });
  const names = m.tables.map((t) => t.name);
  const synced = m.tables.filter((t) => Object.keys(t.read).length > 0).map((t) => t.name);

  // Row level security.
  const rls = await rows<{ name: string; on: boolean }>(
    client,
    `select n.nspname || '.' || c.relname as name, c.relrowsecurity as on
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where (n.nspname = 'public' and c.relname = any($1)) or (n.nspname = 'samesight' and c.relname = 'RejectedWrite')`,
    [names],
  );
  const missing = [...names.map((n) => `public.${n}`), "samesight.RejectedWrite"].filter((n) => !rls.some((r) => r.name === n));
  const off = rls.filter((r) => !r.on).map((r) => r.name);
  if (missing.length) add("fail", "row level security", `missing tables: ${missing.join(", ")}`);
  if (off.length) add("fail", "row level security", `off on ${off.join(", ")}`);
  if (!missing.length && !off.length) add("ok", "row level security", `on for all ${rls.length} tables`);

  // Policies: the generated set, by name, marker, command, roles and mode.
  const policies = await rows<{ table: string; name: string; cmd: string; roles: string[]; permissive: boolean; marked: boolean }>(
    client,
    `select c.relname as table, p.polname as name,
            case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
            array(select case when r = 0 then 'public' else (select rolname from pg_roles where oid = r) end
                    from unnest(p.polroles) r order by 1)::text[] as roles,
            p.polpermissive as permissive,
            coalesce(obj_description(p.oid, 'pg_policy') = 'samesight', false) as marked
       from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1)`,
    [names],
  );
  const expected = expectedPolicies(m);
  const problems: string[] = [];
  for (const [table, want] of expected) {
    const have = policies.filter((p) => p.table === table);
    for (const [name, spec] of want) {
      const p = have.find((x) => x.name === name);
      if (!p?.marked) problems.push(`${table} lacks "${name}"`);
      else if (p.cmd !== spec.cmd || p.roles.join() !== spec.roles.join() || !p.permissive) {
        problems.push(`"${name}" is ${p.permissive ? "" : "restrictive, "}for ${p.cmd} to ${p.roles.join(", ")}; the policy generates it for ${spec.cmd} to ${spec.roles.join(", ")}`);
      }
    }
    for (const p of have) {
      if (want.has(p.name)) continue;
      const effect = p.permissive ? "a permissive policy widens RLS" : "a restrictive policy narrows RLS below what devices sync";
      problems.push(`${table} has "${p.name}"${p.marked ? "" : " (hand-written)"}, which the policy does not generate; ${effect}`);
    }
  }
  if (problems.length) for (const p of problems) add("fail", "policies", p);
  else add("ok", "policies", `exactly the ${[...expected.values()].reduce((n, s) => n + s.size, 0)} generated policies, by name, command and role`);

  out.push(...(await checkRoles(client, names)));

  // anon: nothing at all, inherited and PUBLIC grants included.
  const anon = await rows<{ what: string }>(
    client,
    `select format('policy "%s" on %s applies to %s', p.polname, c.relname,
                   case when 0 = any(p.polroles) then 'public (anon included)' else 'anon' end) as what
       from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'samesight')
        and (0 = any(p.polroles) or (select oid from pg_roles where rolname = 'anon') = any(p.polroles))
     union all
     select format('anon has a table privilege on %s', c.relname)
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where ${PROTECTED}
        and has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     union all
     select format('anon has a column privilege on %s', c.relname)
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where ${PROTECTED}
        and not has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
        and has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
     union all
     select format('anon can execute %s', p.oid::regprocedure) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname = 'samesight' or (n.nspname = 'public' and p.proname = any($2)))
        and has_function_privilege('anon', p.oid, 'execute')`,
    [names, PUBLIC_FUNCTIONS],
  );
  if (anon.length) for (const a of anon) add("fail", "anon", a.what);
  else add("ok", "anon", "no policy, grant or generated function reaches anon");

  out.push(...(await checkBypasses(client, names)));

  // The access token hook.
  const hook = await rows<{ exists: boolean; auth_admin: boolean | null; others: string[] | null }>(
    client,
    `select to_regprocedure($1) is not null as exists,
            case when to_regprocedure($1) is null then null
                 else has_function_privilege('supabase_auth_admin', to_regprocedure($1), 'execute') end as auth_admin,
            case when to_regprocedure($1) is null then null
                 else array(select r from unnest(array['anon', 'authenticated', 'service_role']) r
                             where has_function_privilege(r, to_regprocedure($1), 'execute')) end as others`,
    [HOOK],
  );
  const h = hook[0];
  if (!h?.exists) add("fail", "token hook", `${HOOK} does not exist`);
  else if (!h.auth_admin) add("fail", "token hook", "supabase_auth_admin cannot execute it, so tokens carry no tenant");
  else if (h.others?.length) add("fail", "token hook", `${h.others.join(", ")} can execute it and forge claims for any user`);
  else add("ok", "token hook", "only supabase_auth_admin can execute it");

  // Publication: an explicit, unfiltered list of exactly the synced tables, deletes included.
  const pub = await rows<{ all: boolean; insert: boolean; update: boolean; delete: boolean; tables: string[]; filtered: string[] }>(
    client,
    `select p.puballtables as all, p.pubinsert as insert, p.pubupdate as update, p.pubdelete as delete,
            array(select t.schemaname || '.' || t.tablename from pg_publication_tables t where t.pubname = p.pubname)::text[] as tables,
            array(select pr.prrelid::regclass::text from pg_publication_rel pr
                   where pr.prpubid = p.oid and (pr.prqual is not null or pr.prattrs is not null))::text[] as filtered
       from pg_publication p where p.pubname = $1`,
    [publication],
  );
  const pb = pub[0];
  if (!pb) add("fail", "publication", `${publication} does not exist`);
  else if (pb.all) add("fail", "publication", `${publication} is FOR ALL TABLES; list the synced tables`);
  else {
    const want = synced.map((n) => `public.${n}`);
    const extra = pb.tables.filter((t) => !want.includes(t));
    const lacking = want.filter((t) => !pb.tables.includes(t));
    const ops = (["insert", "update", "delete"] as const).filter((op) => !pb[op]);
    if (extra.length) add("fail", "publication", `also publishes ${extra.join(", ")}, which no policy covers`);
    if (lacking.length) add("fail", "publication", `missing ${lacking.join(", ")}`);
    if (ops.length) add("fail", "publication", `does not publish ${ops.join(", ")}, so devices keep rows the database has changed or removed`);
    if (pb.filtered.length) add("fail", "publication", `filters rows or columns of ${pb.filtered.join(", ")}; the sync config is the only filter`);
    if (!extra.length && !lacking.length && !ops.length && !pb.filtered.length) {
      add("ok", "publication", `${publication} lists exactly the ${want.length} synced tables, unfiltered`);
    }
  }

  // Append-only triggers, firing in normal sessions ('O' origin, 'A' always; not 'R' or 'D').
  const appendOnly = m.tables.filter((t) => t.appendOnly).map((t) => t.name);
  if (appendOnly.length) {
    const triggers = await rows<{ table: string; name: string; enabled: string; def: string }>(
      client,
      `select c.relname as table, t.tgname as name, t.tgenabled as enabled, pg_get_triggerdef(t.oid) as def
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1) and not t.tgisinternal`,
      [appendOnly],
    );
    // As pg_get_triggerdef prints the generated triggers: no WHEN, no column list.
    const want = (table: string) => [
      { name: `${table}_append_only`, events: "BEFORE DELETE OR UPDATE", level: "ROW" },
      { name: `${table}_no_truncate`, events: "BEFORE TRUNCATE", level: "STATEMENT" },
    ];
    const bad = appendOnly.flatMap((table) =>
      want(table).flatMap(({ name, events, level }) => {
        const t = triggers.find((x) => x.table === table && x.name === name);
        if (!t) return [`${name} is missing`];
        if (t.enabled !== "O" && t.enabled !== "A") return [`${name} does not fire in normal sessions (tgenabled ${t.enabled})`];
        const def = `CREATE TRIGGER ${ident(name)} ${events} ON public.${ident(table)} FOR EACH ${level} EXECUTE FUNCTION samesight.reject_mutation()`;
        if (t.def !== def) {
          return [`${name} is not the generated trigger: ${t.def}`];
        }
        return [];
      }),
    );
    if (bad.length) for (const b of bad) add("fail", "append-only", b);
    else add("ok", "append-only", `${appendOnly.join(", ")} reject updates, deletes and truncates`);
  }
  return out;
}

/** anon and authenticated: no SUPERUSER or BYPASSRLS, no other role's privileges, no protected table owned. */
export async function checkRoles(client: pg.Client, names: string[]): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (status: Finding["status"], check: string, detail: string) => out.push({ status, check, detail });
  // Roles: RLS binds anon and authenticated only if they bypass nothing.
  const roles = await rows<{ what: string }>(
    client,
    `select format('%s has %s', rolname, concat_ws(' and ', case when rolsuper then 'SUPERUSER' end, case when rolbypassrls then 'BYPASSRLS' end)) as what
       from pg_roles where rolname in ('anon', 'authenticated') and (rolsuper or rolbypassrls)
     union all
     select format('%s has the privileges of %s', r.rolname, x.rolname)
       from pg_roles r, pg_roles x
      where r.rolname in ('anon', 'authenticated') and x.oid <> r.oid and pg_has_role(r.oid, x.oid, 'USAGE')
     union all
     select format('%s owns %s, so RLS does not apply to it there', r.rolname, c.relname)
       from pg_class c join pg_namespace n on n.oid = c.relnamespace, pg_roles r
      where r.rolname in ('anon', 'authenticated') and ${PROTECTED} and pg_has_role(r.oid, c.relowner, 'USAGE')`,
    [names],
  );
  if (roles.length) for (const r of roles) add("fail", "roles", r.what);
  else add("ok", "roles", "anon and authenticated bypass no RLS, inherit no other role and own no policy table");
  return out;
}

/** Paths around RLS to the protected tables: owner's-rights views, and SECURITY DEFINER functions anon or authenticated can reach. */
export async function checkBypasses(client: pg.Client, names: string[]): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (status: Finding["status"], check: string, detail: string) => out.push({ status, check, detail });
  // Owner's-rights paths around RLS: every view anon or authenticated can select, followed
  // through views on views down to the tables it reads. One owner's-rights view on the
  // path is enough, since Postgres reads its sources as that view's owner.
  const walk = `with recursive walk(top, rel, owner_rights, depth) as (
       select v.oid, v.oid, ${OWNER_RIGHTS("v")}, 0
         from pg_class v join pg_namespace vn on vn.oid = v.relnamespace
        where v.relkind in ('v', 'm') and vn.nspname not in ('pg_catalog', 'information_schema') and ${REACHABLE("vn")}
          and (has_table_privilege('anon', v.oid, 'SELECT') or has_table_privilege('authenticated', v.oid, 'SELECT'))
       union
       select w.top, r.oid, w.owner_rights or ${OWNER_RIGHTS("r")}, w.depth + 1
         from walk w join pg_rewrite rw on rw.ev_class = w.rel
         join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid and d.refclassid = 'pg_class'::regclass
         join pg_class r on r.oid = d.refobjid
        where d.refobjid <> w.rel and w.depth < 16
     )`;
  const views = await rows<{ what: string }>(
    client,
    `${walk}
     select distinct format('%s.%s reads %s.%s through a view with its owner''s rights (not security_invoker), and %s can select it',
                            vn.nspname, v.relname, n.nspname, c.relname,
                            case when has_table_privilege('anon', v.oid, 'SELECT') then 'anon' else 'authenticated' end) as what
       from walk w join pg_class c on c.oid = w.rel join pg_namespace n on n.oid = c.relnamespace
       join pg_class v on v.oid = w.top join pg_namespace vn on vn.oid = v.relnamespace
      where w.owner_rights and ${PROTECTED}`,
    [names],
  );
  // A view can also reach rows through a SECURITY DEFINER function, wherever it lives: once
  // the view resolves it, callers need only EXECUTE, not USAGE on its schema.
  const viaFunctions = await rows<{ what: string }>(
    client,
    `${walk}
     select distinct format('%s.%s reads rows through %s, which runs as its owner; check that it applies the tenant itself',
                            vn.nspname, v.relname, p.oid::regprocedure) as what
       from walk w join pg_rewrite rw on rw.ev_class = w.rel
       join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid and d.refclassid = 'pg_proc'::regclass
       join pg_proc p on p.oid = d.refobjid join pg_namespace pn on pn.oid = p.pronamespace
       join pg_class v on v.oid = w.top join pg_namespace vn on vn.oid = v.relnamespace
      where p.prosecdef and pn.nspname <> all($1) and pn.nspname <> 'samesight'`,
    [PLATFORM],
  );
  for (const v of viaFunctions) add("warn", "views", v.what);
  if (views.length) for (const v of views) add("fail", "views", v.what);
  else add("ok", "views", "no view anon or authenticated can select reads a protected table past RLS");
  const definers = await rows<{ what: string }>(
    client,
    `select format('%s runs as its owner and %s can call it; check that it applies the tenant itself', p.oid::regprocedure,
                   case when has_function_privilege('anon', p.oid, 'execute') then 'anon' else 'authenticated' end) as what
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname <> all($1) and n.nspname <> 'samesight' and p.prosecdef
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`,
    [PLATFORM],
  );
  for (const d of definers) add("warn", "definer functions", d.what);
  return out;
}
