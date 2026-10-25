/**
 * The database must be exactly what the generated migration makes it. Applying the latest
 * generated migration on top of the live database must change nothing (otherwise someone
 * altered a policy, grant or trigger by hand, or a later migration did), and applying it
 * twice must not fail (otherwise the next generate cannot land). Both run in transactions
 * that are always rolled back.
 */

import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { DatabaseBusy, isBusy, rolledBack, rows } from "../db.ts";
import type { Finding } from "../report.ts";
import { splitSqlStatements } from "../sql.ts";
import { PUBLIC_FUNCTIONS } from "./catalog.ts";

type Row = Record<string, unknown>;

/** Each section with the columns that identify a row; the rest are compared. */
const KEYS: Record<string, string[]> = {
  policies: ["schema", "table", "name"],
  relations: ["schema", "name"],
  triggers: ["schema", "table", "name"],
  grants: ["schema", "name", "grantee", "privilege"],
  columnGrants: ["schema", "table", "column", "grantee", "privilege"],
  schemaGrants: ["schema", "grantee", "privilege"],
  publications: ["name"],
  publicationTables: ["publication", "table"],
  functions: ["name"],
  roles: ["name"],
  memberships: ["role", "member"],
};

/** Everything the generated migration can change, in a stable order. */
export async function snapshot(client: pg.Client): Promise<Record<string, Row[]>> {
  // Every relation in public (so a table that left the policy is compared too) and samesight.
  const scope = `n.nspname in ('public', 'samesight')`;
  const q = (sql: string, params: unknown[] = []) => rows<Row>(client, sql, params);
  const grantee = `coalesce((select rolname from pg_roles where oid = x.grantee), 'PUBLIC')`;
  return {
    policies: await q(
      `select n.nspname as schema, c.relname as table, p.polname as name, p.polpermissive as permissive, p.polcmd as cmd,
              array(select coalesce((select rolname from pg_roles where oid = r), 'public') from unnest(p.polroles) r order by 1)::text[] as roles,
              pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as with_check,
              obj_description(p.oid, 'pg_policy') as comment
         from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
        where ${scope} order by 1, 2, 3`,
    ),
    relations: await q(
      `select n.nspname as schema, c.relname as name, c.relkind as kind, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
              c.relreplident as replica_identity, pg_get_userbyid(c.relowner) as owner
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm', 'S') and ${scope} order by 1, 2`,
    ),
    triggers: await q(
      `select n.nspname as schema, c.relname as table, t.tgname as name, t.tgenabled as enabled, pg_get_triggerdef(t.oid) as def
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where not t.tgisinternal and ${scope} order by 1, 2, 3`,
    ),
    // Read from the ACLs, so PUBLIC grants and grants by any grantor show.
    grants: await q(
      `select n.nspname as schema, c.relname as name, ${grantee} as grantee, x.privilege_type as privilege, x.is_grantable as grantable
         from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) x
        where c.relacl is not null and ${scope} order by 1, 2, 3, 4`,
    ),
    columnGrants: await q(
      `select n.nspname as schema, c.relname as table, a.attname as column, ${grantee} as grantee, x.privilege_type as privilege,
              x.is_grantable as grantable
         from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace,
              aclexplode(a.attacl) x
        where a.attacl is not null and ${scope} order by 1, 2, 3, 4, 5`,
    ),
    schemaGrants: await q(
      `select n.nspname as schema, ${grantee} as grantee, x.privilege_type as privilege, x.is_grantable as grantable
         from pg_namespace n, aclexplode(n.nspacl) x
        where n.nspacl is not null and ${scope} order by 1, 2, 3`,
    ),
    publications: await q(
      `select p.pubname as name, p.puballtables as all_tables, p.pubinsert as insert, p.pubupdate as update,
              p.pubdelete as delete, p.pubtruncate as truncate
         from pg_publication p order by 1`,
    ),
    publicationTables: await q(
      `select p.pubname as publication, pr.prrelid::regclass::text as table,
              pg_get_expr(pr.prqual, pr.prrelid) as row_filter, pr.prattrs::text as columns
         from pg_publication_rel pr join pg_publication p on p.oid = pr.prpubid order by 1, 2`,
    ),
    // Definitions as Postgres prints them, plus who owns and may call each.
    functions: await q(
      `select p.oid::regprocedure::text as name, pg_get_functiondef(p.oid) as def, p.prosecdef as security_definer,
              pg_get_userbyid(p.proowner) as owner,
              array(select r from unnest(array['anon', 'authenticated', 'service_role', 'supabase_auth_admin', 'powersync_role']) r
                     where has_function_privilege(r, p.oid, 'execute') order by 1)::text[] as callers
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prokind in ('f', 'p') and (n.nspname = 'samesight' or (n.nspname = 'public' and p.proname = any($1)))
        order by 1`,
      [PUBLIC_FUNCTIONS],
    ),
    roles: await q(
      `select rolname as name, rolsuper as super, rolbypassrls as bypassrls, rolreplication as replication, rolinherit as inherit
         from pg_roles where rolname in ('anon', 'authenticated', 'service_role', 'powersync_role', 'supabase_auth_admin') order by 1`,
    ),
    memberships: await q(
      `select pg_get_userbyid(m.roleid) as role, pg_get_userbyid(m.member) as member
         from pg_auth_members m
        where pg_get_userbyid(m.member) in ('anon', 'authenticated', 'powersync_role')
           or pg_get_userbyid(m.roleid) in ('supabase_auth_admin', 'service_role', 'powersync_role')
        order by 1, 2`,
    ),
  };
}

