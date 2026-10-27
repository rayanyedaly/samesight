/**
 * Coverage: whether each RLS read policy and each stream was seen both letting a run user
 * have a row and keeping one from them, over the datasets the differential ran before its
 * first failure. A rule seen only one way passed the comparison without being tested.
 *
 * A permissive policy P is measured alone: inside a transaction that is always rolled
 * back, every other policy on its table is dropped, so a read returns what P allows. It
 * allowed a row when P alone returns it, and refused one when neither P alone nor the
 * table's full RLS does. A restrictive policy R refused a row the full RLS keeps out but
 * returns with R dropped, and allowed one the full RLS returns. A stream sent a row when
 * the user's device received it from that stream, and withheld one it did not.
 * Counts are over (run user, generated row) pairs.
 */

import type pg from "pg";
import { claimReads, classify, ident, outputTable, parseQuery, type Stream } from "samesight/compiler";
import { rows } from "../db.ts";
import type { DeviceRow } from "../differential/device.ts";
import type { Run } from "../differential/run.ts";
import type { Inserted } from "../differential/world.ts";
import type { Finding } from "../report.ts";
import { qualified } from "./claims.ts";

export interface Tally {
  allowed: number;
  refused: number;
  /** The first read error, if any: the policy was not measured for that dataset. */
  error?: string;
}

export interface ScopedPolicy {
  table: string;
  name: string;
  permissive: boolean;
  qual: string;
  /** Reads nothing of the user (no claim but shared ones, no function that reads the token). */
  sameForAll: boolean;
  /** Claims it reads that tell users apart, by key (app_metadata.role). */
  claims: string[];
  /** Every such claim is one run users hold, so more datasets can exercise it. */
  reachable: boolean;
  tally: Tally;
}

/** One stream's rows of one table; streams sharing a bucket are measured as one unit. */
export interface StreamUnit {
  streams: string[];
  table: string;
  /** Claims its queries read that tell users apart, by key. */
  claims: string[];
  reachable: boolean;
  tally: Tally;
}

export interface Coverage {
  policies: ScopedPolicy[];
  units: StreamUnit[];
  /** Rows the measured datasets inserted, by table. */
  inserted: Map<string, number>;
  datasets: number;
  /** Event triggers that would fire on DROP POLICY: policies are then not measured. */
  triggers: string[];
  /** What is out of scope, said once. */
  notes: Finding[];
}

/**
 * Supabase's own event triggers: they only NOTIFY PostgREST, which a rolled-back
 * transaction never sends.
 */
const HARMLESS_TRIGGERS = new Set(["pgrst_ddl_watch:pgrst_ddl_watch", "pgrst_drop_watch:pgrst_drop_watch"]);

const READ_COMMANDS = new Set(["r", "*"]);

/** What coverage measures on these synced tables and streams, before any dataset. */
export async function coverageScope(
  client: pg.Client,
  synced: string[],
  streams: Stream[],
  functions: ReadonlyMap<string, string>,
  kind: "streams" | "bucket definitions",
  /** Claim keys run users hold values of. */
  held: ReadonlySet<string>,
): Promise<Coverage> {
  const policies = await qualified(client, () =>
    rows<{ table: string; name: string; permissive: boolean; cmd: string; qual: string | null; users: boolean; roles: string[] }>(
      client,
      `select c.relname as table, p.polname as name, p.polpermissive as permissive, p.polcmd::text as cmd,
              pg_catalog.pg_get_expr(p.polqual, p.polrelid) as qual,
              (0::oid = any(p.polroles) or 'authenticated'::regrole::oid = any(p.polroles)) as users,
              array(select r.rolname::text from pg_catalog.pg_roles r where r.oid = any(p.polroles) order by 1) as roles
         from pg_catalog.pg_policy p
         join pg_catalog.pg_class c on c.oid = p.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1) and c.relrowsecurity
        order by 1, 2`,
      [synced],
    ),
  );
  const triggers = (
    await rows<{ name: string; fn: string }>(
      client,
      `select e.evtname as name, e.evtfoid::regproc::text as fn from pg_catalog.pg_event_trigger e
        where e.evtenabled <> 'D' and e.evtevent in ('ddl_command_start', 'ddl_command_end', 'sql_drop')
          and (e.evttags is null or 'DROP POLICY' = any(e.evttags))
        order by 1`,
    )
  )
    .filter((t) => !HARMLESS_TRIGGERS.has(`${t.name}:${t.fn}`))
    .map((t) => `${t.name} (${t.fn})`);

  const notes: Finding[] = [];
  const reads = policies.filter((p) => READ_COMMANDS.has(p.cmd) && p.qual !== null);
  const others = reads.filter((p) => !p.users);
  if (others.length) {
    notes.push({ status: "warn", check: "coverage", detail: `${others.length} read ${others.length === 1 ? "policy applies" : "policies apply"} to other roles only, not measured: ${others.map((p) => `"${p.name}" on ${p.table} (to ${p.roles.join(", ")})`).join("; ")}` });
  }
  // FOR ALL policies write too.
  if (policies.some((p) => p.cmd !== "r")) {
    notes.push({ status: "ok", check: "coverage", detail: "what policies let users write (INSERT, UPDATE, DELETE, and the write side of FOR ALL): not measured; the write path only tries inserts as other users" });
  }
  const scoped = reads
    .filter((p) => p.users)
    .map((p): ScopedPolicy => {
      const found = claimReads(p.qual as string, "postgres", { functions });
      const claims = userClaims(found.reads);
      const sameForAll = found.unreadable.length === 0 && found.reads.every((r) => classify(r.path) === "shared");
      const reachable = found.unreadable.length === 0 && claims.every((k) => held.has(k));
      return { table: p.table, name: p.name, permissive: p.permissive, qual: p.qual as string, sameForAll, claims, reachable, tally: { allowed: 0, refused: 0 } };
    });
  for (const t of synced) {
    if (!scoped.some((p) => p.table === t)) notes.push({ status: "warn", check: "coverage", detail: `${t}: no read policy for authenticated users to measure` });
  }
  if (triggers.length) {
    notes.push({
      status: "warn",
      check: "coverage",
      detail: `policies not measured: coverage drops policies inside a transaction it rolls back, and event triggers would run on that (${triggers.join(", ")})`,
    });
  }
  const units = streamUnits(streams, kind).map((u) => ({ ...u, reachable: u.claims.every((k) => held.has(k)) }));
  return { policies: scoped, units, inserted: new Map(), datasets: 0, triggers, notes };
}

