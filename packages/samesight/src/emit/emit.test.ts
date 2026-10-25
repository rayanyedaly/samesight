import { describe, expect, it } from "vitest";
import { fieldbookPolicy, fieldbookSchema } from "../fixtures/fieldbook.ts";
import { buildIR } from "../ir.ts";
import { claim, col, definePolicy, raw, table, via } from "../policy.ts";
import type { ColumnInfo, TableInfo } from "../schema.ts";
import { emitClientSchema, emitManifest, emitPolicyTypes, emitServiceConfig } from "./client.ts";
import { ident, rls, sync } from "./expr.ts";
import { emitMigration } from "./migration.ts";
import { emitSyncConfig } from "./sync.ts";

// Golden files: review a diff in __golden__ like a code change. Update with `vitest -u`.
const ir = buildIR(fieldbookPolicy, fieldbookSchema);

describe("golden output for Fieldbook", () => {
  it("migration", async () => {
    await expect(emitMigration(ir)).toMatchFileSnapshot("./__golden__/fieldbook/migration.sql");
  });
  it("sync config", async () => {
    await expect(emitSyncConfig(ir)).toMatchFileSnapshot("./__golden__/fieldbook/sync-config.yaml");
  });
  it("client schema", async () => {
    await expect(emitClientSchema(ir)).toMatchFileSnapshot("./__golden__/fieldbook/app-schema.ts.txt");
  });
  it("policy types", async () => {
    await expect(emitPolicyTypes(ir)).toMatchFileSnapshot("./__golden__/fieldbook/policy-types.ts.txt");
  });
  it("service config and manifest", async () => {
    await expect(emitServiceConfig({ syncConfigPath: "sync-config.yaml", jwksUri: "http://kong:8000/auth/v1/.well-known/jwks.json" })).toMatchFileSnapshot(
      "./__golden__/fieldbook/service.yaml",
    );
    await expect(emitManifest(ir, { "a.sql": "x" })).toMatchFileSnapshot("./__golden__/fieldbook/manifest.json");
  });
});

describe("expressions", () => {
  it("quotes only what needs quoting", () => {
    expect(ident("status")).toBe("status");
    expect(ident("tenantId")).toBe('"tenantId"');
    expect(ident("user")).toBe('"user"');
    expect(ident('a"b')).toBe('"a""b"');
  });

  it("renders lists as IN for RLS and OR chains for streams", () => {
    const node = col("status").in(["A", "B"]);
    expect(rls(node)).toBe("status in ('A', 'B')");
    expect(sync(node, () => "x")).toBe("(status = 'A' OR status = 'B')");
  });

  it("parenthesizes mixed and/or and keeps raw sides apart", () => {
    const node = { kind: "and" as const, items: [col("a").eq(1), { kind: "or" as const, items: [col("b").isNull(), raw({ rls: "r", sync: "s" })] }] };
    expect(rls(node)).toBe("a = 1 and (b is null or (r))");
    expect(sync(node, () => "x")).toBe("a = 1 AND (b IS NULL OR (s))");
  });
});

describe("sync config", () => {
  it("leaves a role without read rules out, and block-quotes queries YAML would misread", () => {
    const policy = definePolicy({
      ...fieldbookPolicy.spec,
      tables: {
        Membership: table({ tenant: "tenantId", read: { ADMIN: true } }),
        Site: table({ tenant: "tenantId", read: { ADMIN: col("name").eq("a: b") } }),
      },
    });
    const yaml = emitSyncConfig(buildIR(policy, fieldbookSchema));
    expect(yaml).not.toContain("inspector:");
    expect(yaml).toContain("      - |\n        SELECT *\n        FROM \"Site\"\n        WHERE \"tenantId\" = auth.parameter('tenant_id')\n          AND name = 'a: b'");
  });

  it("uses the policy's claim names", () => {
    const policy = definePolicy({
      ...fieldbookPolicy.spec,
      claims: { tenant: claim.uuid("org_id"), role: claim.oneOf("org_role", ["ADMIN", "INSPECTOR", "VIEWER"]) },
      tables: { Membership: fieldbookPolicy.spec.tables.Membership, Site: table({ tenant: "tenantId", read: { ADMIN: true } }) },
    });
    const out = buildIR(policy, fieldbookSchema);
    expect(emitSyncConfig(out)).toContain("auth.parameter('org_id') AND auth.parameter('org_role') = 'ADMIN'");
    expect(emitMigration(out)).toContain("select nullif(auth.jwt() ->> 'org_id', '')::uuid");
  });
});

