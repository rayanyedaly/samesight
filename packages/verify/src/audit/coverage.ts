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
import { type ClaimReads, claimReads, classify, ident, outputTable, render, type Stream, type Token, tokenize } from "samesight/compiler";
import { rows } from "../db.ts";
import type { DeviceRow } from "../differential/device.ts";
import type { Run } from "../differential/run.ts";
import type { Inserted } from "../differential/world.ts";
import type { Finding } from "../report.ts";
import { claimKey, qualified } from "./claims.ts";
import { signInReason } from "./signin.ts";

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
  /** Its queries read nothing of the user: every user gets the same rows. */
  sameForAll: boolean;
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
const HARMLESS_TRIGGERS = new Set(["pgrst_ddl_watch:extensions.pgrst_ddl_watch", "pgrst_drop_watch:extensions.pgrst_drop_watch"]);

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
  // Functions print schema-qualified (an empty search_path), so a look-alike elsewhere is not taken for PostgREST's.
  // Only triggers that fire in a normal session: O (origin) and A (always), not R (replica) or D.
  const triggers = (
    await qualified(client, () =>
      rows<{ name: string; fn: string }>(
        client,
        `select e.evtname as name, e.evtfoid::pg_catalog.regproc::text as fn from pg_catalog.pg_event_trigger e
          where e.evtenabled in ('O', 'A') and e.evtevent in ('ddl_command_start', 'ddl_command_end', 'sql_drop')
            and (e.evttags is null or 'DROP POLICY' = any(e.evttags))
          order by 1`,
      ),
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
      const sameForAll = alike(found);
      const reachable = found.unreadable.length === 0 && claims.every((k) => held.has(k));
      return { table: p.table, name: p.name, permissive: p.permissive, qual: p.qual as string, sameForAll, claims, reachable, tally: { allowed: 0, refused: 0 } };
    });
  const protectedTables = new Set(
    (await rows<{ table: string }>(client, "select c.relname as table from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any($1) and c.relrowsecurity", [synced])).map(
      (r) => r.table,
    ),
  );
  for (const t of synced) {
    if (!protectedTables.has(t)) notes.push({ status: "warn", check: "coverage", detail: `${t}: RLS is off, so there is no policy to measure` });
    else if (!scoped.some((p) => p.table === t)) notes.push({ status: "warn", check: "coverage", detail: `${t}: no read policy for authenticated users to measure` });
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

/**
 * True when what a rule reads of the token is the same for every run user: claims all
 * users share, or whether the user id is null (every run user has one). Nothing it cannot follow.
 */
function alike(found: ClaimReads): boolean {
  if (found.unreadable.length) return false;
  return found.reads.every((r) => {
    const cls = classify(r.path);
    return cls === "shared" || (cls === "identity" && r.compared.kind === "literals" && r.compared.values.every((v) => v === null));
  });
}

/** The claim keys reads tell users apart by: neither the user id nor one every user shares. */
function userClaims(reads: { path: string[] }[]): string[] {
  return [...new Set(reads.filter((r) => !["identity", "shared"].includes(classify(r.path))).map((r) => claimKey(r.path)))].sort();
}

/**
 * Per stream and table. PowerSync puts queries that differ only in top-level conditions
 * comparing auth.parameter() with literals in one bucket, named after the first stream:
 * those streams are one unit, since a device cannot tell which of them sent a row. Only
 * streams without CTEs are grouped; anything less plain keeps its own unit.
 */
export function streamUnits(streams: Stream[], kind: "streams" | "bucket definitions" = "streams"): Omit<StreamUnit, "reachable">[] {
  const dialect = kind === "streams" ? "streams" : "rules";
  // Union-find over stream/table nodes, joined through the bucket a query lands in.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const join = (a: string, b: string) => parent.set(find(a), find(b));
  const nodes = new Map<string, { stream: string; table: string; reads: ClaimReads[] }>();
  for (const st of streams) {
    if (!st.autoSubscribe) continue;
    for (const q of st.queries) {
      let table: string;
      try {
        table = outputTable(q.sql).table;
      } catch {
        continue;
      }
      const node = `${st.name}\u0000${table}`;
      // What decides the rows: the query, and the stream's CTEs or the bucket's parameter queries.
      const reads = [q.sql, ...st.ctes.values()].map((sql) => claimReads(sql, dialect));
      const known = nodes.get(node);
      nodes.set(node, { stream: st.name, table, reads: [...(known?.reads ?? []), ...reads] });
      parent.set(node, parent.get(node) ?? node);
      const bucket = kind === "streams" && st.ctes.size === 0 ? bucketKey(q.sql) : undefined;
      if (bucket !== undefined) {
        const key = `bucket\u0000${bucket}`;
        parent.set(key, parent.get(key) ?? key);
        join(node, key);
      }
    }
  }
  const units = new Map<string, Omit<StreamUnit, "reachable">>();
  for (const [node, n] of nodes) {
    const root = find(node);
    const unit = units.get(root) ?? { streams: [], table: n.table, sameForAll: true, claims: [], tally: { allowed: 0, refused: 0 } };
    units.set(root, unit);
    if (!unit.streams.includes(n.stream)) unit.streams.push(n.stream);
    unit.claims = [...new Set([...unit.claims, ...userClaims(n.reads.flatMap((r) => r.reads))])].sort();
    unit.sameForAll &&= n.reads.every(alike);
  }
  return [...units.values()].sort((a, b) => a.table.localeCompare(b.table) || (a.streams[0] ?? "").localeCompare(b.streams[0] ?? ""));
}

/**
 * The query without its top-level AND conditions that only compare auth.parameter() with
 * literals; undefined when it has a top-level OR, or a condition with a subquery that reads
 * the token, so nothing is grouped that PowerSync would keep apart.
 */
function bucketKey(sql: string): string | undefined {
  let t: Token[];
  try {
    t = tokenize(sql);
  } catch {
    return undefined;
  }
  const isWord = (x: Token | undefined, w: string) => x?.kind === "word" && x.text === w;
  // Top-level positions, outside parentheses.
  const depthAt: number[] = [];
  let depth = 0;
  for (const x of t) {
    if (x.kind === "symbol" && x.text === "(") depth++;
    depthAt.push(depth);
    if (x.kind === "symbol" && x.text === ")") depth--;
  }
  const where = t.findIndex((x, i) => depthAt[i] === 0 && isWord(x, "where"));
  if (where === -1) return render(t);
  const terms: Token[][] = [[]];
  for (let i = where + 1; i < t.length; i++) {
    if (depthAt[i] === 0 && isWord(t[i], "or")) return undefined;
    if (depthAt[i] === 0 && isWord(t[i], "and")) terms.push([]);
    else terms.at(-1)?.push(t[i] as Token);
  }
  const kept = terms.map(render).filter((term) => {
    const found = claimReads(term, "streams");
    const filter =
      found.reads.length > 0 &&
      found.unreadable.length === 0 &&
      !/\bselect\b/i.test(term) &&
      found.reads.every((r) => r.compared.kind === "literals" && !r.inSubquery && classify(r.path) !== "identity");
    return !filter;
  });
  return `${render(t.slice(0, where))}\u0000${kept.sort().join("\u0000")}`;
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

/**
 * Adds one dataset's counts: run inside withWorld, after the comparison, before any failure.
 * `fixed`: the run's own rows kept for the whole run (the access token hook's), measured with
 * every dataset but counted as inserted once.
 */
export async function measure(s: Run, cov: Coverage, inserted: Inserted[], devices: Map<string, DeviceRow[]>, fixed: Inserted[] = []): Promise<void> {
  cov.datasets++;
  const ids = idsOf([...inserted, ...fixed]);
  for (const [t, list] of idsOf(cov.datasets === 1 ? [...inserted, ...fixed] : inserted)) cov.inserted.set(t, (cov.inserted.get(t) ?? 0) + list.length);
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
        // A policy that cannot be measured (a lock wait, a table the role does not own) is a gap, never a failed run.
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
        } catch (e) {
          p.tally.error ??= (e as Error).message;
        } finally {
          await s.client.query("rollback to savepoint samesight_policy");
        }
      }
    }
  } catch (e) {
    for (const p of cov.policies) if (ids.get(p.table)?.length) p.tally.error ??= (e as Error).message;
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

/**
 * True while a rule run users can exercise has never been seen allowing a row: more random
 * rows can match it. One seen only allowing usually cannot refuse (a stream of shared rows,
 * an owner policy beside a wider one), so it does not keep passes going.
 */
export function pending(cov: Coverage): boolean {
  const open = (x: { reachable: boolean; sameForAll: boolean; tally: Tally }) => !x.sameForAll && x.reachable && x.tally.error === undefined && x.tally.allowed === 0;
  return (cov.triggers.length === 0 && cov.policies.some(open)) || cov.units.some(open);
}

const SIDES: Record<State, [string, string]> = {
  exercised: ["", ""],
  "only allowed": ["only allowed rows seen", "only sent rows seen"],
  "only refused": ["only refused rows seen", "only withheld rows seen"],
  "not seen": ["no row seen either way", "no row seen either way"],
};

/** Why a rule was not seen both ways, as far as the run can tell. */
function reason(cov: Coverage, x: { table: string; claims: string[]; reachable: boolean; tally: Tally }, held: ReadonlySet<string>, together: boolean, kind: "permissive" | "restrictive" | "stream"): string {
  if (!cov.inserted.get(x.table)) return `no ${x.table} row was inserted`;
  const missing = x.claims.filter((k) => !held.has(k));
  // Sign-in state is what Supabase Auth gives every password user (signin.ts), not a claim audit holds.
  const signIn = missing.filter((k) => classify(k.split(".")) === "auth-state");
  const unheld = missing.filter((k) => !signIn.includes(k));
  if (unheld.length) return `it reads ${unheld.join(", ")}, which no run user holds; see Claims`;
  const signInWhy = signInReason(signIn);
  if (signInWhy) return signInWhy;
  if (!x.reachable) return "it reads the token in a way audit cannot follow; see Claims";
  const state = stateOf(x.tally);
  if (kind === "restrictive") return state === "only refused" ? "it let no row through" : "it kept out no row the other policies let through";
  if (kind === "permissive" && state !== "only refused") return "every row it kept from a user, another policy let through";
  if (kind === "stream" && state === "only allowed") return "it sent every generated row to every run user";
  if (x.claims.length > 1 && together) return "no run user holds the values it needs together";
  return "no generated row matched it";
}

/**
 * The Coverage section: a summary, then each rule not seen both ways, with the side seen
 * and why. `held` are the claim keys run users hold; `together` is true when users could
 * not hold every combination of their values.
 */
export function coverageFindings(cov: Coverage, held: ReadonlySet<string>, together: boolean): Finding[] {
  const out: Finding[] = [];
  const measured = cov.triggers.length ? [] : cov.policies;
  const policyLine = (p: ScopedPolicy): Finding | undefined => {
    const name = `policy "${p.name}" on ${p.table}${p.permissive ? "" : " (restrictive)"}`;
    if (p.tally.error !== undefined) return { status: "warn", check: "coverage", detail: `${name}: a read failed, so it was not measured (${p.tally.error})` };
    const state = stateOf(p.tally);
    if (state === "exercised") return undefined;
    if (p.sameForAll) return { status: "ok", check: "coverage", detail: `${name}: ${SIDES[state][0]}; it reads nothing of the user, so it applies to every user alike` };
    return { status: "warn", check: "coverage", detail: `${name}: ${SIDES[state][0]} (${reason(cov, p, held, together, p.permissive ? "permissive" : "restrictive")})` };
  };
  const unitLine = (u: StreamUnit): Finding | undefined => {
    const name = u.streams.length > 1 ? `streams ${u.streams.join(" + ")} (one bucket), ${u.table}` : `stream ${u.streams[0]}, ${u.table}`;
    if (u.tally.error !== undefined) return { status: "warn", check: "coverage", detail: `${name}: not measured (${u.tally.error})` };
    const state = stateOf(u.tally);
    if (state === "exercised") return undefined;
    if (u.sameForAll) return { status: "ok", check: "coverage", detail: `${name}: ${SIDES[state][1]}; it reads nothing of the user, so every user gets the same rows` };
    return { status: "warn", check: "coverage", detail: `${name}: ${SIDES[state][1]} (${reason(cov, u, held, together, "stream")})` };
  };
  const policyLines = measured.map(policyLine);
  const unitLines = cov.units.map(unitLine);
  const both = (n: number, of: number, what: string, verb: string) => `${n} of ${of} ${what} ${verb}`;
  const exercised = (lines: (Finding | undefined)[]) => lines.filter((l) => l === undefined).length;
  const parts: string[] = [];
  if (measured.length) {
    const n = exercised(policyLines);
    parts.push(`${both(n, measured.length, measured.length === 1 ? "RLS read policy on synced tables" : "RLS read policies on synced tables", n === 1 ? "was seen both allowing and refusing a run user a row" : "were seen both allowing and refusing a run user a row")}${n < measured.length ? `; ${measured.length - n} ${measured.length - n === 1 ? "was" : "were"} not (below)` : ""}.`);
  }
  if (cov.units.length) {
    const n = exercised(unitLines);
    parts.push(`${both(n, cov.units.length, cov.units.length === 1 ? "stream/table pair" : "stream/table pairs", "both sent and withheld a row")}.`);
  }
  if (parts.length) out.push({ status: "ok", check: "coverage", detail: parts.join(" ") });
  out.push(...[...policyLines, ...unitLines].filter((l): l is Finding => l !== undefined), ...cov.notes);
  return out;
}

/** Rules that tell users apart and were not seen both ways: what the Differential line owns up to. */
export function untested(cov: Coverage): number {
  const policies = cov.triggers.length ? [] : cov.policies.filter((p) => !p.sameForAll);
  return [...policies, ...cov.units.filter((u) => !u.sameForAll)].filter((x) => x.tally.error !== undefined || stateOf(x.tally) !== "exercised").length;
}

/** The section's title: what it covers, and how much when a failure or the time limit cut the run short. */
export function coverageTitle(cov: Coverage, result: { findings: Finding[]; stopped?: boolean }): string {
  const cut = result.findings.some((f) => f.status === "fail") ? " before the failure" : result.stopped ? " before the time limit" : "";
  return cut ? `Coverage of the ${cov.datasets} datasets run${cut}` : "Coverage (per policy and per stream; OR branches and the queries of one stream are not told apart)";
}

/** The Differential's ok line, owning up to the rules it passed without testing both ways. */
export function qualifyDifferential(findings: Finding[], cov: Coverage): Finding[] {
  const n = untested(cov);
  if (!n) return findings;
  return findings.map((f) => (f.status === "ok" && f.check === "differential" ? { ...f, detail: `${f.detail}; ${n} ${n === 1 ? "rule was" : "rules were"} not tested both ways (see Coverage)` } : f));
}
