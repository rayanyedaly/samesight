import { and, claim, col, definePolicy, or, rowsOf, table, via } from "samesight";
// Regenerate after a schema migration: supabase gen types typescript --local --schema public > supabase/types.ts
import type { Database } from "./supabase/types.ts";

// Fieldbook's whole access policy. `samesight generate` turns it into the access
// migration (RLS, grants, triggers, write path), the PowerSync sync config, and the
// client schema; `samesight check` (CI) fails when those drift from this file.

/** Admins assign inspections to nobody, or to an inspector of their own tenant. */
const assignable = or(col("assigneeId").isNull(), col("assigneeId").in(rowsOf("Membership", "userId", col("role").eq("INSPECTOR"))));

/** Inspectors work on their own inspections until an admin publishes them. */
const ownOpen = and(col("assigneeId").eq(claim.user), col("status").in(["DRAFT", "IN_PROGRESS"]));

export default definePolicy<Database>({
  auth: "supabase",
  claims: {
    tenant: claim.uuid("tenant_id"),
    // Supabase reserves "role" for the Postgres role, so the app role is "app_role".
    role: claim.oneOf("app_role", ["ADMIN", "INSPECTOR", "VIEWER"]),
  },
  membership: { table: "Membership", user: "userId", tenant: "tenantId", role: "role" },
  rejectedWrites: { read: ["ADMIN"] },
  tables: {
    Tenant: table({ tenant: "id", read: { "*": true } }),
    Membership: table({
      tenant: "tenantId",
      read: { ADMIN: true, INSPECTOR: col("userId").eq(claim.user), VIEWER: col("userId").eq(claim.user) },
    }),
    Site: table({ tenant: "tenantId", read: { "*": true }, write: { ADMIN: true }, serverOwned: ["createdAt"] }),
    Inspection: table({
      tenant: "tenantId",
      read: {
        ADMIN: true,
        INSPECTOR: col("assigneeId").eq(claim.user),
        VIEWER: col("status").in(["PUBLISHED", "ARCHIVED"]),
      },
      insert: { ADMIN: true },
      update: { ADMIN: true, INSPECTOR: ownOpen },
      delete: { ADMIN: true },
      check: assignable,
      // RLS cannot hide a column, so internalNotes stays readable to viewers over REST.
      hide: { VIEWER: ["internalNotes"] },
      serverOwned: ["createdAt"],
      immutable: ["siteId"],
      touch: "updatedAt",
    }),
    // Findings and photos are a permanent record: corrections are new rows.
    Finding: table({
      tenant: "tenantId",
      read: { "*": via("inspectionId", "Inspection") },
      insert: { INSPECTOR: via("inspectionId", "Inspection") },
      serverOwned: ["createdAt"],
      author: "createdBy",
      appendOnly: { supersedes: "supersedesId", order: "seq" },
    }),
    Photo: table({
      tenant: "tenantId",
      read: { "*": via("inspectionId", "Inspection") },
      insert: { INSPECTOR: via("inspectionId", "Inspection") },
      serverOwned: ["createdAt"],
      author: "createdBy",
      appendOnly: {},
    }),
  },
  output: {
    clientSchema: "src/lib/powersync/schema.ts",
    policyTypes: "src/lib/policy-types.ts",
  },
});