/** The claim keys reads tell users apart by: neither the user id nor one every user shares. */
function userClaims(reads: { path: string[] }[]): string[] {
  return [...new Set(reads.filter((r) => !["identity", "shared"].includes(classify(r.path))).map((r) => r.path.join(".")))].sort();
}

/**
 * Per stream and table. PowerSync puts queries that differ only in conditions comparing
 * auth.parameter() with literals in one bucket, named after the first stream: those are
 * one unit, since a device cannot tell which of them sent a row.
 */
export function streamUnits(streams: Stream[], kind: "streams" | "bucket definitions" = "streams"): Omit<StreamUnit, "reachable">[] {
  const units = new Map<string, Omit<StreamUnit, "reachable">>();
  const dialect = kind === "streams" ? "streams" : "rules";
  for (const st of streams) {
    if (!st.autoSubscribe) continue;
    for (const q of st.queries) {
      let table: string;
      try {
        table = outputTable(q.sql).table;
      } catch {
        continue;
      }
      const key = kind === "streams" ? (bucketKey(q.sql) ?? `${st.name}\u0000${table}`) : `${st.name}\u0000${table}`;
      const own = `${st.name}\u0000${table}`;
      // A stream already in a unit for this table joins it; so does one whose query shares a bucket.
      const unit = units.get(key) ?? [...units.values()].find((u) => u.table === table && u.streams.includes(st.name));
      // What decides the rows: the query, and the stream's CTEs or the bucket's parameter queries.
      const claims = userClaims([q.sql, ...st.ctes.values()].flatMap((sql) => claimReads(sql, dialect).reads));
      if (unit) {
        if (!unit.streams.includes(st.name)) unit.streams.push(st.name);
        unit.claims = [...new Set([...unit.claims, ...claims])].sort();
        units.set(key, unit);
        units.set(own, unit);
      } else {
        const created = { streams: [st.name], table, claims, tally: { allowed: 0, refused: 0 } };
        units.set(key, created);
        units.set(own, created);
      }
    }
  }
  return [...new Set(units.values())].sort((a, b) => a.table.localeCompare(b.table) || (a.streams[0] ?? "").localeCompare(b.streams[0] ?? ""));
}

/** The query without its conditions that compare auth.parameter() with literals; undefined when it cannot tell. */
function bucketKey(sql: string): string | undefined {
  try {
    const q = parseQuery(sql);
    const kept = q.terms.filter((term) => {
      const found = claimReads(term, "streams");
      const filter = found.reads.length > 0 && found.unreadable.length === 0 && found.reads.every((r) => r.compared.kind === "literals" && classify(r.path) !== "identity");
      return !filter;
    });
    return `${q.table}\u0000${q.projection === "*" ? "*" : q.projection.join(",")}\u0000${[...kept].sort().join("\u0000")}`;
  } catch {
    return undefined;
  }
}

