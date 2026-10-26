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

import { ident, type IR, type IRTable } from "samesight/compiler";
import { parse } from "yaml";
import type { Finding } from "../report.ts";
import { type ParsedQuery, parseQuery, render, tokenize } from "./stream-sql.ts";

export interface Stream {
  name: string;
  ctes: Map<string, string>;
  /** Devices subscribe without being asked (auto_subscribe: true). */
  autoSubscribe: boolean;
  /** Labelled as the config names them: "query", or "queries[n]". */
  queries: { label: string; sql: string }[];
}

/** Keys this check reads or knows to carry no SQL. Anything else is refused, not skipped. */
const TOP_LEVEL = new Set(["config", "streams"]);
const STREAM_KEYS = new Set(["auto_subscribe", "priority", "with", "query", "queries"]);

/** The streams of an Edition 3 sync config; throws on anything it cannot read in full. */
export function parseStreams(yaml: string): Stream[] {
  const doc = parse(yaml) as unknown;
  if (!isObject(doc)) throw new Error("the sync config is not a YAML mapping");
  const unknown = Object.keys(doc).filter((k) => !TOP_LEVEL.has(k));
  if (unknown.length) throw new Error(`the sync config has ${unknown.join(", ")}, which this check does not read; only streams are supported`);
  if (!isObject(doc.streams)) throw new Error("the sync config has no streams: section");
  return Object.entries(doc.streams).map(([name, s]) => {
    if (!isObject(s)) throw new Error(`stream ${name} is not a mapping`);
    const extra = Object.keys(s).filter((k) => !STREAM_KEYS.has(k));
    if (extra.length) throw new Error(`stream ${name} has ${extra.join(", ")}, which this check does not read`);
    const ctes = s.with ?? {};
    if (!isObject(ctes) || !Object.values(ctes).every((v) => typeof v === "string")) throw new Error(`stream ${name}: with must map names to SQL strings`);
    if (s.query !== undefined && typeof s.query !== "string") throw new Error(`stream ${name}: query must be a SQL string`);
    if (s.queries !== undefined && !(Array.isArray(s.queries) && s.queries.every((q) => typeof q === "string"))) {
      throw new Error(`stream ${name}: queries must be a list of SQL strings`);
    }
    return {
      name,
      autoSubscribe: s.auto_subscribe === true,
      ctes: new Map(Object.entries(ctes as Record<string, string>)),
      queries: [
        ...(s.query !== undefined ? [{ label: "query", sql: s.query as string }] : []),
        ...((s.queries ?? []) as string[]).map((sql, n) => ({ label: `queries[${n}]`, sql })),
      ],
    };
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const canonical = (sql: string) => render(tokenize(sql));

export function checkStreams(ir: IR, streams: Stream[]): Finding[] {
  const out: Finding[] = [];
  const fail = (detail: string) => out.push({ status: "fail", check: "streams", detail });
  const byName = new Map(ir.tables.map((t) => [t.name, t]));
  const tenantClaim = `auth.parameter('${ir.claims.tenant}')`;
  const tenantGate = (t: IRTable) => `${ident(t.tenant)} = ${tenantClaim}`;
  const tenantGates = (t: IRTable) => new Set([canonical(tenantGate(t)), canonical(`${tenantClaim} = ${ident(t.tenant)}`)]);
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
      else if (!q.terms.some((term) => tenantGates(t).has(term))) fail(`${where} has no tenant gate (${tenantGate(t)})`);
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
      if (!q.terms.some((term) => tenantGates(t).has(term))) fail(`${where} (${t.name}) has no tenant gate (${tenantGate(t)})`);
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
      detail: `${queries} queries in ${streams.length} streams carry the tenant gate and reach only roles with a read rule`,
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
