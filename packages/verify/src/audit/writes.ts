/**
 * The write path without a policy file: what each user can write straight through the
 * REST API, under the same RLS. With no policy to say which writes are meant, it checks
 * the one rule any setup needs: a user cannot write a row they could not then read. A row
 * a user plants in data RLS keeps from them lands on the devices of whoever owns that data.
 *
 * Each user, in turn, inside one transaction that is rolled back, inserts a copy of every
 * generated row, as it is and claimed as their own. An insert RLS lets through that the
 * writer cannot read back is a failure. This is the loosest write path: PostgREST inserts
 * without RETURNING unless asked, so no SELECT policy stops it. (Upserts, as PowerSync's
 * reference connector sends, and updates whose WHERE reads the table also put the new row
 * through the SELECT policies, so they cannot leave a row its writer cannot read.)
 */

import type pg from "pg";
import { ident } from "samesight/compiler";
import { rolledBack, rows } from "../db.ts";
import type { Run } from "../differential/run.ts";
import { insertWorld, type Member, prefixedUuid, type World } from "../differential/world.ts";
import type { Finding } from "../report.ts";

/** Postgres's codes for a row RLS refused, and for a unique violation. */
const RLS_REFUSED = "42501";
const UNIQUE = "23505";

interface Escape {
  user: Member;
  table: string;
  what: string;
  readers: string[];
}

interface TableCounts {
  tried: number;
  /** Inserted and readable to the writer. */
  kept: number;
  refused: number;
  /** Rejected before RLS had its say, by SQLSTATE: unique, check, foreign key... */
  rejected: Map<string, number>;
}

/**
 * `prepare` runs first in the same rolled-back transaction, as the connecting role (tests plant
 * breakages with it). `reads`: tables the stream queries read without sending (memberships,
 * shares); a row planted there changes what other devices receive, as one in a synced table does.
 */
