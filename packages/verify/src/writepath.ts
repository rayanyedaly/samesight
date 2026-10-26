/**
 * The write path: forged upload batches sent to public.apply_batch as each user, the way
 * PostgREST calls it (role authenticated, the token's claims), each in a transaction that
 * is rolled back. Rows are checked as the connecting role, which RLS hides nothing from.
 *
 * Every forgery must be refused (with an access or constraint error, not any error) or
 * rewritten, and must leave every row it targets as it was. Legitimate writes are part of
 * the check: a write path that refuses everything would pass every forgery, so at least one
 * insert, replay and update per table must go through. Cases that need rows a dataset does
 * not have are tried on the next dataset; one never tried fails the check.
 */

import type pg from "pg";
import { ident, type IRTable } from "samesight/compiler";
import { rolledBack, rows } from "./db.ts";
import { normalize } from "./differential/compare.ts";
import type { ColumnModel } from "./differential/model.ts";
import { type Setup, withWorld } from "./differential/run.ts";
import { type Member, prefixedUuid, sampleValue, type World } from "./differential/world.ts";
import type { Finding } from "./report.ts";

type Row = Record<string, unknown>;
type Op = { op: "PUT" | "PATCH" | "DELETE"; table: string; id: string; data?: Row };
type PgError = { code: string; message: string };

/** What a refusal looks like: apply_batch's own errors, RLS, and constraints. */
const REFUSED = /^(P0001|SS001|42501|23\d{3})$/;
const NOT_WRITABLE = /^SS001$/;
const NO_TENANT = /^(28000|P0001|SS001|42501|23\d{3})$/;

export interface ForgedCase {
  user: Member;
  /** The coverage key: "<table>: <what kind of case>". */
  family: string;
  what: string;
  error: PgError | null;
  problem: string | null;
  /** The case ran with what it needed (a forgery that could succeed, a write that did). */
  covered: boolean;
  /** Server-owned columns this case had no forged value for (types the verifier cannot forge). */
  unforged?: string[];
}

interface Outcome {
  error: PgError | null;
  problem: string | null;
  covered: boolean;
}

async function asRow(client: pg.Client, table: string, id: string): Promise<Row | null> {
  const [r] = await rows<{ row: Row }>(client, `select row_to_json(t) as row from public.${ident(table)} t where id = $1`, [id]);
  return r?.row ?? null;
}

/** Calls apply_batch as `claims` inside the current transaction; returns its error, if any. */
async function call(client: pg.Client, claims: Record<string, unknown>, ops: Op[]): Promise<PgError | null> {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query("savepoint forged");
  try {
    await client.query("select public.apply_batch($1::jsonb)", [JSON.stringify(ops)]);
    await client.query("release savepoint forged");
    return null;
  } catch (e) {
    await client.query("rollback to savepoint forged");
    return { code: (e as { code?: string }).code ?? "", message: (e as Error).message };
  } finally {
    await client.query("reset role");
  }
}

const same = (a: Row | null, b: Row | null) => JSON.stringify(a) === JSON.stringify(b);
const unexpected = (error: PgError | null, allowed = REFUSED) =>
  error && !allowed.test(error.code) ? `failed with ${error.code || "no SQLSTATE"} (${error.message}) instead of refusing` : null;

/** The coverage keys a policy's write path must exercise. */
export function writeFamilies(s: Setup): string[] {
  const out: string[] = [];
  for (const t of writableTables(s)) {
    out.push(`${t.name}: PUT into another tenant`, `${t.name}: PATCH, PUT over and DELETE another tenant's row`, `${t.name}: PUT without a membership`);
    if (t.insert.size) out.push(`${t.name}: insert with forged server-owned columns, then replay`);
    if (t.appendOnly) out.push(`${t.name}: PATCH and DELETE an append-only row`);
    else if (t.updateColumns.length) {
      out.push(`${t.name}: PATCH an own row`);
      if (immutable(t).length) out.push(`${t.name}: PATCH a column clients may not change`);
    }
  }
  return out;
}

const writableTables = (s: Setup) => s.ir.tables.filter((t) => t.insert.size || t.update.size || t.delete.size);
/** Columns a client may set on insert, or never, but not change. */
const immutable = (t: IRTable) => [...new Set([...t.insertColumns, ...t.serverOwned])].filter((c) => c !== "id" && !t.updateColumns.includes(c));

