import { and, claim, col, definePolicy, or, rowsOf, table, via } from "../policy.ts";
import type { ColumnInfo, SchemaInfo, TableInfo } from "../schema.ts";

// Fieldbook's schema migration, as introspection reports it. Kept by hand so the
// compiler's tests need no database.

const c = (name: string, type: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  type,
  nullable: false,
  default: null,
  identity: false,
  generated: false,
  ...extra,
});
const ts = "timestamp with time zone";
const t = (name: string, columns: ColumnInfo[], indexedColumns: string[] = [], uniqueColumns: string[] = []): TableInfo => ({
  name,
  columns,
  primaryKey: ["id"],
  indexedColumns,
  uniqueColumns: ["id", ...uniqueColumns],
});

export const fieldbookSchema: SchemaInfo = {
  tables: [
    t("Tenant", [c("id", "uuid"), c("name", "text"), c("createdAt", ts, { default: "now()" })]),
    t(
      "Membership",
      [
        c("id", "uuid", { default: "gen_random_uuid()" }),
        c("userId", "uuid"),
        c("tenantId", "uuid"),
        c("role", "text"),
        c("displayName", "text"),
        c("createdAt", ts, { default: "now()" }),
      ],
      ["userId", "tenantId"],
      ["userId"],
    ),
    t("Site", [
      c("id", "uuid"),
      c("tenantId", "uuid"),
      c("name", "text"),
      c("address", "text", { nullable: true }),
      c("createdAt", ts, { default: "now()" }),
    ], ["tenantId"]),
    t(
      "Inspection",
      [
        c("id", "uuid"),
        c("tenantId", "uuid"),
        c("siteId", "uuid"),
        c("assigneeId", "uuid", { nullable: true }),
        c("title", "text"),
        c("status", "text", { default: "'DRAFT'::text" }),
        c("internalNotes", "text", { nullable: true }),
        c("createdAt", ts, { default: "now()" }),
        c("updatedAt", ts, { default: "now()" }),
      ],
      ["tenantId", "siteId", "assigneeId"],
    ),
    t(
      "Finding",
      [
        c("id", "uuid"),
        c("tenantId", "uuid"),
        c("inspectionId", "uuid"),
        c("supersedesId", "uuid", { nullable: true }),
        c("seq", "bigint", { identity: true }),
        c("body", "text"),
        c("severity", "text"),
        c("createdBy", "uuid", { default: "auth.uid()" }),
        c("createdAt", ts, { default: "now()" }),
      ],
      ["tenantId", "inspectionId", "supersedesId"],
    ),
    t(
      "Photo",
      [
        c("id", "uuid"),
        c("tenantId", "uuid"),
        c("inspectionId", "uuid"),
        c("findingId", "uuid", { nullable: true }),
        c("storagePath", "text"),
        c("sha256", "text"),
        c("createdBy", "uuid", { default: "auth.uid()" }),
        c("createdAt", ts, { default: "now()" }),
      ],
      ["inspectionId"],
    ),
  ],
};

const assignable = col("assigneeId").in(rowsOf("Membership", "userId", col("role").eq("INSPECTOR")));
const ownOpen = and(col("assigneeId").eq(claim.user), col("status").in(["DRAFT", "IN_PROGRESS"]));

/** The policy Fieldbook's hand-written access layer implements. */
export const fieldbookPolicy = definePolicy({
  auth: "supabase",
  claims: {
    tenant: claim.uuid("tenant_id"),
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
      // Assigned to nobody, or to an inspector of the tenant (Membership rows the caller can read).
      check: or(col("assigneeId").isNull(), assignable),
      hide: { VIEWER: ["internalNotes"] },
      serverOwned: ["createdAt"],
      immutable: ["siteId"],
      touch: "updatedAt",
    }),
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
});