export async function checkWriteEscape(s: Run, world: World, prepare?: (client: pg.Client) => Promise<void>, reads: string[] = []): Promise<Finding[]> {
  const check = "write path";
  const escapes: Escape[] = [];
  const skipped: string[] = [];
  const counts = new Map<string, TableCounts>();
  const label = (v: unknown) => s.fixed.users.find((u) => u.id === v)?.label ?? String(v);

  await rolledBack(s.client, async () => {
    if (prepare) await prepare(s.client);
    // Generated rows may point at rows kept for the run (the access token hook's teams).
    const generated = await insertWorld(s.client, s.tables, world, s.fixed, s.existing);
    // Rows kept for the run (the access token hook's) are copied too: one a user could write but
    // not read back is planted data like any other. (What the hook would make of it at the
    // next sign-in is not checked: no one signs in again.)
    const fixedRows = s.fixedRows ?? [];
    const inserted = [...generated, ...fixedRows];
    const tables = [...s.tables, ...s.model.filter((t) => !s.tables.includes(t) && fixedRows.some((r) => r.table === t.name))];
    const as = async (u: Member) => {
      await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(s.sessions.get(u.id)?.claims ?? {})]);
    };
    const readers = async (table: string, key: string, id: unknown, writer: Member) => {
      const out: string[] = [];
      for (const other of s.fixed.users.filter((o) => o.id !== writer.id)) {
        await as(other);
        if (await readable(s.client, table, key, id)) out.push(other.label);
      }
      await as(writer);
      return out;
    };

    /** One insert as `u`, under a savepoint; returns the SQLSTATE it was rejected with, and the constraint, if any. */
    const attempt = async (u: Member, table: string, key: string, values: Record<string, unknown>, c: TableCounts): Promise<{ code?: string; constraint?: string }> => {
      const row = { ...values, [key]: prefixedUuid(s.fixed.prefix) };
      const cols = Object.keys(row);
      const t = tables.find((x) => x.name === table);
      const refs = (t?.columns ?? []).filter((col) => col.type === "uuid" && col.name !== key && row[col.name] !== undefined && row[col.name] !== null).map((col) => `${col.name} ${label(row[col.name])}`);
      c.tried++;
      await s.client.query("savepoint probe");
      let wrote = false;
      let code: string | undefined;
      let constraint: string | undefined;
      try {
        const result = await s.client.query(
          `insert into public.${ident(table)} (${cols.map(ident).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          cols.map((col) => row[col]),
        );
        // A trigger can swallow the row (BEFORE INSERT returning NULL): nothing written, nothing to read.
        wrote = result.rowCount === 1;
      } catch (e) {
        code = (e as { code?: string }).code ?? "unknown";
        constraint = (e as { constraint?: string }).constraint;
        if (code === RLS_REFUSED) c.refused++;
        else c.rejected.set(code, (c.rejected.get(code) ?? 0) + 1);
      }
      // Outside the try: a read-back that errors is the check failing, not RLS refusing.
      if (wrote) {
        if (await readable(s.client, table, key, row[key])) c.kept++;
        else escapes.push({ user: u, table, what: `inserted a ${table} row with ${refs.join(", ") || "another row's values"}`, readers: await readers(table, key, row[key], u) });
      }
      await s.client.query("rollback to savepoint probe");
      await s.client.query("release savepoint probe");
      return { code, constraint };
    };

    /** The columns of the unique index a copy collided with. */
    const indexColumns = async (constraint: string | undefined): Promise<string[]> => {
      if (!constraint) return [];
      const r = await rows<{ name: string }>(
        s.client,
        `select a.attname as name from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
          where i.indexrelid = to_regclass(format('public.%I', $1::text))`,
        [constraint],
      );
      return r.map((x) => x.name);
    };

    for (const u of s.fixed.users) {
      await s.client.query("set local role authenticated");
      await as(u);
      for (const t of tables) {
        const [key] = t.primaryKey;
        const keyType = t.columns.find((c) => c.name === key)?.type;
        if (t.primaryKey.length !== 1 || !key || keyType !== "uuid") {
          skipped.push(`inserts into ${t.name} (its key is not one uuid column, so a copy cannot be found again)`);
          continue;
        }
        const c = counts.get(t.name) ?? { tried: 0, kept: 0, refused: 0, rejected: new Map() };
        counts.set(t.name, c);
        const writable = t.columns.filter((col) => !col.computed && col.name !== key);
        const owners = t.foreignKeys.filter((fk) => fk.schema === "auth" && fk.table === "users" && fk.columns.length === 1).map((fk) => fk.columns[0] as string);
        const plain = writable.filter((col) => !t.foreignKeys.some((fk) => fk.columns.includes(col.name)) && (col.type === "uuid" || col.type === "text" || col.type.startsWith("character")));
        for (const r of inserted.filter((x) => x.table === t.name)) {
          // A copy as it is (another user's row, or a row under another user's parent), then claimed as u's own.
          for (const claim of owners.length ? [false, true] : [false]) {
            const row: Record<string, unknown> = {};
            for (const col of writable) if (r.row[col.name] !== undefined) row[col.name] = r.row[col.name];
            if (claim) for (const o of owners) row[o] = u.id;
            // RLS has allowed a copy a unique index then stops (Postgres checks the policy first):
            // once more, with fresh values in that index's columns that point nowhere.
            const first = await attempt(u, t.name, key, row, c);
            if (first.code === UNIQUE) {
              const cols = await indexColumns(first.constraint);
              const fresh = plain.filter((col) => cols.includes(col.name) && typeof row[col.name] === "string");
              for (const col of fresh) row[col.name] = col.type === "uuid" ? prefixedUuid(s.fixed.prefix) : `${row[col.name]}~${c.tried}`;
              if (fresh.length) await attempt(u, t.name, key, row, c);
            }
          }
        }
      }
      await s.client.query("reset role");
    }
  });

  const findings: Finding[] = [];
  const describe = (e: Escape) => `${e.user.label} ${e.what}, and could not read it back${e.readers.length ? `; ${e.readers.join(", ")} can, and their devices would receive it` : ""}`;
  const list = (es: Escape[]) => {
    const lines = es.slice(0, 8).map(describe);
    return `${lines.map((l) => `    ${l}`).join("\n")}${es.length > lines.length ? `\n    and ${es.length - lines.length} more` : ""}`;
  };
  // A row nobody else can read, or in a table no stream sends or reads, reaches no other device.
  const reaching = escapes.filter((e) => (s.synced.includes(e.table) || reads.includes(e.table)) && e.readers.length);
  const contained = escapes.filter((e) => !reaching.includes(e));
  if (reaching.length) {
    findings.push({ status: "fail", check, detail: `RLS lets users insert rows they cannot read into tables the streams send or read (an insert policy wider than the read policy):\n${list(reaching)}` });
  }
  if (contained.length) {
    findings.push({ status: "warn", check, detail: `RLS lets users insert rows they cannot read, though no other user's device would receive them:\n${list(contained)}` });
  }
  const total = { tried: 0, kept: 0, refused: 0 };
  for (const [table, c] of counts) {
    total.tried += c.tried;
    total.kept += c.kept;
    total.refused += c.refused;
    const rejected = [...c.rejected].map(([code, n]) => `${n} by ${code}`).join(", ");
    if (!c.tried) findings.push({ status: "warn", check, detail: `not tried: ${table} (no generated row to copy)` });
    else if (!c.kept && !c.refused) findings.push({ status: "warn", check, detail: `not tried: no insert into ${table} reached RLS (rejected ${rejected})` });
  }
  if (!escapes.length) {
    findings.unshift(
      total.kept
        ? {
            status: "ok",
            check,
            detail: `${total.tried} inserts as ${s.fixed.users.length} users: every insert RLS allowed (${total.kept}) is readable to its writer; RLS refused ${total.refused}`,
          }
        : { status: "warn", check, detail: `RLS allowed none of ${total.tried} inserts, so this check proves nothing; do users write at all?` },
    );
  }
  for (const k of new Set(skipped)) findings.push({ status: "warn", check, detail: `not tried: ${k}` });
  return findings;
}

async function readable(client: pg.Client, table: string, key: string, id: unknown): Promise<boolean> {
  const r = await rows<{ n: number }>(client, `select count(*)::int as n from public.${ident(table)} where ${ident(key)} = $1`, [id]);
  return (r[0]?.n ?? 0) > 0;
}
