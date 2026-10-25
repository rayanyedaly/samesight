-- Fieldbook application tables. Samesight never creates or migrates these; it only
-- adds access rules to them (see the *_fieldbook_access migration).
--
-- Every key is a client-generated UUID so rows can be created offline. Child tables
-- reference parents through (tenantId, id) composite keys, so a row can never point
-- at a parent in another tenant, whatever RLS allows.

create table public."Tenant" (
  id uuid primary key,
  name text not null,
  "createdAt" timestamptz not null default now()
);

-- v1: one tenant per user (unique "userId").
create table public."Membership" (
  id uuid primary key default gen_random_uuid(),
  "userId" uuid not null unique references auth.users (id) on delete cascade,
  "tenantId" uuid not null references public."Tenant" (id) on delete cascade,
  role text not null check (role in ('ADMIN', 'INSPECTOR', 'VIEWER')),
  "displayName" text not null,
  "createdAt" timestamptz not null default now()
);
create index "Membership_tenantId_idx" on public."Membership" ("tenantId");

create table public."Site" (
  id uuid primary key,
  "tenantId" uuid not null references public."Tenant" (id) on delete cascade,
  name text not null,
  address text,
  "createdAt" timestamptz not null default now(),
  unique ("tenantId", id)
);

create table public."Inspection" (
  id uuid primary key,
  "tenantId" uuid not null references public."Tenant" (id) on delete cascade,
  "siteId" uuid not null,
  "assigneeId" uuid references auth.users (id) on delete set null,
  title text not null,
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'IN_PROGRESS', 'PUBLISHED', 'ARCHIVED')),
  "internalNotes" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("tenantId", id),
  foreign key ("tenantId", "siteId") references public."Site" ("tenantId", id) on delete cascade
);
create index "Inspection_siteId_idx" on public."Inspection" ("siteId");
create index "Inspection_assigneeId_idx" on public."Inspection" ("assigneeId");

-- Append-only: a correction is a new row whose "supersedesId" points at the row it
-- replaces, within the same inspection. "seq" is assigned by the server.
--
-- Findings and photos are a permanent record, so no foreign key cascades into them:
-- an inspection, site, tenant or user with findings cannot be deleted (archive it
-- instead), and the attempt fails with a foreign key error, not a trigger error.
create table public."Finding" (
  id uuid primary key,
  "tenantId" uuid not null references public."Tenant" (id),
  "inspectionId" uuid not null,
  "supersedesId" uuid,
  seq bigint generated always as identity,
  body text not null,
  severity text not null check (severity in ('LOW', 'MEDIUM', 'HIGH')),
  "createdBy" uuid not null default auth.uid() references auth.users (id),
  "createdAt" timestamptz not null default now(),
  unique ("tenantId", id),
  unique ("inspectionId", id),
  check ("supersedesId" <> id),
  foreign key ("tenantId", "inspectionId") references public."Inspection" ("tenantId", id),
  foreign key ("inspectionId", "supersedesId") references public."Finding" ("inspectionId", id)
);
create index "Finding_inspectionId_idx" on public."Finding" ("inspectionId");
create index "Finding_supersedesId_idx" on public."Finding" ("supersedesId");

-- Photo files live in Supabase Storage; this row records where and what (sha256).
-- No upload path exists yet. Before one ships, "storagePath" must be pinned to a
-- tenant/inspection prefix and matched by Storage policies.
create table public."Photo" (
  id uuid primary key,
  "tenantId" uuid not null references public."Tenant" (id),
  "inspectionId" uuid not null,
  "findingId" uuid,
  "storagePath" text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  "createdBy" uuid not null default auth.uid() references auth.users (id),
  "createdAt" timestamptz not null default now(),
  foreign key ("tenantId", "inspectionId") references public."Inspection" ("tenantId", id),
  foreign key ("inspectionId", "findingId") references public."Finding" ("inspectionId", id)
);
create index "Photo_inspectionId_idx" on public."Photo" ("inspectionId");