/**
 * The forged batches for one dataset, as each user. `prepare` runs first in every case's
 * transaction (tests use it to break the write path); families in `skip` were covered by an
 * earlier dataset and are not run again.
 */
export async function forgeBatches(s: Setup, prepare?: (client: pg.Client) => Promise<void>, skip = new Set<string>()): Promise<ForgedCase[]> {
  const cases: ForgedCase[] = [];
  const model = (t: string, c: string): ColumnModel | undefined => s.model.find((m) => m.name === t)?.columns.find((x) => x.name === c);
  const run = async (user: Member, family: string, what: string, test: (claims: Record<string, unknown>) => Promise<Outcome>): Promise<ForgedCase> => {
    if (skip.has(family)) return { user, family, what, error: null, problem: null, covered: true };
    const claims = s.sessions.get(user.id)?.claims ?? {};
    const r = await rolledBack(s.client, async () => {
      if (prepare) await prepare(s.client);
      return test(claims);
    });
    const c = { user, family, what, ...r };
    cases.push(c);
    return c;
  };
  const data: Map<string, Row[]> = new Map();
  for (const t of s.ir.tables) {
    data.set(t.name, (await rows<{ row: Row }>(s.client, `select row_to_json(x) as row from public.${ident(t.name)} x`)).map((r) => r.row));
  }
  const inTenant = (t: IRTable, tenant: string | null) => (data.get(t.name) ?? []).filter((r) => tenant !== null && r[t.tenant] === tenant);
  const pick = (r: Row, cols: string[]) => Object.fromEntries(cols.filter((c) => r[c] !== undefined).map((c) => [c, r[c]]));

  /** A value for `column` that differs from the row's and fits its constraints, if one can be found. */
  const changed = (t: IRTable, column: string, before: Row, peers: Row[]): unknown => {
    const c = model(t.name, column);
    if (!c || c.computed) return undefined;
    const differs = (v: unknown) => v !== null && v !== undefined && JSON.stringify(normalize(c.type, v)) !== JSON.stringify(normalize(c.type, before[column]));
    if (c.values?.length) return c.values.find(differs);
    if (c.type === "text" && !c.pattern) return `forged ${String(before[column] ?? "").length}`;
    const peer = peers.map((p) => p[column]).find(differs);
    if (peer !== undefined) return peer;
    const sample = sampleValue({ ...c, hasDefault: false }, 7);
    return differs(sample) ? sample : undefined;
  };
  /** A value no server would choose, to see whether a server-owned column keeps it. */
  const forged = (t: IRTable, column: string, user: Member): unknown => {
    const c = model(t.name, column);
    if (!c || c.computed) return undefined;
    if (column === t.author) return s.fixed.users.find((u) => u.id !== user.id)?.id;
    if (c.type.startsWith("timestamp")) return "2001-02-03T04:05:06Z";
    if (c.type === "date") return "2001-02-03";
    if (c.type === "uuid") return prefixedUuid(s.fixed.prefix);
    if (/^(smallint|integer|bigint|numeric|real|double precision)/.test(c.type)) return 4242424;
    if (c.type === "text" && !c.values && !c.pattern) return "forged";
    return undefined;
  };
  const kept = (t: IRTable, column: string, stored: Row, value: unknown) => {
    const type = model(t.name, column)?.type ?? "text";
    return JSON.stringify(normalize(type, stored[column])) === JSON.stringify(normalize(type, value));
  };

  const staffed = s.fixed.users.filter((u) => u.tenant);
  for (const user of staffed) {
    const otherTenant = s.fixed.tenants.find((x) => x !== user.tenant) ?? null;
    for (const t of writableTables(s)) {
      const own = inTenant(t, user.tenant);
      const theirs = (data.get(t.name) ?? []).filter((r) => s.fixed.tenants.includes(String(r[t.tenant])) && r[t.tenant] !== user.tenant);
      const [first] = own;

      if (first && otherTenant) {
        // A new row claiming another tenant: refused, or stored in the caller's own tenant.
        await run(user, `${t.name}: PUT into another tenant`, `PUT ${t.name} with ${t.tenant} of another tenant`, async (claims) => {
          const id = prefixedUuid(s.fixed.prefix);
          const error = await call(s.client, claims, [{ op: "PUT", table: t.name, id, data: { ...pick(first, t.insertColumns), [t.tenant]: otherTenant } }]);
          const stored = await asRow(s.client, t.name, id);
          const problem = stored && stored[t.tenant] !== user.tenant ? `stored it in tenant ${String(stored[t.tenant])}` : unexpected(error);
          return { error, problem, covered: !unexpected(error) };
        });
      }

      if (t.insert.size) {
        // An insert copying an own row's client columns, with every server-owned column forged,
        // sent twice. Rows whose values this user may not insert are refused; the next is tried.
        // Columns no one can set (generated, identity ALWAYS) are left to Postgres.
        const forgeable = t.serverOwned.filter((c) => c !== "id" && c !== t.tenant && !model(t.name, c)?.computed);
        // A copy of a row can only break a unique key over client columns, as a membership's
        // (project, user) does; copies naming another user of the tenant in the keys to
        // auth.users are tried too.
        const userKeys = (s.model.find((m) => m.name === t.name)?.foreignKeys ?? [])
          .filter((fk) => fk.schema === "auth" && fk.table === "users" && fk.columns.length === 1 && t.insertColumns.includes(fk.columns[0] as string))
          .map((fk) => fk.columns[0] as string);
        const peers = s.fixed.users.filter((u) => u.tenant === user.tenant);
        const copies = own.slice(0, 4).flatMap((row) => [row, ...(userKeys.length ? peers.map((p) => ({ ...row, ...Object.fromEntries(userKeys.map((k) => [k, p.id])) })) : [])]);
        for (const row of copies.slice(0, 12)) {
          const c = await run(user, `${t.name}: insert with forged server-owned columns, then replay`, `PUT ${t.name} with forged ${forgeable.join(", ") || "nothing"}, twice`, async (claims) => {
            const id = prefixedUuid(s.fixed.prefix);
            const fakes = Object.fromEntries(forgeable.map((col) => [col, forged(t, col, user)]).filter(([, v]) => v !== undefined));
            const payload = { ...pick(row, t.insertColumns), ...fakes };
            const error = await call(s.client, claims, [{ op: "PUT", table: t.name, id, data: payload }]);
            if (error) return { error, problem: unexpected(error), covered: false };
            const once = await asRow(s.client, t.name, id);
            if (!once) return { error, problem: "accepted it but stored nothing", covered: false };
            const keptFakes = Object.entries(fakes)
              .filter(([col, v]) => kept(t, col, once, v))
              .map(([col]) => col);
            if (once[t.tenant] !== user.tenant) return { error, problem: `stored it in tenant ${String(once[t.tenant])}`, covered: true };
            if (keptFakes.length) return { error, problem: `kept the forged ${keptFakes.join(", ")}`, covered: true };
            if (t.author && once[t.author] !== user.id) return { error, problem: `stored ${t.author} ${String(once[t.author])}, not the caller`, covered: true };
            const replay = await call(s.client, claims, [{ op: "PUT", table: t.name, id, data: payload }]);
            const twice = await asRow(s.client, t.name, id);
            const [{ n } = { n: 0 }] = await rows<{ n: number }>(s.client, `select count(*)::int as n from public.${ident(t.name)} where id = $1`, [id]);
            const problem = replay ? `refused the replay (${replay.message})` : n !== 1 || !same(once, twice) ? "applied the replay again" : null;
            return { error: replay, problem, covered: true };
          });
          c.unforged = forgeable.filter((col) => forged(t, col, user) === undefined).map((col) => `${t.name}.${col}`);
          if (c.covered) break;
        }
      }

      const target = theirs[0];
      if (target && first) {
        const id = String(target.id);
        const peers = inTenant(t, String(target[t.tenant]));
        const column = (t.updateColumns.length ? t.updateColumns : t.insertColumns).find((col) => changed(t, col, target, peers) !== undefined);
        const family = `${t.name}: PATCH, PUT over and DELETE another tenant's row`;
        // Covered once all three ran: the PATCH needs a column it could really change.
        const patch = await run(user, family, `PATCH another tenant's ${t.name}`, async (claims) => {
          if (!column) return { error: null, problem: null, covered: false };
          const before = await asRow(s.client, t.name, id);
          const error = await call(s.client, claims, [{ op: "PATCH", table: t.name, id, data: { [column]: changed(t, column, target, peers) } }]);
          return { error, problem: same(before, await asRow(s.client, t.name, id)) ? unexpected(error) : `changed its ${column}`, covered: !unexpected(error) };
        });
        const put = await run(user, family, `PUT over another tenant's ${t.name} id`, async (claims) => {
          const before = await asRow(s.client, t.name, id);
          const error = await call(s.client, claims, [{ op: "PUT", table: t.name, id, data: pick(first, t.insertColumns) }]);
          return { error, problem: same(before, await asRow(s.client, t.name, id)) ? unexpected(error) : "changed it", covered: !unexpected(error) };
        });
        const del = await run(user, family, `DELETE another tenant's ${t.name}`, async (claims) => {
          const error = await call(s.client, claims, [{ op: "DELETE", table: t.name, id }]);
          return { error, problem: (await asRow(s.client, t.name, id)) ? unexpected(error) : "deleted it", covered: !unexpected(error) };
        });
        const all = patch.covered && put.covered && del.covered;
        for (const c of [patch, put, del]) c.covered = all;
      }

      if (t.appendOnly && first) {
        const id = String(first.id);
        const column = t.insertColumns.find((col) => changed(t, col, first, own) !== undefined);
        const family = `${t.name}: PATCH and DELETE an append-only row`;
        const results: ForgedCase[] = [];
        for (const op of ["PATCH", "DELETE"] as const) {
          results.push(
            await run(user, family, `${op} an append-only ${t.name}`, async (claims) => {
              if (op === "PATCH" && !column) return { error: null, problem: null, covered: false };
              const before = await asRow(s.client, t.name, id);
              const error = await call(s.client, claims, [{ op, table: t.name, id, ...(op === "PATCH" && column ? { data: { [column]: changed(t, column, first, own) } } : {}) }]);
              const after = await asRow(s.client, t.name, id);
              const problem = !same(before, after) ? `${op === "PATCH" ? "changed" : "deleted"} it` : error ? unexpected(error) : "accepted it without an error";
              return { error, problem, covered: !problem };
            }),
          );
        }
        const all = results.every((c) => c.covered);
        for (const c of results) c.covered = all;
      }

      if (!t.appendOnly && t.updateColumns.length && first) {
        // A legitimate update: proves the PATCH path works for someone, so its refusals mean something.
        for (const row of own.slice(0, 4)) {
          const column = t.updateColumns.find((col) => changed(t, col, row, own) !== undefined);
          if (!column) continue;
          const c = await run(user, `${t.name}: PATCH an own row`, `PATCH ${t.name}.${column} in its own tenant`, async (claims) => {
            const value = changed(t, column, row, own);
            const error = await call(s.client, claims, [{ op: "PATCH", table: t.name, id: String(row.id), data: { [column]: value } }]);
            if (error) return { error, problem: unexpected(error), covered: false };
            const after = await asRow(s.client, t.name, String(row.id));
            return { error, problem: after && kept(t, column, after, value) ? null : "accepted it but changed nothing", covered: true };
          });
          if (c.covered) break;
        }
        const fixed = immutable(t);
        const column = fixed.find((col) => changed(t, col, first, own) !== undefined);
        if (fixed.length) {
          await run(user, `${t.name}: PATCH a column clients may not change`, `PATCH ${t.name}.${column ?? fixed[0]}, which clients may not change`, async (claims) => {
            if (!column) return { error: null, problem: null, covered: false };
            const before = await asRow(s.client, t.name, String(first.id));
            const error = await call(s.client, claims, [{ op: "PATCH", table: t.name, id: String(first.id), data: { [column]: changed(t, column, first, own) } }]);
            const after = await asRow(s.client, t.name, String(first.id));
            const problem = !same(before, after) ? `changed its ${column}` : error ? unexpected(error) : "accepted it without an error";
            return { error, problem, covered: !problem };
          });
        }
      }
    }

    // Tables no client writes, with a row that would otherwise be valid (for the membership
    // table, the caller's own membership as the first role), and a table that does not exist.
    for (const t of s.ir.tables.filter((x) => !writableTables(s).includes(x))) {
      const m = s.ir.membership;
      const mine = inTenant(t, user.tenant);
      const source = (t.name === m.table ? mine.find((r) => r[m.user] === user.id) : undefined) ?? mine[0];
      const payload: Row = source ? Object.fromEntries(Object.entries(source).filter(([c]) => c !== "id")) : {};
      if (t.name === m.table) payload[m.role] = s.ir.claims.roles[0];
      await run(user, `${t.name}: read-only`, `PUT ${t.name}${t.name === m.table ? ` making itself ${s.ir.claims.roles[0]}` : ""}`, async (claims) => {
        const id = prefixedUuid(s.fixed.prefix);
        const error = await call(s.client, claims, [{ op: "PUT", table: t.name, id, data: payload }]);
        const problem = (await asRow(s.client, t.name, id)) ? "stored it" : error ? unexpected(error, NOT_WRITABLE) : "accepted it without an error";
        return { error, problem, covered: true };
      });
    }
    await run(user, "unknown table", "PUT samesight_no_such_table", async (claims) => {
      const error = await call(s.client, claims, [{ op: "PUT", table: "samesight_no_such_table", id: prefixedUuid(s.fixed.prefix), data: {} }]);
      return { error, problem: error ? unexpected(error, NOT_WRITABLE) : "accepted it without an error", covered: true };
    });
  }

  // A signed-up user with no membership: its token carries no tenant, so nothing is writable.
  for (const user of s.fixed.users.filter((u) => !u.tenant)) {
    for (const t of writableTables(s)) {
      const [row] = inTenant(t, s.fixed.tenants[0] ?? null);
      if (!row) continue;
      await run(user, `${t.name}: PUT without a membership`, `PUT ${t.name} into tenant A with no membership`, async (claims) => {
        const id = prefixedUuid(s.fixed.prefix);
        const error = await call(s.client, claims, [{ op: "PUT", table: t.name, id, data: { ...pick(row, t.insertColumns), [t.tenant]: row[t.tenant] } }]);
        const problem = (await asRow(s.client, t.name, id)) ? "stored it" : error ? unexpected(error, NO_TENANT) : "accepted it without an error";
        return { error, problem, covered: !problem };
      });
    }
  }
  return cases;
}

