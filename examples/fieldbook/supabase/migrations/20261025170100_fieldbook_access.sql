-- Fieldbook access layer, written by hand. Phase 3 replaces this file with the
-- output of `samesight generate`, so its shape follows what the compiler will emit:
-- claim helpers and the access token hook in schema "samesight", one RLS policy per
-- table and operation (all TO authenticated, auth calls wrapped in (select ...)),
-- the append-only trigger, replica identity, an explicit-list publication, and
-- grants for the replication role.
--
-- It must mirror powersync/sync-config.yaml: every row a stream sends to a user must
-- be a row these policies let that user read.

create schema if not exists samesight;
grant usage on schema samesight to authenticated;

-- Claim helpers ----------------------------------------------------------------

create or replace function samesight.tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'tenant_id', '')::uuid
$$;

create or replace function samesight.app_role()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'app_role', '')
$$;

revoke execute on function samesight.tenant_id(), samesight.app_role() from public, anon;
grant execute on function samesight.tenant_id(), samesight.app_role() to authenticated;

-- Custom access token hook --------------------------------------------------------
-- Adds tenant_id and app_role as top-level claims, read from "Membership". Supabase
-- reserves the "role" claim for the Postgres role, so the app role is "app_role".
-- Enabled in supabase/config.toml locally, and under Authentication > Hooks hosted.

create or replace function samesight.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  member record;
begin
  select m."tenantId", m.role
    into member
    from public."Membership" m
   where m."userId" = (event ->> 'user_id')::uuid;

  if found then
    claims := jsonb_set(claims, '{tenant_id}', to_jsonb(member."tenantId"::text));
    claims := jsonb_set(claims, '{app_role}', to_jsonb(member.role));
  else
    -- No membership: no tenant, so every policy and stream returns nothing.
    claims := claims - 'tenant_id' - 'app_role';
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema samesight to supabase_auth_admin;
grant execute on function samesight.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function samesight.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant select on table public."Membership" to supabase_auth_admin;

drop policy if exists "Membership: auth hook reads" on public."Membership";
create policy "Membership: auth hook reads" on public."Membership"
  as permissive for select to supabase_auth_admin
  using (true);

-- Table privileges ---------------------------------------------------------------
-- Supabase grants everything on public tables to anon and authenticated by default.
-- anon gets nothing; authenticated gets only the operations a policy below allows,
-- and UPDATE only on columns a client may change (never id, tenantId, siteId or
-- timestamps).

revoke all on public."Tenant", public."Membership", public."Site", public."Inspection",
  public."Finding", public."Photo" from anon, authenticated;
grant select on public."Tenant", public."Membership" to authenticated;
grant select, insert, delete on public."Site", public."Inspection" to authenticated;
grant update (name, address) on public."Site" to authenticated;
grant update (title, status, "assigneeId", "internalNotes") on public."Inspection" to authenticated;
grant select, insert on public."Finding", public."Photo" to authenticated;

-- "seq" is assigned by its identity sequence; no client may move it.
revoke all on sequence public."Finding_seq_seq" from anon, authenticated;

-- Row level security -------------------------------------------------------------

alter table public."Tenant" enable row level security;
alter table public."Membership" enable row level security;
alter table public."Site" enable row level security;
alter table public."Inspection" enable row level security;
alter table public."Finding" enable row level security;
alter table public."Photo" enable row level security;

-- Tenant: every role reads its own tenant row.
drop policy if exists "Tenant: read" on public."Tenant";
create policy "Tenant: read" on public."Tenant"
  for select to authenticated
  using (
    id = (select samesight.tenant_id())
    and (select samesight.app_role()) in ('ADMIN', 'INSPECTOR', 'VIEWER')
  );

-- Membership: admins read the whole tenant; everyone else reads their own row.
drop policy if exists "Membership: read" on public."Membership";
create policy "Membership: read" on public."Membership"
  for select to authenticated
  using (
    "tenantId" = (select samesight.tenant_id())
    and (
      (select samesight.app_role()) = 'ADMIN'
      or ((select samesight.app_role()) in ('INSPECTOR', 'VIEWER') and "userId" = (select auth.uid()))
    )
  );

