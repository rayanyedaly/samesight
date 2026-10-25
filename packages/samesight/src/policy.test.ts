import { describe, expect, it } from "vitest";
import { and, claim, col, definePolicy, or, raw, rowsOf, table, via } from "./policy.ts";

// The shape `supabase gen types` produces, cut down.
type Database = {
  public: {
    Tables: {
      Site: { Row: { id: string; tenantId: string; name: string } };
      Inspection: { Row: { id: string; tenantId: string; siteId: string; assigneeId: string | null; status: string } };
    };
  };
};

const claims = { tenant: claim.uuid("tenant_id"), role: claim.oneOf("app_role", ["ADMIN", "INSPECTOR"]) };
const membership = { table: "Site" as const, user: "id" as const, tenant: "tenantId" as const, role: "name" as const };

describe("policy builders", () => {
  it("build plain condition trees", () => {
    expect(col("status").in(["A", "B"])).toEqual({ kind: "in", column: "status", values: ["A", "B"] });
    expect(col("assigneeId").eq(claim.user)).toEqual({ kind: "eq", column: "assigneeId", value: { kind: "user" } });
    expect(col("assigneeId").isNotNull()).toEqual({ kind: "isNull", column: "assigneeId", negate: true });
    expect(via("siteId", "Site")).toEqual({ kind: "via", column: "siteId", parent: "Site", parentKey: "id" });
    expect(col("assigneeId").in(rowsOf("Membership", "userId", col("role").eq("INSPECTOR")))).toEqual({
      kind: "inRows",
      column: "assigneeId",
      rows: { kind: "rows", table: "Membership", column: "userId", where: { kind: "eq", column: "role", value: "INSPECTOR" } },
    });
    expect(or(and(col("a").eq(1), col("b").isNull()), raw({ rls: "x", sync: "y" })).kind).toBe("or");
  });

  it("type-checks table and column names against the database type", () => {
    const policy = definePolicy<Database>({
      auth: "supabase",
      claims,
      membership,
      tables: {
        Site: table({ tenant: "tenantId", read: { "*": true }, write: { ADMIN: true } }),
        Inspection: table({
          tenant: "tenantId",
          read: { ADMIN: true, INSPECTOR: col("assigneeId").eq(claim.user) },
          immutable: ["siteId"],
        }),
      },
    });
    expect(policy.kind).toBe("samesight-policy");

    // raw() mixes with typed conditions without widening the table.
    definePolicy<Database>({
      auth: "supabase",
      claims,
      membership,
      tables: { Inspection: table({ tenant: "tenantId", read: { ADMIN: and(col("status").eq("A"), raw({ rls: "true", sync: "true" })) } }) },
    });

    definePolicy<Database>({
      auth: "supabase",
      claims,
      // @ts-expect-error: membership columns are checked too
      membership: { table: "Site", user: "userId", tenant: "tenantId", role: "name" },
      tables: {},
    });

    definePolicy<Database>({
      auth: "supabase",
      claims,
      membership,
      tables: {
        // @ts-expect-error: no such column
        Site: table({ tenant: "tenant_id" }),
        // @ts-expect-error: no such column in a condition
        Inspection: table({ tenant: "tenantId", read: { ADMIN: col("asigneeId").eq(claim.user) } }),
      },
    });

    definePolicy<Database>({
      auth: "supabase",
      claims,
      membership,
      tables: {
        // @ts-expect-error: no such table
        Sites: table({ tenant: "tenantId" }),
      },
    });
  });
});