/** Forges batches over datasets until every case of the policy has run, or the datasets run out. */
export async function checkWritePath(s: Setup, worlds: World[], prepare?: (client: pg.Client) => Promise<void>): Promise<{ findings: Finding[]; cases: ForgedCase[] }> {
  const needed = writeFamilies(s);
  const cases: ForgedCase[] = [];
  let used = 0;
  for (const world of worlds) {
    used++;
    const done = new Set(cases.filter((c) => c.covered).map((c) => c.family));
    cases.push(...(await withWorld(s, world, () => forgeBatches(s, prepare, done))));
    const covered = new Set(cases.filter((c) => c.covered).map((c) => c.family));
    if (needed.every((f) => covered.has(f))) break;
  }
  const covered = new Set(cases.filter((c) => c.covered).map((c) => c.family));
  const missing = needed.filter((f) => !covered.has(f));
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const c of cases.filter((x) => x.problem)) {
    const detail = `${c.user.label}: ${c.what}: apply_batch ${c.problem}`;
    if (!seen.has(detail)) findings.push({ status: "fail", check: "write path", detail });
    seen.add(detail);
  }
  if (missing.length) {
    findings.push({
      status: "fail",
      check: "write path",
      detail: `never exercised in ${used} datasets (no rows to try them on, or no user's legitimate write went through):\n${missing.map((m) => `    ${m}`).join("\n")}`,
    });
  }
  const unforged = [...new Set(cases.flatMap((c) => c.unforged ?? []))];
  if (unforged.length) {
    findings.push({ status: "warn", check: "write path", detail: `no forged value for server-owned ${unforged.join(", ")} (an unsupported type); a client could set them unnoticed` });
  }
  if (!findings.some((f) => f.status === "fail")) {
    findings.push({
      status: "ok",
      check: "write path",
      detail: `${cases.length} batches from ${new Set(cases.map((c) => c.user.id)).size} users over ${used} datasets: every forgery refused or rewritten, and a legitimate insert, replay and (where the policy allows one) update went through for each writable table`,
    });
  }
  return { findings, cases };
}
