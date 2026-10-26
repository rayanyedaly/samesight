/**
 * Mutants of the generated access layer: the mistakes a hand edit or an emitter bug would
 * make. The mutation test passes only if the differential catches every one.
 *
 * Sync mutants widen a stream query or CTE: drop the tenant gate, drop the role gate, drop
 * one row filter, or project every column where some are hidden. Each becomes a stream of
 * its own (samesight_m1, samesight_m2, ...) in one combined config, so one PowerSync reload
 * tests them all. Identical queries share a bucket whatever their stream, so a leaked row is
 * put down to a mutant by running its query for that user in Postgres (explain.ts).
 *
 * RLS mutants re-create one read policy inside the rolled-back transaction that reads
 * through RLS: without its tenant gate, with one role's rule widened to every row, or with
 * one role's rule removed. Wider RLS shows as rows no device received; narrower RLS as
 * synced rows RLS refuses.
 *
 * A mutant that provably changes nothing (an equivalent mutant) is listed, with the reason,
 * instead of being run.
 */

import { emitMigration, ident, type IR, type IRTable, type Rule } from "samesight/compiler";
import { stringify } from "yaml";
import { splitSqlStatements } from "../sql.ts";
import { parseQuery, sqlText, tokenize } from "../static/stream-sql.ts";
import type { Stream } from "../static/streams.ts";

export interface SyncMutant {
  name: string;
  description: string;
  ctes: Record<string, string>;
  queries: string[];
}

export interface RlsMutant {
  name: string;
  description: string;
  /** Run as the connecting role, inside the RLS read's transaction. */
  statements: string[];
}

export interface Equivalent {
  description: string;
  reason: string;
}

const canonicalTerm = (sql: string) => sqlText(tokenize(sql));

function gates(ir: IR) {
  const tenantClaim = `auth.parameter('${ir.claims.tenant}')`;
  const tenant = (t: IRTable) => new Set([canonicalTerm(`${ident(t.tenant)} = ${tenantClaim}`), canonicalTerm(`${tenantClaim} = ${ident(t.tenant)}`)]);
  const roleOf = new Map<string, string>();
  for (const r of ir.claims.roles) {
    roleOf.set(canonicalTerm(`auth.parameter('${ir.claims.role}') = '${r}'`), r);
    roleOf.set(canonicalTerm(`'${r}' = auth.parameter('${ir.claims.role}')`), r);
  }
  return { tenant, roleOf };
}

const build = (projection: string, table: string, terms: string[]) =>
  `SELECT ${projection} FROM ${ident(table)}${terms.length ? ` WHERE ${terms.join(" AND ")}` : ""}`;

/**
 * `other` already receives every row and column of `t` that `role` does, so sending
 * `role`'s query to `other` too adds nothing: it reads every row of its tenant, or has
 * the same rule through parents it is covered on in turn, and hides nothing `role` sees.
 */
function covers(ir: IR, t: IRTable, other: string, role: string, seen = new Set<string>()): boolean {
  const hiddenFromRole = new Set(t.hide.get(role) ?? []);
  if (!(t.hide.get(other) ?? []).every((c) => hiddenFromRole.has(c))) return false;
  const mine = t.read.get(role);
  const theirs = t.read.get(other);
  if (theirs === undefined || mine === undefined) return false;
  if (allOfTenant(ir, t, other, theirs)) return true;
  if (JSON.stringify(theirs) !== JSON.stringify(mine) || seen.has(t.name)) return false;
  seen.add(t.name);
  return parents(mine).every((p) => {
    const parent = ir.tables.find((x) => x.name === p);
    return parent !== undefined && covers(ir, parent, other, role, seen);
  });
}

/** The tables a rule reads through via. */
function parents(rule: Rule | undefined): string[] {
  if (!rule || rule === true) return [];
  if (rule.kind === "via") return [rule.parent];
  if (rule.kind === "and" || rule.kind === "or") return rule.items.flatMap((i) => parents(i));
  return [];
}

export type Unique = (table: string, column: string) => boolean;