export async function checkCatalogParity(client: pg.Client, file: string, migration: string): Promise<Finding[]> {
  const check = "catalog parity";
  const statements = splitSqlStatements(migration);
  if (statements.length === 0) return [{ status: "fail", check, detail: `${file} has no statements` }];

  const apply = async () => {
    for (const [i, s] of statements.entries()) {
      try {
        await client.query(s);
      } catch (e) {
        if (isBusy(e)) throw e;
        const first = s.split("\n").find((l) => l.trim() && !l.trim().startsWith("--"));
        throw new Error(`statement ${i + 1} of ${file} failed (${(e as Error).message}): ${first}`, { cause: e });
      }
    }
  };

  const out: Finding[] = [];
  try {
    const drift = await rolledBack(client, async () => {
      const before = await snapshot(client);
      await apply();
      const after = await snapshot(client);
      return Object.keys(before).flatMap((key) => describe(key, before[key] ?? [], after[key] ?? []));
    });
    if (drift.length) {
      for (const d of drift) out.push({ status: "fail", check, detail: `the database differs from ${file}: ${d}` });
    } else out.push({ status: "ok", check, detail: `re-applying ${file} changes nothing` });
  } catch (e) {
    // A first application that fails says nothing about a second.
    return [{ status: "fail", check, detail: (e as Error).message }];
  }
  try {
    await rolledBack(client, async () => {
      await apply();
      await apply();
    });
    out.push({ status: "ok", check, detail: `${file} applies twice in a row without error` });
  } catch (e) {
    out.push({ status: "fail", check, detail: e instanceof DatabaseBusy ? e.message : `not idempotent: ${(e as Error).message}` });
  }
  return out;
}

/** What the migration would remove, add or change, one line each, named by the row's identity. */
export function describe(key: string, before: Row[], after: Row[]): string[] {
  const idCols = KEYS[key] ?? [];
  const id = (r: Row) => idCols.map((c) => String(r[c])).join(" / ");
  const clip = (v: unknown) => {
    const s = JSON.stringify(v) ?? "undefined";
    return s.length > 200 ? `${s.slice(0, 200)}...` : s;
  };
  const out: string[] = [];
  const afterById = new Map(after.map((r) => [id(r), r]));
  const beforeById = new Map(before.map((r) => [id(r), r]));
  for (const [k, b] of beforeById) {
    const a = afterById.get(k);
    if (!a) out.push(`${key}: the migration would remove ${k}`);
    else if (!isDeepStrictEqual(a, b)) {
      const fields = Object.keys(b).filter((f) => !isDeepStrictEqual(a[f], b[f]));
      out.push(`${key}: ${k}: ${fields.map((f) => `${f} is ${clip(b[f])}, the migration makes it ${clip(a[f])}`).join("; ")}`);
    }
  }
  for (const k of afterById.keys()) if (!beforeById.has(k)) out.push(`${key}: the migration would add ${k}`);
  return out;
}
