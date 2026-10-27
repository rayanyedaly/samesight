/**
 * Static checks on the sync config, against the policy:
 *   - the file holds only streams (no bucket_definitions or keys this check cannot read);
 *   - every query and CTE carries the tenant gate as a top-level AND term;
 *   - a query streams a table only to roles the policy lets read it, and never a column
 *     hidden from that role;
 *   - every IN <name> names a CTE of the same stream;
 *   - every table a role reads under RLS reaches that role's devices (a gap is a warning:
 *     the app is missing data, nothing leaked).
 * Row filters within a tenant and role (which inspections an inspector gets) are not
 * compared here: the manifest check proves generated files are unedited, and the
 * differential test proves the rows.
 */

import { ident, type IR, type IRTable, type ParsedQuery, parseQuery, render, type Stream, tokenize } from "samesight/compiler";
import type { Finding } from "../report.ts";

const canonical = (sql: string) => render(tokenize(sql));

export function checkStreams(ir: IR, streams: Stream[]): Finding[] {
  const out: Finding[] = [];
  const fail = (detail: string) => out.push({ status: "fail", check: "streams", detail });
  const byName = new Map(ir.tables.map((t) => [t.name, t]));
  const tenantClaim = `auth.parameter('${ir.claims.tenant}')`;
  const tenantGate = (t: IRTable & { tenant: string }) => `${ident(t.tenant)} = ${tenantClaim}`;
  const tenantGates = (t: IRTable & { tenant: string }) => new Set([canonical(tenantGate(t)), canonical(`${tenantClaim} = ${ident(t.tenant)}`)]);
  // Every query and CTE carries the tenant gate, except over a shared table (tenant: null),
  // whose rows every tenant reads; there, any tenant term is a policy the compiler did not write.
  const gateProblem = (t: IRTable, q: ParsedQuery): string | null => {
    if (t.tenant !== null) return q.terms.some((term) => tenantGates(t as IRTable & { tenant: string }).has(term)) ? null : `has no tenant gate (${tenantGate(t as IRTable & { tenant: string })})`;
    return null;
  };
  const roleOf = new Map<string, string>();
  for (const r of ir.claims.roles) {
    roleOf.set(canonical(`auth.parameter('${ir.claims.role}') = '${r}'`), r);
    roleOf.set(canonical(`'${r}' = auth.parameter('${ir.claims.role}')`), r);
  }
  const reached = new Set<string>();

  for (const stream of streams) {
    const cteNames = new Set([...stream.ctes.keys()].map((n) => n.toLowerCase()));
    // IN <name> is a CTE reference; it must be one of this stream's.
    const checkRefs = (where: string, q: ParsedQuery) => {
      for (const ref of q.inRefs) {
        if (!cteNames.has(ref.toLowerCase())) fail(`${where} uses IN ${ref}, which is not a CTE of stream ${stream.name}`);
      }
    };
    for (const [cte, sql] of stream.ctes) {
      const where = `${stream.name}.with.${cte}`;
      const q = read(where, sql, fail);
      if (!q) continue;
      const t = byName.get(q.table);
      if (!t) fail(`${where} reads ${q.table}, which the policy does not cover`);
      else {
        const problem = gateProblem(t, q);
        if (problem) fail(`${where} ${problem}`);
      }
    }
    for (const { label, sql } of stream.queries) {
      const where = `${stream.name}.${label}`;
      const q = read(where, sql, fail);
      if (!q) continue;
      const t = byName.get(q.table);
      if (!t) {
        fail(`${where} streams ${q.table}, which the policy does not cover`);
        continue;
      }
      const problem = gateProblem(t, q);
      if (problem) fail(`${where} (${t.name}) ${problem}`);
      checkRefs(where, q);

      // A query with no role gate (or only gates on unknown roles) sends its rows to every role.
      const gated = [...new Set(q.terms.map((term) => roleOf.get(term)).filter((r): r is string => r !== undefined))];
      const roles = gated.length ? gated : ir.claims.roles;
      // Names compared case-insensitively: missing a hidden column costs more than a false alarm.
      const projected = new Set([...q.projectedNames].map((n) => n.toLowerCase()));
      for (const role of roles) {
        if (!t.read.has(role)) {
          fail(`${where} streams ${t.name} to ${role}, which has no read rule for it`);
          continue;
        }
        const hidden = (t.hide.get(role) ?? []).filter((c) => q.projection === "*" || projected.has(c.toLowerCase()));
        if (hidden.length) fail(`${where} sends ${t.name}.${hidden.join(", ")} to ${role}, which the policy hides from it`);
        reached.add(`${t.name}\u0000${role}`);
      }
    }
  }

  for (const t of ir.tables) {
    for (const role of t.read.keys()) {
      if (!reached.has(`${t.name}\u0000${role}`)) {
        out.push({ status: "warn", check: "streams", detail: `${role} reads ${t.name} under RLS, but no stream sends it` });
      }
    }
  }
  if (!out.some((f) => f.status === "fail")) {
    const queries = streams.reduce((n, s) => n + s.queries.length, 0);
    out.unshift({
      status: "ok",
      check: "streams",
      detail: `${queries} queries in ${streams.length} streams carry the tenant gate${ir.tables.some((t) => t.tenant === null) ? " (shared tables aside)" : ""} and reach only roles with a read rule`,
    });
  }
  return out;
}

function read(where: string, sql: string, fail: (detail: string) => void): ParsedQuery | undefined {
  try {
    return parseQuery(sql);
  } catch (e) {
    fail(`${where} cannot be read: ${(e as Error).message}`);
    return undefined;
  }
}