/** A via over a column a composite (tenant, column) -> parent (tenant, key) foreign key ties to the parent's tenant. */
function linkedVia(t: IRTable, rule: Rule): rule is Extract<Rule, { kind: "via" }> {
  return rule !== true && rule.kind === "via" && t.tenantLinked.some((l) => l.column === rule.column && l.parent === rule.parent && l.key === rule.parentKey);
}

/**
 * The rule keeps rows in the reader's tenant without the table's own tenant gate: RLS on the
 * parent does it. Only when the parent key is unique on its own: a key unique per tenant
 * matches a visible parent in the reader's tenant from a child in another.
 */
function tenantBound(t: IRTable, rule: Rule, unique: Unique): boolean {
  if (rule === true) return false;
  if (linkedVia(t, rule)) return unique(rule.parent, rule.parentKey);
  return rule.kind === "and" && rule.items.some((i) => tenantBound(t, i, unique));
}

/** `column IN <query over parent>` stays in the tenant: a composite foreign key to the parent's key, unique on its own, which the query projects. */
function linkedCte(t: IRTable, column: string, cte: string, unique: Unique): boolean {
  const c = parseQuery(cte);
  const key = c.projection === "*" || c.projection.length !== 1 ? undefined : (c.projection[0] ?? "").trim().replace(/^"(.*)"$/, "$1");
  return t.tenantLinked.some((l) => l.column === column && l.parent === c.table && l.key === key && unique(l.parent, l.key));
}

/** Every row of the tenant matches the rule: a non-null linked via to a parent the role reads entirely. */
function allOfTenant(ir: IR, t: IRTable, role: string, rule: Rule): boolean {
  if (rule === true) return true;
  if (!linkedVia(t, rule) || t.columns.find((c) => c.name === rule.column)?.nullable !== false) return false;
  const parent = ir.tables.find((x) => x.name === rule.parent);
  const parentRule = parent?.read.get(role);
  return parent !== undefined && parentRule !== undefined && allOfTenant(ir, parent, role, parentRule);
}

/**
 * A query term that keeps rows in the reader's tenant without the tenant gate: `col IN cte`
 * over a composite (tenant, col) foreign key to a tenant-gated CTE, or the membership table's
 * user column (unique) equal to the reader, whose one membership is where the tenant claim
 * came from.
 */
function keepsTenant(ir: IR, t: IRTable, terms: string[], ctes: Map<string, string>, unique: Unique, g: ReturnType<typeof gates>): string | undefined {
  for (const term of terms) {
    const inCte = /^(\S+) in (\S+)$/i.exec(term);
    if (inCte) {
      const column = (inCte[1] ?? "").replace(/^"(.*)"$/, "$1");
      const cte = [...ctes].find(([n]) => n.toLowerCase() === (inCte[2] ?? "").toLowerCase());
      if (!cte) continue;
      const c = parseQuery(cte[1]);
      const parent = ir.tables.find((x) => x.name === c.table);
      const gated = parent && c.terms.map(canonicalTerm).some((x) => g.tenant(parent).has(x));
      if (gated && linkedCte(t, column, cte[1], unique)) {
        return `${term} reads a tenant-gated CTE over a composite (tenant, ${column}) foreign key`;
      }
    }
    const m = ir.membership;
    if (t.name === m.table && unique(t.name, m.user) && [canonicalTerm(`${ident(m.user)} = auth.user_id()`), canonicalTerm(`auth.user_id() = ${ident(m.user)}`)].includes(term)) {
      return `${term}: a user has one membership (${m.user} is unique), the one the tenant claim comes from`;
    }
  }
  return undefined;
}

/**
 * `closedRoles`: every member with a tenant has one of the policy's roles (the membership
 * role column is NOT NULL and constrained to them). Otherwise a member with another role, or
 * none, gets a tenant claim that no role gate admits, and dropping a role gate is never
 * equivalent.
 */
