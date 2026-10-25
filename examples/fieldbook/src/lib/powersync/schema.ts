import { column, Schema, Table } from "@powersync/web";

// Client-side SQLite tables, one per synced Postgres table. Names and columns match
// what powersync/sync-config.yaml sends. Phase 3 generates this file.

const Tenant = new Table({
  name: column.text,
  createdAt: column.text,
});

const Membership = new Table({
  userId: column.text,
  tenantId: column.text,
  role: column.text,
  displayName: column.text,
  createdAt: column.text,
});

const Site = new Table({
  tenantId: column.text,
  name: column.text,
  address: column.text,
  createdAt: column.text,
});

const Inspection = new Table({
  tenantId: column.text,
  siteId: column.text,
  assigneeId: column.text,
  title: column.text,
  status: column.text,
  // Not synced to viewers; always null on their devices.
  internalNotes: column.text,
  createdAt: column.text,
  updatedAt: column.text,
});

const Finding = new Table({
  tenantId: column.text,
  inspectionId: column.text,
  supersedesId: column.text,
  // Assigned by the server; null until the row has synced.
  seq: column.integer,
  body: column.text,
  severity: column.text,
  createdBy: column.text,
  createdAt: column.text,
});

const Photo = new Table({
  tenantId: column.text,
  inspectionId: column.text,
  findingId: column.text,
  storagePath: column.text,
  sha256: column.text,
  createdBy: column.text,
  createdAt: column.text,
});

export const AppSchema = new Schema({ Tenant, Membership, Site, Inspection, Finding, Photo });

export type Database = (typeof AppSchema)["types"];
export type SiteRecord = Database["Site"];
export type InspectionRecord = Database["Inspection"];
export type FindingRecord = Database["Finding"];
export type MembershipRecord = Database["Membership"];