/** Ids by table, as text. */
function idsOf(inserted: Inserted[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of inserted) {
    if (r.row.id === undefined || r.row.id === null) continue;
    out.set(r.table, [...(out.get(r.table) ?? []), String(r.row.id)]);
  }
  return out;
}

/** Adds one dataset's counts: run inside withWorld, after the comparison, before any failure. */
export async function measure(s: Run, cov: Coverage, inserted: Inserted[], devices: Map<string, DeviceRow[]>): Promise<void> {
  cov.datasets++;
  const ids = idsOf(inserted);
  for (const [t, list] of ids) cov.inserted.set(t, (cov.inserted.get(t) ?? 0) + list.length);
  const readers = s.fixed.users.map((u) => ({ id: u.id, claims: s.sessions.get(u.id)?.claims ?? {} }));

  for (const unit of cov.units) {
    const mine = ids.get(unit.table) ?? [];
    for (const u of readers) {
      const sent = new Set((devices.get(u.id) ?? []).filter((r) => r.table === unit.table && r.sources.some((x) => unit.streams.includes(x.stream))).map((r) => r.id));
      for (const id of mine) {
        if (sent.has(id)) unit.tally.allowed++;
        else unit.tally.refused++;
      }
    }
  }

  if (cov.triggers.length) return;
  const tables = [...new Set(cov.policies.map((p) => p.table))].filter((t) => ids.get(t)?.length);
  if (!tables.length) return;
  await s.client.query("begin");
  try {
    await s.client.query("set local lock_timeout = '5s'");
    await s.client.query("set local statement_timeout = '60s'");
    // A run killed mid-measure leaves no transaction holding its locks for long.
    await s.client.query("set local idle_in_transaction_session_timeout = '30s'");
    for (const table of tables) {
      const mine = ids.get(table) ?? [];
      const all = await rows<{ name: string }>(
        s.client,
        "select p.polname as name from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = $1",
        [table],
      );
      const full = await readAll(s.client, table, mine, readers);
      for (const p of cov.policies.filter((x) => x.table === table)) {
        await s.client.query("savepoint samesight_policy");
        try {
          const drop = p.permissive ? all.filter((x) => x.name !== p.name) : all.filter((x) => x.name === p.name);
          for (const x of drop) await s.client.query(`drop policy ${ident(x.name)} on public.${ident(table)}`);
          const alone = await readAll(s.client, table, mine, readers);
          for (const [i, seen] of alone.entries()) {
            const whole = full[i];
            if (seen instanceof Error || whole instanceof Error || !seen || !whole) {
              p.tally.error ??= ((seen instanceof Error ? seen : whole) as Error | undefined)?.message ?? "no read";
              continue;
            }
            for (const id of mine) {
              if (p.permissive) {
                if (seen.has(id)) p.tally.allowed++;
                else if (!whole.has(id)) p.tally.refused++;
              } else if (whole.has(id)) p.tally.allowed++;
              else if (seen.has(id)) p.tally.refused++;
            }
          }
        } finally {
          await s.client.query("rollback to savepoint samesight_policy");
        }
      }
    }
  } finally {
    await s.client.query("rollback").catch(() => {});
  }
}

/** The ids of `ids` each reader's RLS returns, or the error its read raised. */
async function readAll(client: pg.Client, table: string, ids: string[], readers: { claims: Record<string, unknown> }[]): Promise<(Set<string> | Error)[]> {
  const out: (Set<string> | Error)[] = [];
  for (const r of readers) {
    await client.query("savepoint samesight_read");
    try {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(r.claims)]);
      const found = await rows<{ id: string }>(client, `select id::text as id from public.${ident(table)} where id::text = any($1)`, [ids]);
      out.push(new Set(found.map((x) => x.id)));
      await client.query("release savepoint samesight_read");
    } catch (e) {
      await client.query("rollback to savepoint samesight_read");
      out.push(e as Error);
    }
    // rollback to savepoint undoes set local role too; reset covers the success path.
    await client.query("reset role");
  }
  return out;
}

export type State = "exercised" | "only allowed" | "only refused" | "not seen";

export function stateOf(t: Tally): State {
  if (t.allowed > 0 && t.refused > 0) return "exercised";
  if (t.allowed > 0) return "only allowed";
  if (t.refused > 0) return "only refused";
  return "not seen";
}

/** True while a rule run users can exercise has not been seen both ways: worth another pass. */
export function pending(cov: Coverage): boolean {
  const open = (x: { reachable: boolean; tally: Tally }) => x.reachable && x.tally.error === undefined && stateOf(x.tally) !== "exercised";
  return cov.policies.some((p) => !p.sameForAll && open(p)) || cov.units.some(open);
}