export function syncMutants(ir: IR, streams: Stream[], unique: Unique = () => false, closedRoles = false): { mutants: SyncMutant[]; equivalent: Equivalent[] } {
  const g = gates(ir);
  const byName = new Map(ir.tables.map((t) => [t.name, t]));
  const mutants: Omit<SyncMutant, "name">[] = [];
  const equivalent: Equivalent[] = [];
  const terms = (sql: string) => parseQuery(sql).terms.map(canonicalTerm);

  for (const s of streams) {
    // Only the CTEs a query names: they are the ones its bucket depends on.
    const ctesOf = (refs: string[]) => Object.fromEntries([...s.ctes].filter(([n]) => refs.some((r) => r.toLowerCase() === n.toLowerCase())));
    const parsed = s.queries.map((q) => ({ ...q, q: parseQuery(q.sql), terms: terms(q.sql) }));
    for (const { label, q, terms: ts } of parsed) {
      const t = byName.get(q.table);
      if (!t) continue;
      const where = `${s.name}.${label} (${t.name})`;
      const projection = q.projection === "*" ? "*" : q.projection.map((p) => sqlText(tokenize(p))).join(", ");
      const role = ts.map((term) => g.roleOf.get(term)).find((r) => r !== undefined);
      for (const [i, term] of ts.entries()) {
        const rest = ts.filter((_, j) => j !== i);
        const kind = g.tenant(t).has(term) ? "the tenant gate" : g.roleOf.has(term) ? "the role gate" : "a row filter";
        const description = `${where} without ${kind}: ${term}`;
        const others = ir.claims.roles.filter((r) => r !== role);
        if (kind === "the role gate" && role && closedRoles && others.every((r) => covers(ir, t, r, role))) {
          equivalent.push({ description, reason: `every other role already receives these ${t.name} rows and columns` });
          continue;
        }
        const kept = kind === "the tenant gate" ? keepsTenant(ir, t, rest, s.ctes, unique, g) : undefined;
        if (kept) {
          equivalent.push({ description, reason: kept });
          continue;
        }
        mutants.push({ description, ctes: ctesOf(q.inRefs), queries: [build(projection, t.name, rest)] });
      }
      const hidden = role ? (t.hide.get(role) ?? []) : [];
      if (hidden.length && q.projection !== "*") {
        mutants.push({ description: `${where} projecting * (sends ${hidden.join(", ")} to ${role})`, ctes: ctesOf(q.inRefs), queries: [build("*", t.name, ts)] });
      }
    }
    for (const [cte, sql] of s.ctes) {
      const c = parseQuery(sql);
      const t = byName.get(c.table);
      if (!t) continue;
      const cteTerms = terms(sql);
      const users = parsed.filter((p) => p.q.inRefs.some((r) => r.toLowerCase() === cte.toLowerCase()));
      for (const [i, term] of cteTerms.entries()) {
        const isGate = g.tenant(t).has(term);
        const description = `${s.name}.with.${cte} (${t.name}) without ${isGate ? "the tenant gate" : "a row filter"}: ${term}`;
        if (isGate) {
          // `col IN cte` under a query's own tenant gate, through a (tenant, col) foreign key to
          // the CTE's table, already stays in the tenant.
          const linked = users.every((u) => {
            const ut = byName.get(u.q.table);
            const ref = u.terms.map((x) => new RegExp(`^(\\S+) in ${cte}$`, "i").exec(x)?.[1]).find(Boolean);
            const column = ref?.replace(/^"(.*)"$/, "$1");
            return ut && column && u.terms.some((x) => g.tenant(ut).has(x)) && linkedCte(ut, column, sql, unique);
          });
          if (users.length && linked) {
            equivalent.push({ description, reason: "every query using it keeps its own tenant gate, and a composite foreign key keeps the link in the tenant" });
            continue;
          }
        }
        const mutated = sqlText(tokenize(build(c.projection === "*" ? "*" : c.projection.join(", "), c.table, cteTerms.filter((_, j) => j !== i))));
        const refs = [...new Set(users.flatMap((u) => u.q.inRefs))];
        mutants.push({ description, ctes: { ...ctesOf(refs), [cte]: mutated }, queries: users.map((u) => u.sql) });
      }
    }
  }
  // One stream per distinct mutant.
  const seen = new Set<string>();
  const distinct: SyncMutant[] = [];
  for (const m of mutants) {
    const key = JSON.stringify([m.ctes, m.queries.map(canonicalTerm)]);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push({ ...m, name: `samesight_m${distinct.length + 1}` });
  }
  return { mutants: distinct, equivalent };
}