describe("via CTEs", () => {
  // Two parents whose names snake-case alike must never share a CTE.
  const uuid = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
    name,
    type: "uuid",
    nullable: false,
    default: null,
    identity: false,
    generated: false,
    ...extra,
  });
  const tableInfo = (name: string, columns: ColumnInfo[]): TableInfo => ({
    name,
    columns,
    primaryKey: ["id"],
    indexedColumns: columns.map((c) => c.name).sort(),
    uniqueColumns: ["id", ...(name === "Member" ? ["userId"] : [])],
    foreignKeys: [],
  });
  const schema = {
    tables: [
      tableInfo("Member", [uuid("id"), uuid("userId"), uuid("tenantId"), { ...uuid("role"), type: "text" }]),
      tableInfo("SiteVisit", [uuid("id"), uuid("tenantId"), uuid("ownerId")]),
      tableInfo("Site_Visit", [uuid("id"), uuid("tenantId")]),
      tableInfo("B", [uuid("id"), uuid("tenantId"), uuid("visitId")]),
      tableInfo("C", [uuid("id"), uuid("tenantId"), uuid("visitId")]),
    ],
  };

  it("keys CTEs by parent, so colliding names get distinct CTEs", () => {
    const policy = definePolicy({
      auth: "supabase",
      claims: { tenant: claim.uuid("tenant_id"), role: claim.oneOf("app_role", ["MEMBER"]) },
      membership: { table: "Member", user: "userId", tenant: "tenantId", role: "role" },
      tables: {
        Member: table({ tenant: "tenantId", read: { MEMBER: col("userId").eq(claim.user) } }),
        SiteVisit: table({ tenant: "tenantId", read: { MEMBER: col("ownerId").eq(claim.user) } }),
        Site_Visit: table({ tenant: "tenantId", read: { MEMBER: true } }),
        B: table({ tenant: "tenantId", read: { MEMBER: via("visitId", "Site_Visit") } }),
        C: table({ tenant: "tenantId", read: { MEMBER: via("visitId", "SiteVisit") } }),
      },
    });
    const yaml = emitSyncConfig(buildIR(policy, schema));
    expect(yaml).toContain('site_visit_visible: |\n        SELECT id FROM "Site_Visit"');
    expect(yaml).toContain('site_visit_visible_2: |\n        SELECT id FROM "SiteVisit"\n        WHERE "tenantId" = auth.parameter(\'tenant_id\') AND "ownerId" = auth.user_id()');
    expect(yaml).toContain('FROM "C"\n        WHERE "tenantId" = auth.parameter(\'tenant_id\')\n          AND "visitId" IN site_visit_visible_2');
  });

  it("drops a CTE only for a NOT NULL column tied to the parent by a composite foreign key", () => {
    const linked = (nullable: boolean) => {
      const c = tableInfo("C", [uuid("id"), uuid("tenantId"), uuid("visitId", { nullable })]);
      c.foreignKeys = [{ columns: ["visitId", "tenantId"], table: "Site_Visit", references: ["id", "tenantId"] }];
      const policy = definePolicy({
        auth: "supabase",
        claims: { tenant: claim.uuid("tenant_id"), role: claim.oneOf("app_role", ["MEMBER"]) },
        membership: { table: "Member", user: "userId", tenant: "tenantId", role: "role" },
        tables: {
          Member: table({ tenant: "tenantId", read: { MEMBER: col("userId").eq(claim.user) } }),
          Site_Visit: table({ tenant: "tenantId", read: { MEMBER: true } }),
          C: table({ tenant: "tenantId", read: { MEMBER: via("visitId", "Site_Visit") } }),
        },
      });
      return emitSyncConfig(buildIR(policy, { tables: [...schema.tables.filter((t) => t.name !== "C"), c] }));
    };
    expect(linked(false)).toContain(`SELECT * FROM "C" WHERE "tenantId" = auth.parameter('tenant_id') AND auth.parameter('app_role') = 'MEMBER'`);
    // A NULL column skips the foreign key check, and RLS hides the row: keep the CTE.
    expect(linked(true)).toContain('"visitId" IN site_visit_visible');
  });

  it("refuses via cycles across roles, which Postgres would reject as recursive policies", () => {
    const policy = definePolicy({
      auth: "supabase",
      claims: { tenant: claim.uuid("tenant_id"), role: claim.oneOf("app_role", ["MEMBER", "OWNER"]) },
      membership: { table: "Member", user: "userId", tenant: "tenantId", role: "role" },
      tables: {
        Member: table({ tenant: "tenantId", read: { "*": true } }),
        B: table({ tenant: "tenantId", read: { MEMBER: via("visitId", "C"), OWNER: true } }),
        C: table({ tenant: "tenantId", read: { OWNER: via("visitId", "B"), MEMBER: true } }),
      },
    });
    expect(() => buildIR(policy, schema)).toThrow("tables: B -> C -> B reach each other through via or rowsOf");
  });

  it("refuses raw rules with comments, and a membership table outside the policy", () => {
    const policy = definePolicy({
      auth: "supabase",
      claims: { tenant: claim.uuid("tenant_id"), role: claim.oneOf("app_role", ["MEMBER"]) },
      membership: { table: "Member", user: "userId", tenant: "tenantId", role: "role" },
      tables: { B: table({ tenant: "tenantId", read: { MEMBER: raw({ rls: "true -- x", sync: "true" }) } }) },
    });
    expect(() => buildIR(policy, schema)).toThrow(/raw rules cannot contain comments[\s\S]*"Member" must be a table in this policy/);
  });
});
