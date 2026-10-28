/**
 * Which RLS policies decided a row of the counterexample, as audit/coverage.ts measures
 * them: inside a transaction that is always rolled back, a permissive policy is read alone
 * (every other policy on the table dropped), and a restrictive one is dropped alone. For a
 * leak, the policies that refuse the row; for a gap, those that let the user read it. Runs
 * while the dataset is still in the database.
 */

import type pg from "pg";
import { ident } from "samesight/compiler";
import { dropPolicyTriggers, readAll } from "../audit/coverage.ts";
import { rolledBack, rows } from "../db.ts";
import type { RowReport } from "../report.ts";

/** At most this many rows get verdicts: a counterexample is small. */
const MAX_ROWS = 10;

interface Policy {
  name: string;
  permissive: boolean;
  /** A read policy (FOR SELECT or FOR ALL) that applies to authenticated users. */
  reads: boolean;
}

/**
 * Sets `policies` (or `policiesNote`, when they cannot be evaluated) on each leak and gap.
 * Never throws: what it cannot evaluate it says in the note.
 */
export async function policyVerdicts(client: pg.Client, reports: RowReport[], claimsOf: (userId: string) => Record<string, unknown> | undefined): Promise<void> {
  const todo = reports.filter((r) => r.kind === "leak" || r.kind === "gap").slice(0, MAX_ROWS);
  if (!todo.length) return;
  let triggers: string[];
  try {
    triggers = await dropPolicyTriggers(client);
  } catch (e) {
    for (const r of todo) r.policiesNote = `not evaluated: ${(e as Error).message}`;
    return;
  }
  if (triggers.length) {
    for (const r of todo) r.policiesNote = `not evaluated: they are read by dropping policies in a transaction that is rolled back, and event triggers would run on that (${triggers.join(", ")})`;
    return;
  }
  for (const r of todo) {
    const claims = claimsOf(r.user.id);
    if (!claims) {
      r.policiesNote = "not evaluated: the user's token is not known";
      continue;
    }
    try {
      await rolledBack(client, () => verdicts(client, r, claims));
    } catch (e) {
      r.policiesNote = `not evaluated: ${(e as Error).message}`;
    }
  }
}

async function verdicts(client: pg.Client, r: RowReport, claims: Record<string, unknown>): Promise<void> {
  const all = await rows<Policy>(
    client,
    `select p.polname as name, p.polpermissive as permissive,
            (p.polcmd in ('r', '*') and (0::oid = any(p.polroles) or 'authenticated'::regrole::oid = any(p.polroles))) as reads
       from pg_catalog.pg_policy p
       join pg_catalog.pg_class c on c.oid = p.polrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = $1
      order by 1`,
    [r.table],
  );
  const reads = all.filter((p) => p.reads);
  const permissive = reads.filter((p) => p.permissive);
  const restrictive = reads.filter((p) => !p.permissive);
  if (!permissive.length) {
    r.policies = [];
    r.policiesNote = `no permissive read policy on ${r.table} applies to authenticated users, so RLS returns none of its rows`;
    return;
  }
  // Whether the user reads the row with these policies dropped.
  const returns = async (drop: Policy[]): Promise<boolean> => {
    await client.query("savepoint samesight_verdict");
    try {
      for (const p of drop) await client.query(`drop policy ${ident(p.name)} on public.${ident(r.table)}`);
      const [seen] = await readAll(client, r.table, [r.id], [{ claims }]);
      if (seen instanceof Error || !seen) throw seen ?? new Error("no read");
      return seen.has(r.id);
    } finally {
      await client.query("rollback to savepoint samesight_verdict");
    }
  };
  const whole = await returns([]);
  const verdicts: NonNullable<RowReport["policies"]> = [];
  for (const p of permissive) {
    const alone = await returns(all.filter((x) => x.name !== p.name));
    verdicts.push({ name: p.name, permissive: true, verdict: alone ? "allows" : "refuses" });
  }
  const allowed = verdicts.some((v) => v.verdict === "allows");
  for (const p of restrictive) {
    // With the full RLS returning the row, every restrictive policy lets it through.
    const refuses = !whole && allowed && (await returns([p]));
    verdicts.push({ name: p.name, permissive: false, verdict: refuses ? "refuses" : "allows" });
  }
  r.policies = verdicts;
  if (r.kind === "leak" && whole) r.policiesNote = "RLS returns the row when read again";
  else if (r.kind === "gap" && !whole) r.policiesNote = "RLS refuses the row when read again";
  else if (r.kind === "leak" && allowed && !verdicts.some((v) => !v.permissive && v.verdict === "refuses")) {
    r.policiesNote = "no one policy refuses it: the restrictive policies refuse it together";
  }
}
