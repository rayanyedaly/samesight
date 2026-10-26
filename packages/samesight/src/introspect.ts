/**
 * Reads the application tables in `public` from a local database, in one read-only
 * transaction. Samesight never connects to a hosted database: generate and doctor read
 * the local Supabase stack, and check reads the snapshot generate saved.
 */

import pg from "pg";
import type { ColumnInfo, SchemaInfo, TableInfo } from "./schema.ts";
import { readSupabaseConfig } from "./supabase-config.ts";

/** The local Supabase CLI database. */
export const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The local database of the Supabase project in `dir`: the port `[db]` sets in
 * supabase/config.toml, which `supabase init` writes and projects move when they run side
 * by side. DEFAULT_DB_URL when there is no such file or port.
 */
export function projectDbUrl(dir: string): string {
  const port = readSupabaseConfig(dir)?.get("db")?.get("port");
  return port && /^\d+$/.test(port) ? `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` : DEFAULT_DB_URL;
}

/** Throws unless the URL points at this machine. */
export function assertLocal(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The database URL is not a valid postgres:// URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("The database URL must start with postgres:// or postgresql://");
  }
  // pg lets query parameters override the host (?host=), so none may name one.
  for (const key of parsed.searchParams.keys()) {
    if (key === "host" || key === "hostaddr") throw new Error(`The database URL cannot set ${key} in its query`);
  }
  assertLocalHost(parsed.hostname);
}

function assertLocalHost(host: string): void {
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Samesight only connects to a local database (localhost, 127.0.0.1 or ::1), not ${host || "an empty host"}`);
  }
}

export async function withLocalClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  assertLocal(url);
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  // And the host pg actually resolved (URL, query parameters, PGHOST), in case they differ.
  assertLocalHost(client.host);
  await client.connect();
  try {
    await client.query("begin transaction read only");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } finally {
    await client.end();
  }
}

export async function introspect(url: string): Promise<SchemaInfo> {
  return withLocalClient(url, async (client) => {
    const columns = await client.query<{
      table: string;
      name: string;
      type: string;
      nullable: boolean;
      default: string | null;
      identity: boolean;
      generated: boolean;
      partitioned: boolean;
    }>(`
      select c.relname as table, a.attname as name,
             format_type(a.atttypid, a.atttypmod) as type,
             not a.attnotnull as nullable,
             pg_get_expr(d.adbin, d.adrelid) as default,
             a.attidentity <> '' as identity,
             a.attgenerated <> '' as generated,
             c.relkind = 'p' as partitioned
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
         and a.attnum > 0 and not a.attisdropped
       order by c.relname, a.attnum`);
    // Key columns only (not INCLUDE), of valid indexes without expressions: an expression
    // has attnum 0 and would vanish from the list, making (lower(x), y) look like (y).
    const indexes = await client.query<{ table: string; columns: string[]; primary: boolean; unique: boolean; partial: boolean }>(`
      select c.relname as table,
             array(select a.attname from unnest(i.indkey[0:i.indnkeyatts - 1]) with ordinality k(attnum, ord)
                     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                    order by k.ord)::text[] as columns,
             i.indisprimary as primary, i.indisunique as unique, i.indpred is not null as partial
        from pg_index i
        join pg_class c on c.oid = i.indrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
         and i.indisvalid and i.indexprs is null`);

    const fks = await client.query<{ table: string; columns: string[]; ref: string; references: string[] }>(`
      select c.relname as table, r.relname as ref,
             array(select a.attname from unnest(k.conkey) with ordinality x(attnum, ord)
                     join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum order by x.ord)::text[] as columns,
             array(select a.attname from unnest(k.confkey) with ordinality x(attnum, ord)
                     join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.attnum order by x.ord)::text[] as references
        from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        join pg_class r on r.oid = k.confrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_namespace rn on rn.oid = r.relnamespace
       where k.contype = 'f' and k.convalidated and k.conparentid = 0 and n.nspname = 'public' and rn.nspname = 'public'
       order by c.relname, k.conname`);

    const tables = new Map<string, TableInfo>();
    for (const row of columns.rows) {
      let t = tables.get(row.table);
      if (!t) {
        t = { name: row.table, columns: [], primaryKey: [], indexedColumns: [], uniqueColumns: [], foreignKeys: [], ...(row.partitioned ? { partitioned: true as const } : {}) };
        tables.set(row.table, t);
      }
      const column: ColumnInfo = {
        name: row.name,
        type: row.type,
        nullable: row.nullable,
        default: row.default,
        identity: row.identity,
        generated: row.generated,
      };
      t.columns.push(column);
    }
    for (const ix of indexes.rows) {
      const t = tables.get(ix.table);
      if (!t || ix.columns.length === 0) continue;
      if (ix.primary) t.primaryKey = ix.columns;
      if (!ix.partial && !t.indexedColumns.includes(ix.columns[0])) t.indexedColumns.push(ix.columns[0]);
      if (ix.unique && !ix.partial && ix.columns.length === 1 && !t.uniqueColumns.includes(ix.columns[0])) {
        t.uniqueColumns.push(ix.columns[0]);
      }
    }
    for (const fk of fks.rows) tables.get(fk.table)?.foreignKeys.push({ columns: fk.columns, table: fk.ref, references: fk.references });
    for (const t of tables.values()) {
      t.indexedColumns.sort();
      t.uniqueColumns.sort();
    }
    return { tables: [...tables.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
  });
}