-- Site: every role reads; admins write.
drop policy if exists "Site: read" on public."Site";
create policy "Site: read" on public."Site"
  for select to authenticated
  using (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) in ('ADMIN', 'INSPECTOR', 'VIEWER')
  );

drop policy if exists "Site: insert" on public."Site";
create policy "Site: insert" on public."Site"
  for insert to authenticated
  with check (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) = 'ADMIN'
  );

drop policy if exists "Site: update" on public."Site";
create policy "Site: update" on public."Site"
  for update to authenticated
  using (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) = 'ADMIN'
  )
  with check (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) = 'ADMIN'
  );

drop policy if exists "Site: delete" on public."Site";
create policy "Site: delete" on public."Site"
  for delete to authenticated
  using (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) = 'ADMIN'
  );

-- Inspection: admins read all; inspectors read what is assigned to them; viewers read
-- published and archived reports. ("internalNotes" is hidden from viewers in the sync
-- projection only; RLS cannot hide columns, so it stays readable over REST.)
drop policy if exists "Inspection: read" on public."Inspection";
create policy "Inspection: read" on public."Inspection"
  for select to authenticated
  using (
    "tenantId" = (select samesight.tenant_id())
    and (
      (select samesight.app_role()) = 'ADMIN'
      or ((select samesight.app_role()) = 'INSPECTOR' and "assigneeId" = (select auth.uid()))
      or ((select samesight.app_role()) = 'VIEWER' and status in ('PUBLISHED', 'ARCHIVED'))
    )
  );

-- Admins create inspections, assigned to nobody or to an inspector in their own tenant
-- (the Membership subquery runs under the admin's Membership policy: own tenant only).
drop policy if exists "Inspection: insert" on public."Inspection";
create policy "Inspection: insert" on public."Inspection"
  for insert to authenticated
  with check (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) = 'ADMIN'
    and (
      "assigneeId" is null
      or "assigneeId" in (select m."userId" from public."Membership" m where m.role = 'INSPECTOR')
    )
  );

-- Admins update any inspection in the tenant; inspectors update their own, cannot
-- hand them to someone else, and cannot publish or archive (that makes the report
-- visible to viewers, an admin decision).
drop policy if exists "Inspection: update" on public."Inspection";
create policy "Inspection: update" on public."Inspection"
  for update to authenticated
  using (
    "tenantId" = (select samesight.tenant_id())
    and (
      (select samesight.app_role()) = 'ADMIN'
      or (
        (select samesight.app_role()) = 'INSPECTOR'
        and "assigneeId" = (select auth.uid())
        and status in ('DRAFT', 'IN_PROGRESS')
      )
    )
  )
  with check (
    "tenantId" = (select samesight.tenant_id())
    and (
      (
        (select samesight.app_role()) = 'ADMIN'
        and (
          "assigneeId" is null
          or "assigneeId" in (select m."userId" from public."Membership" m where m.role = 'INSPECTOR')
        )
      )
      or (
        (select samesight.app_role()) = 'INSPECTOR'
        and "assigneeId" = (select auth.uid())
        and status in ('DRAFT', 'IN_PROGRESS')
      )
    )
  );

drop policy if exists "Inspection: delete" on public."Inspection";
create policy "Inspection: delete" on public."Inspection"
  for delete to authenticated
  using (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) = 'ADMIN'
  );

-- Finding: visible when its inspection is visible (the subquery runs under the
-- caller's Inspection policy). Inspectors add findings to inspections assigned to
-- them. No update or delete policy: the table is append-only.
drop policy if exists "Finding: read" on public."Finding";
create policy "Finding: read" on public."Finding"
  for select to authenticated
  using (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) in ('ADMIN', 'INSPECTOR', 'VIEWER')
    and "inspectionId" in (select i.id from public."Inspection" i)
  );