/** The first line of a mutant config, which a run refuses to treat as the original. */
export const MUTANT_HEADER = "# Written by samesight verify --mutate";

/** The original config plus one auto-subscribed stream per mutant. */
export function mutantConfig(original: unknown, mutants: SyncMutant[]): string {
  const doc = structuredClone(original) as { streams: Record<string, unknown> };
  for (const m of mutants) {
    const stream: Record<string, unknown> = { auto_subscribe: true };
    if (Object.keys(m.ctes).length) stream.with = m.ctes;
    stream.queries = m.queries;
    doc.streams[m.name] = stream;
  }
  return `${MUTANT_HEADER} and restored when it finishes. Do not edit.\n${stringify(doc, { lineWidth: 0 })}`;
}

function readPolicy(ir: IR, table: string): string | undefined {
  const name = `${table}: read`;
  return splitSqlStatements(emitMigration(ir)).find((s) => s.trimStart().startsWith(`create policy ${ident(name)} on public.${ident(table)}`));
}

function withRule(ir: IR, table: string, role: string, rule: Rule | undefined): IR {
  const copy = structuredClone(ir);
  const t = copy.tables.find((x) => x.name === table);
  if (t) {
    if (rule === undefined) t.read.delete(role);
    else t.read.set(role, rule);
  }
  return copy;
}

export function rlsMutants(ir: IR, unique: Unique = () => false): { mutants: RlsMutant[]; equivalent: Equivalent[] } {
  const mutants: Omit<RlsMutant, "name">[] = [];
  const equivalent: Equivalent[] = [];
  const replace = (t: IRTable, create: string) => [`drop policy ${ident(`${t.name}: read`)} on public.${ident(t.name)}`, create];
  for (const t of ir.tables) {
    const original = readPolicy(ir, t.name);
    if (!original) continue;
    const gate = `${ident(t.tenant)} = (select samesight.tenant_id())`;
    const ungated = original.replace(new RegExp(`${gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+and\\s+`), "");
    const rules = [...t.read.values()];
    if (rules.length && rules.every((r) => tenantBound(t, r, unique))) {
      equivalent.push({
        description: `RLS ${t.name}: read without the tenant gate`,
        reason: "every role's rule reads through a parent's RLS over a composite (tenant, column) foreign key",
      });
    } else if (ungated === original) {
      // Not equivalent, unbuildable: the emitter changed. With no statements it survives and fails the run.
      mutants.push({ description: `RLS ${t.name}: read without the tenant gate (could not be built: no "${gate} and" in the generated policy)`, statements: [] });
    }
    else mutants.push({ description: `RLS ${t.name}: read without the tenant gate`, statements: replace(t, ungated) });
    for (const role of ir.claims.roles) {
      const rule = t.read.get(role);
      if (rule !== undefined && rule !== true && allOfTenant(ir, t, role, rule)) {
        equivalent.push({
          description: `RLS ${t.name}: read lets ${role} read every row of its tenant`,
          reason: `${role} already reads every ${t.name} row of its tenant, through a parent it reads entirely`,
        });
      } else if (rule !== undefined && rule !== true) {
        const wide = readPolicy(withRule(ir, t.name, role, true), t.name);
        if (wide) mutants.push({ description: `RLS ${t.name}: read lets ${role} read every row of its tenant`, statements: replace(t, wide) });
      }
      if (rule !== undefined) {
        const narrow = readPolicy(withRule(ir, t.name, role, undefined), t.name);
        if (narrow) mutants.push({ description: `RLS ${t.name}: read without ${role}'s rule`, statements: replace(t, narrow) });
        else mutants.push({ description: `RLS ${t.name}: read without ${role}'s rule (no read policy left)`, statements: [`drop policy ${ident(`${t.name}: read`)} on public.${ident(t.name)}`] });
      }
    }
  }
  return { mutants: mutants.map((m, i) => ({ ...m, name: `r${i + 1}` })), equivalent };
}
