import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ir, syncConfig } from "../fixtures/fieldbook.ts";
import { splitSqlStatements } from "../sql.ts";
import { parseStreams } from "samesight/compiler";
import { toPostgres } from "./explain.ts";
import { mutantConfig, rlsMutants, syncMutants } from "./mutants.ts";

/** Fieldbook's single-column unique keys: every id, and Membership.userId. */
const unique = (t: string, c: string) => c === "id" || (t === "Membership" && c === "userId");
const streams = parseStreams(syncConfig);

describe("syncMutants on Fieldbook", () => {
  // Membership.role is NOT NULL and checked against the three roles.
  const { mutants, equivalent } = syncMutants(ir, streams, unique, true);

  it("widens every query and CTE, once per distinct stream", () => {
    expect(mutants).toHaveLength(33);
    expect(new Set(mutants.map((m) => JSON.stringify([m.ctes, m.queries]))).size).toBe(mutants.length);
    const descriptions = mutants.map((m) => m.description);
    expect(descriptions).toContain(`admin.queries[3] (Inspection) without the tenant gate: "tenantId" = auth.parameter('tenant_id')`);
    expect(descriptions).toContain(`inspector.queries[3] (Inspection) without a row filter: "assigneeId" = auth.user_id()`);
    expect(descriptions).toContain("viewer.queries[3] (Inspection) projecting * (sends internalNotes to VIEWER)");
    expect(descriptions).toContain(`viewer.with.inspection_visible (Inspection) without a row filter: (status = 'PUBLISHED' or status = 'ARCHIVED')`);
    // A rule through a parent each role reads differently is not the same for every role.
    expect(descriptions).toContain(`viewer.queries[4] (Finding) without the role gate: auth.parameter('app_role') = 'VIEWER'`);
  });

  it("skips only mutants that provably change nothing, with the reason", () => {
    const reasons = Object.fromEntries(equivalent.map((e) => [e.description, e.reason]));
    expect(equivalent).toHaveLength(16);
    expect(reasons[`admin.queries[2] (Site) without the role gate: auth.parameter('app_role') = 'ADMIN'`]).toMatch(/every other role already receives/);
    expect(reasons[`viewer.queries[4] (Finding) without the tenant gate: "tenantId" = auth.parameter('tenant_id')`]).toMatch(/tenant-gated CTE over a composite/);
    expect(reasons[`inspector.queries[1] (Membership) without the tenant gate: "tenantId" = auth.parameter('tenant_id')`]).toMatch(/one membership/);
  });

  it("does not call a mutant equivalent once the reason is gone", () => {
    const unlinked = structuredClone(ir);
    for (const t of unlinked.tables) t.tenantLinked = [];
    const without = syncMutants(unlinked, streams, () => false);
    expect(without.equivalent.map((e) => e.description).filter((d) => d.includes("tenant gate"))).toEqual([]);
  });

  it("needs a parent key unique across tenants to call a tenant gate kept", () => {
    const perTenant = syncMutants(ir, streams, (t, c) => t === "Membership" && c === "userId", true);
    expect(perTenant.equivalent.map((e) => e.description).filter((d) => d.includes("tenant gate") && !d.includes("Membership"))).toEqual([]);
  });

  it("keeps every role-gate mutant when members may hold a role outside the policy", () => {
    const open = syncMutants(ir, streams, unique, false);
    expect(open.equivalent.map((e) => e.description).filter((d) => d.includes("role gate"))).toEqual([]);
  });

  it("does not call a role gate covered when another role hides more columns", () => {
    const hiding = structuredClone(ir);
    const site = hiding.tables.find((t) => t.name === "Site");
    site?.hide.set("VIEWER", ["address"]);
    const r = syncMutants(hiding, streams, unique, true);
    expect(r.equivalent.map((e) => e.description)).not.toContain(`admin.queries[2] (Site) without the role gate: auth.parameter('app_role') = 'ADMIN'`);
  });

  it("writes one auto-subscribed stream per mutant next to the originals", () => {
    const doc = parse(mutantConfig(parse(syncConfig), mutants)) as { streams: Record<string, { auto_subscribe: boolean; queries: string[] }> };
    expect(Object.keys(doc.streams)).toEqual(["admin", "inspector", "viewer", ...mutants.map((m) => m.name)]);
    expect(doc.streams[mutants[0]?.name ?? ""]).toEqual({ auto_subscribe: true, queries: mutants[0]?.queries });
    expect(mutants.every((m) => /^samesight_m\d+$/.test(m.name))).toBe(true);
    parseStreams(mutantConfig(parse(syncConfig), mutants));
  });
});

describe("rlsMutants on Fieldbook", () => {
  const { mutants, equivalent } = rlsMutants(ir, unique);

  it("re-creates one read policy per mutant", () => {
    expect(mutants).toHaveLength(30);
    for (const m of mutants) {
      expect(m.statements[0]).toMatch(/^drop policy ".+: read" on public\."\w+"$/);
      if (m.statements[1]) expect(splitSqlStatements(m.statements[1])).toHaveLength(1);
    }
    const tenantless = mutants.find((m) => m.description === "RLS Site: read without the tenant gate");
    expect(tenantless?.statements[1]).not.toContain("tenant_id()");
  });

  it("names the equivalent ones", () => {
    expect(equivalent.map((e) => e.description).sort()).toEqual([
      "RLS Finding: read lets ADMIN read every row of its tenant",
      "RLS Finding: read without the tenant gate",
      "RLS Photo: read lets ADMIN read every row of its tenant",
      "RLS Photo: read without the tenant gate",
    ]);
  });

  it("runs the tenant-gate mutant once the parent link is gone or not unique", () => {
    const unlinked = structuredClone(ir);
    for (const t of unlinked.tables) t.tenantLinked = [];
    for (const r of [rlsMutants(unlinked, unique), rlsMutants(ir, () => false)]) {
      expect(r.mutants.map((m) => m.description)).toEqual(expect.arrayContaining(["RLS Finding: read without the tenant gate", "RLS Photo: read without the tenant gate"]));
    }
  });

  it("runs the widen-to-everything mutant when the parent link may be null", () => {
    const nullable = structuredClone(ir);
    const col = nullable.tables.find((t) => t.name === "Finding")?.columns.find((c) => c.name === "inspectionId");
    if (col) col.nullable = true;
    expect(rlsMutants(nullable, unique).mutants.map((m) => m.description)).toContain("RLS Finding: read lets ADMIN read every row of its tenant");
  });
});

describe("toPostgres", () => {
  const claims = { sub: "u-1", tenant_id: "t'1", app_role: "VIEWER" };

  it("puts the token's values in place of auth calls and CTEs in place of their names", () => {
    const ctes = { visible: `SELECT id FROM "Inspection" WHERE "tenantId" = auth.parameter('tenant_id')` };
    expect(toPostgres(`SELECT * FROM "Finding" WHERE "inspectionId" IN visible AND "createdBy" = auth.user_id()`, ctes, claims)).toBe(
      `select * from public."Finding" where "inspectionId" in (select id from public."Inspection" where "tenantId" = 't''1') and "createdBy" = 'u-1'`,
    );
    expect(toPostgres(`SELECT * FROM "Site" WHERE auth.parameter('missing') = 'x'`, {}, claims)).toBe(`select * from public."Site" where null = 'x'`);
  });

  it("refuses what it cannot evaluate", () => {
    expect(() => toPostgres(`SELECT * FROM "Site" WHERE id = subscription.parameter('id')`, {}, claims)).toThrow(/subscription.parameter/);
  });
});
