/**
 * `samesight doctor`: checks a local database against the policy. Each check reports
 * ok, warn or fail with what to do; nothing here changes the database.
 */

import type pg from "pg";
import { withLocalClient } from "./introspect.ts";
import type { IR } from "./ir.ts";
import { PUBLICATION, REPLICATION_ROLE } from "./emit/migration.ts";

export interface Finding {
  status: "ok" | "warn" | "fail";
  check: string;
  detail: string;
}

/** The latest generated migration's version, to confirm it has been applied. */
export async function doctor(url: string, ir: IR, latestVersion: string | null): Promise<Finding[]> {
  return withLocalClient(url, async (client) => {
    const out: Finding[] = [];
    const add = (status: Finding["status"], check: string, detail: string) => out.push({ status, check, detail });
    const names = ir.tables.map((t) => t.name);
    const synced = ir.tables.filter((t) => t.read.size > 0).map((t) => t.name);

    if (latestVersion) {
      // Checked first: a failed query would abort the read-only transaction.
      const tracked = await scalar<boolean>(client, `select to_regclass('supabase_migrations.schema_migrations') is not null`);
      const applied = tracked
        ? await scalar<boolean>(client, `select exists (select 1 from supabase_migrations.schema_migrations where version = $1)`, [latestVersion])
        : null;
      if (applied === null) add("warn", "migration", "cannot read supabase_migrations.schema_migrations");
      else if (applied) add("ok", "migration", `${latestVersion} is applied`);
      else add("fail", "migration", `${latestVersion} is not applied; run \`supabase migration up\` (or db reset)`);
    } else add("fail", "migration", "no generated migration yet; run `samesight generate`");

    const hook = await scalar<boolean>(client, `select to_regprocedure('samesight.custom_access_token_hook(jsonb)') is not null`);
    add(hook ? "ok" : "fail", "token hook", hook ? "samesight.custom_access_token_hook exists" : "missing; apply the migration");

    const tables = await client.query<{ name: string; rls: boolean; identity: string }>(
      `select c.relname as name, c.relrowsecurity as rls, c.relreplident as identity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1)`,
      [names],
    );
    const byName = new Map(tables.rows.map((r) => [r.name, r]));
    const noRls = names.filter((n) => !byName.get(n)?.rls);
    add(noRls.length ? "fail" : "ok", "row level security", noRls.length ? `off on ${noRls.join(", ")}` : `on for all ${names.length} tables`);
    const notFull = synced.filter((n) => byName.get(n)?.identity !== "f");
    add(
      notFull.length ? "fail" : "ok",
      "replica identity",
      notFull.length ? `not FULL on ${notFull.join(", ")}` : "FULL on every synced table",
    );

    const published = await client.query<{ name: string }>(
      `select tablename as name from pg_publication_tables where pubname = $1 and schemaname = 'public'`,
      [PUBLICATION],
    );
    const pub = new Set(published.rows.map((r) => r.name));
    const missing = synced.filter((n) => !pub.has(n));
    const extra = [...pub].filter((n) => !synced.includes(n));
    if (missing.length || extra.length) {
      add(
        "fail",
        "publication",
        [missing.length && `missing ${missing.join(", ")}`, extra.length && `also publishes ${extra.join(", ")}`].filter(Boolean).join("; "),
      );
    } else add("ok", "publication", `${PUBLICATION} publishes exactly the synced tables`);

    const role = await client.query<{ replication: boolean; bypassrls: boolean; login: boolean }>(
      `select rolreplication as replication, rolbypassrls as bypassrls, rolcanlogin as login from pg_roles where rolname = $1`,
      [REPLICATION_ROLE],
    );
    const r = role.rows[0];
    if (!r) add("fail", "replication role", `${REPLICATION_ROLE} does not exist`);
    else if (!r.replication || !r.bypassrls) add("fail", "replication role", `${REPLICATION_ROLE} needs REPLICATION and BYPASSRLS`);
    else add(r.login ? "ok" : "warn", "replication role", r.login ? `${REPLICATION_ROLE} is ready` : `${REPLICATION_ROLE} cannot log in yet; set its password`);

    out.push(...(await replication(client)));
    return out;
  });
}

/**
 * How far behind each replication slot is. No slot and a slot with zero lag look the
 * same on a graph and mean opposite things, so the slots are listed, not summed.
 */
async function replication(client: pg.Client): Promise<Finding[]> {
  try {
    const slots = await client.query<{ slot_name: string; active: boolean; lag_bytes: string | null }>(
      `SELECT slot_name,
              active,
              pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint AS lag_bytes
         FROM pg_replication_slots
        WHERE slot_type = 'logical' AND database = current_database()`,
    );
    if (slots.rows.length === 0) {
      return [{ status: "warn", check: "replication", detail: "no replication slot: PowerSync has never connected" }];
    }
    return slots.rows.map((s) => {
      const lag = s.lag_bytes === null ? null : Number(s.lag_bytes);
      const detail = `${s.slot_name}: ${s.active ? "active" : "inactive"}, lag ${lag === null ? "unknown" : `${lag} bytes`}`;
      return { status: s.active && lag !== null && lag < 64 * 1024 * 1024 ? "ok" : "warn", check: "replication", detail };
    });
  } catch {
    // Unknown is reported as unknown, never as zero.
    return [{ status: "warn", check: "replication", detail: "cannot read pg_replication_slots" }];
  }
}

async function scalar<T>(client: pg.Client, sql: string, params: unknown[] = []): Promise<T> {
  const result = await client.query(sql, params);
  return Object.values(result.rows[0] ?? {})[0] as T;
}