drop policy if exists "Finding: insert" on public."Finding";
create policy "Finding: insert" on public."Finding"
  for insert to authenticated
  with check (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) = 'INSPECTOR'
    and "createdBy" = (select auth.uid())
    and "inspectionId" in (select i.id from public."Inspection" i)
  );

-- Photo: same shape as Finding.
drop policy if exists "Photo: read" on public."Photo";
create policy "Photo: read" on public."Photo"
  for select to authenticated
  using (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) in ('ADMIN', 'INSPECTOR', 'VIEWER')
    and "inspectionId" in (select i.id from public."Inspection" i)
  );

drop policy if exists "Photo: insert" on public."Photo";
create policy "Photo: insert" on public."Photo"
  for insert to authenticated
  with check (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) = 'INSPECTOR'
    and "createdBy" = (select auth.uid())
    and "inspectionId" in (select i.id from public."Inspection" i)
  );

-- Server-owned timestamps ---------------------------------------------------------

create or replace function samesight.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new."updatedAt" := now();
  return new;
end;
$$;

revoke execute on function samesight.touch_updated_at() from public, anon, authenticated;

drop trigger if exists "Inspection_touch_updated_at" on public."Inspection";
create trigger "Inspection_touch_updated_at"
  before update on public."Inspection"
  for each row execute function samesight.touch_updated_at();

-- Append-only enforcement -----------------------------------------------------------
-- RLS has no update or delete policy for these tables and authenticated has no such
-- grant. The triggers also stop UPDATE, DELETE and TRUNCATE by the service role, so
-- a server-side script cannot rewrite history by accident. (The table owner can still
-- disable triggers; this guards against mistakes, not a hostile superuser.) errcode
-- 23001 (restrict_violation) is a permanent rejection, so an offline client stops
-- retrying.

create or replace function samesight.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% on append-only table %.% is not allowed', tg_op, tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

revoke execute on function samesight.reject_mutation() from public, anon, authenticated;
revoke update, delete, truncate on public."Finding", public."Photo" from service_role;

drop trigger if exists "Finding_append_only" on public."Finding";
create trigger "Finding_append_only"
  before update or delete on public."Finding"
  for each row execute function samesight.reject_mutation();

drop trigger if exists "Finding_no_truncate" on public."Finding";
create trigger "Finding_no_truncate"
  before truncate on public."Finding"
  for each statement execute function samesight.reject_mutation();

drop trigger if exists "Photo_append_only" on public."Photo";
create trigger "Photo_append_only"
  before update or delete on public."Photo"
  for each row execute function samesight.reject_mutation();

drop trigger if exists "Photo_no_truncate" on public."Photo";
create trigger "Photo_no_truncate"
  before truncate on public."Photo"
  for each statement execute function samesight.reject_mutation();

-- Replication ------------------------------------------------------------------------
-- PowerSync reads the WAL through a role with BYPASSRLS, so sync-config.yaml is the
-- only filter between these tables and a device. A REPLICATION role can also decode
-- every table (auth.* included) regardless of the publication, so the PowerSync
-- service and this role's password are trusted with the whole database. The role is
-- created here without a login; its password is set out of band (scripts/stack-up.sh locally, by hand on a
-- hosted project) and never stored in the repo.

do $$
begin
  if not exists (select from pg_roles where rolname = 'powersync_role') then
    create role powersync_role with replication bypassrls nologin;
  end if;
end;
$$;

grant usage on schema public to powersync_role;
grant select on public."Tenant", public."Membership", public."Site", public."Inspection",
  public."Finding", public."Photo" to powersync_role;

alter table public."Tenant" replica identity full;
alter table public."Membership" replica identity full;
alter table public."Site" replica identity full;
alter table public."Inspection" replica identity full;
alter table public."Finding" replica identity full;
alter table public."Photo" replica identity full;

drop publication if exists powersync;
create publication powersync for table
  public."Tenant", public."Membership", public."Site", public."Inspection",
  public."Finding", public."Photo";
