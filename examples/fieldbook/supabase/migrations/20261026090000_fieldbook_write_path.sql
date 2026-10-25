-- Fieldbook write path: one RPC per offline transaction, plus a server-side record of
-- writes that were refused for good.
--
-- Hand-written for Phase 2; the Samesight compiler generates the same functions from
-- the policy file in Phase 3. The connector in @samesight/supabase calls
-- rpc("apply_batch") once per PowerSync transaction, so a transaction commits or fails
-- as a unit, and rpc("record_rejection") with a best-effort copy of anything refused.

-- apply_batch ---------------------------------------------------------------------------
--
-- SECURITY INVOKER: every statement runs as the caller (authenticated), so RLS and the
-- column grants check each row exactly as they would for a direct REST call. PostgREST
-- runs the whole call in one transaction.
--
-- Each op is {op, table, id, data} from PowerSync's upload queue. For each, in order:
--   - a table outside the allowlist below is refused;
--   - PUT reads only the listed insert columns from data: a PUT carries the whole local
--     row, so server-owned columns (seq, createdBy, createdAt, updatedAt) are dropped;
--   - PATCH carries only the columns that changed, so a key outside the update list is
--     an attempted change the server refuses, rather than drops and reports as success;
--   - tenantId comes from the token, never from the payload;
--   - PUT on an append-only table is INSERT ... ON CONFLICT (id) DO NOTHING, so a
--     replay is a no-op; PUT elsewhere upserts the updatable columns (last write wins);
--     a PUT that changes nothing must find its row, or a different row owns that id;
--   - PATCH updates the allowed columns present; zero rows (missing, or hidden by RLS)
--     raises;
--   - DELETE is refused on append-only tables. A row that is gone or hidden is a no-op
--     (a replayed delete); a visible row RLS will not delete raises.
--
-- A lost response followed by a change of access (say, a reassignment) can make the
-- retry of an applied batch fail and be recorded as refused. The data is on the server
-- either way; the record is a false alarm, not a loss.
-- Identifiers come only from the allowlist and are quoted with format('%I'); payload
-- values reach SQL only as a bound jsonb parameter.
--
-- Refusals raised here use SQLSTATE P0001, which the connector treats as permanent. A
-- token without a tenant raises 28000 instead: a refreshed token may carry one (a new
-- membership), so the connector refreshes and retries rather than discarding writes. A
-- request this server does not understand (an unknown table or op, say from a client
-- newer than this migration) raises SS001, which the connector holds in the queue.

create or replace function public.apply_batch(ops jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- insert: columns a client may set on create. update: columns a client may change.
  spec constant jsonb := '{
    "Site":       {"appendOnly": false, "insert": ["name", "address"],
                   "update": ["name", "address"]},
    "Inspection": {"appendOnly": false, "insert": ["siteId", "assigneeId", "title", "status", "internalNotes"],
                   "update": ["assigneeId", "title", "status", "internalNotes"]},
    "Finding":    {"appendOnly": true,  "insert": ["inspectionId", "supersedesId", "body", "severity"],
                   "update": []},
    "Photo":      {"appendOnly": true,  "insert": ["inspectionId", "findingId", "storagePath", "sha256"],
                   "update": []}
  }';
  tenant uuid := (select samesight.tenant_id());
  op jsonb;
  kind text;
  tbl text;
  t jsonb;
  row_id uuid;
  data jsonb;
  cols text[];
  upd text[];
  record_json jsonb;
  col_list text;
  conflict text;
  affected bigint;
  found_row boolean;
begin
  if jsonb_typeof(ops) is distinct from 'array' then
    raise exception 'apply_batch: ops must be a JSON array' using errcode = 'SS001';
  end if;
  if tenant is null then
    raise exception 'apply_batch: the token carries no tenant' using errcode = '28000';
  end if;

  for op in select value from jsonb_array_elements(ops) loop
    kind := op ->> 'op';
    tbl := op ->> 'table';
    t := spec -> tbl;
    if t is null then
      raise exception 'apply_batch: table % is not writable', coalesce(tbl, '(none)') using errcode = 'SS001';
    end if;
    -- Before the shape checks, so an op this server does not know is held, not refused.
    if kind is null or kind not in ('PUT', 'PATCH', 'DELETE') then
      raise exception 'apply_batch: unknown op %', coalesce(kind, '(none)') using errcode = 'SS001';
    end if;
    if op ->> 'id' is null then
      raise exception 'apply_batch: % op on % has no id', kind, tbl;
    end if;
    row_id := (op ->> 'id')::uuid;
    data := coalesce(op -> 'data', '{}'::jsonb);
    if jsonb_typeof(data) is distinct from 'object' then
      raise exception 'apply_batch: data for % % must be an object', tbl, row_id;
    end if;

    if kind = 'PUT' then
      cols := array(
        select c from jsonb_array_elements_text(t -> 'insert') c where data ? c
      ) || array['id', 'tenantId'];
      upd := array(
        select c from jsonb_array_elements_text(t -> 'update') c where data ? c
      );
      -- A row stored under another tenant: a write queued before this user moved to the
      -- current tenant (the token says where they are now, the row where they were).
      -- Refused rather than re-homed into the new tenant.
      if data ->> 'tenantId' is not null and not samesight.is_tenant(data ->> 'tenantId', tenant) then
        raise exception 'apply_batch: % % belongs to another tenant', tbl, row_id;
      end if;
      -- jsonb_populate_record parses every key it is given, so drop the others first: a
      -- malformed server-owned value must not fail the write it is ignored by.
      record_json := (
        select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(data) where key = any(cols)
      ) || jsonb_build_object('id', row_id, 'tenantId', tenant);
      col_list := (select string_agg(format('%I', c), ', ') from unnest(cols) c);
      if (t ->> 'appendOnly')::boolean or cardinality(upd) = 0 then
        conflict := 'do nothing';
      else
        conflict := 'do update set ' ||
          (select string_agg(format('%I = excluded.%I', c, c), ', ') from unnest(upd) c);
      end if;
      execute format(
        'insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) on conflict (id) %s',
        tbl, col_list, col_list, tbl, conflict
      ) using record_json;
      get diagnostics affected = row_count;
      if affected = 0 then
        -- A replay finds its own row. Finding none (or one this caller cannot read)
        -- means the id belongs to someone else's row.
        execute format('select exists (select 1 from public.%I where id = $1)', tbl)
          into found_row using row_id;
        if not found_row then
          raise exception 'apply_batch: % % conflicts with a row you cannot write', tbl, row_id;
        end if;
      end if;

    elsif kind = 'PATCH' then
      if (t ->> 'appendOnly')::boolean then
        raise exception 'apply_batch: % is append-only; add a new row instead', tbl;
      end if;
      if exists (select 1 from jsonb_object_keys(data) k where not (t -> 'update') ? k) then
        raise exception 'apply_batch: % % changes a column clients may not change', tbl, row_id;
      end if;
      upd := array(select k from jsonb_object_keys(data) k);
      if cardinality(upd) = 0 then
        execute format('select exists (select 1 from public.%I where id = $1)', tbl)
          into found_row using row_id;
        if not found_row then
          raise exception 'apply_batch: % % not found or not writable', tbl, row_id;
        end if;
        continue;
      end if;
      col_list := (select string_agg(format('%I', c), ', ') from unnest(upd) c);
      execute format(
        'update public.%I as t set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where t.id = $2',
        tbl, col_list, col_list, tbl
      ) using data, row_id;
      get diagnostics affected = row_count;
      if affected = 0 then
        raise exception 'apply_batch: % % not found or not writable', tbl, row_id;
      end if;

    elsif kind = 'DELETE' then
      if (t ->> 'appendOnly')::boolean then
        raise exception 'apply_batch: % is append-only and cannot be deleted', tbl;
      end if;
      execute format('delete from public.%I where id = $1', tbl) using row_id;
      get diagnostics affected = row_count;
      if affected = 0 then
        -- Gone or hidden: a replay. Still visible: RLS refused the delete.
        execute format('select exists (select 1 from public.%I where id = $1)', tbl)
          into found_row using row_id;
        if found_row then
          raise exception 'apply_batch: % % not deletable', tbl, row_id;
        end if;
      end if;

    else
      raise exception 'apply_batch: unknown op %', coalesce(kind, '(none)') using errcode = 'SS001';
    end if;
  end loop;
end;
$$;

revoke execute on function public.apply_batch(jsonb) from public, anon;
grant execute on function public.apply_batch(jsonb) to authenticated;

-- Refused writes, server copy ----------------------------------------------------------
--
-- The device keeps its own copy in a local-only table and shows it; this one lets an
-- admin see what failed across the team. Clients can only add to it: tenant and actor
-- come from the token, and nothing can update or delete it. The reason fields are what
-- the client reported, not server evidence.
-- Not in the powersync publication, so it never syncs back down.

create table if not exists samesight."RejectedWrite" (
  id uuid primary key default gen_random_uuid(),
  "tenantId" uuid not null references public."Tenant" (id) on delete cascade,
  "actorUserId" uuid,
  "resourceType" text not null,
  "resourceId" text not null,
  "opType" text not null,
  payload jsonb not null,
  "reasonCode" text not null,
  "reasonMessage" text not null,
  "httpStatus" integer not null,
  "createdAt" timestamptz not null default now()
);
create index if not exists "RejectedWrite_tenantId_idx" on samesight."RejectedWrite" ("tenantId", "createdAt");

alter table samesight."RejectedWrite" enable row level security;
revoke all on samesight."RejectedWrite" from public, anon, authenticated;
grant select, insert on samesight."RejectedWrite" to authenticated;

drop policy if exists "RejectedWrite: admins read" on samesight."RejectedWrite";
create policy "RejectedWrite: admins read" on samesight."RejectedWrite"
  for select to authenticated
  using (
    "tenantId" = (select samesight.tenant_id())
    and (select samesight.app_role()) = 'ADMIN'
  );

drop policy if exists "RejectedWrite: record own" on samesight."RejectedWrite";
create policy "RejectedWrite: record own" on samesight."RejectedWrite"
  for insert to authenticated
  with check (
    "tenantId" = (select samesight.tenant_id())
    and "actorUserId" = (select auth.uid())
  );

-- rejections: [{table, id, op, data, code, message, status}], at most 100 per call. A
-- payload over 64 kB is stored as {"truncated": true}; the device keeps the full copy.
-- Whether a client-sent tenant id is this tenant, compared as a uuid (case-insensitive);
-- anything that is not a uuid is not.
create or replace function samesight.is_tenant(value text, tenant uuid)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and value::uuid = tenant;
$$;

-- The payload is kept only when it belongs to the caller's current tenant. A user moved
-- to another tenant may still upload writes queued under the old one; those are refused,
-- and their content must not become readable by the new tenant's admins. The device
-- keeps the full copy either way.
create or replace function public.record_rejection(rejections jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  tenant uuid := (select samesight.tenant_id());
  r jsonb;
  tbl text;
  rid text;
  payload jsonb;
  visible boolean;
begin
  if jsonb_typeof(rejections) is distinct from 'array' then
    raise exception 'record_rejection: rejections must be a JSON array';
  end if;
  if jsonb_array_length(rejections) > 100 then
    raise exception 'record_rejection: at most 100 rejections per call';
  end if;
  if tenant is null then
    raise exception 'record_rejection: the token carries no tenant' using errcode = '28000';
  end if;
  for r in select value from jsonb_array_elements(rejections) loop
    tbl := r ->> 'table';
    rid := r ->> 'id';
    payload := coalesce(r -> 'data', '{}'::jsonb);
    if jsonb_typeof(payload) <> 'object' then
      payload := '{}'::jsonb;
    end if;
    if payload ? 'tenantId' then
      -- A PUT carries its tenant.
      if not samesight.is_tenant(payload ->> 'tenantId', tenant) then
        payload := '{"redacted": "another tenant"}'::jsonb;
      end if;
    else
      -- A PATCH or DELETE does not: keep it only if the row is one the caller can see now.
      visible := false;
      if tbl in ('Site', 'Inspection', 'Finding', 'Photo')
        and rid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        execute format('select exists (select 1 from public.%I where id = $1)', tbl)
          into visible using rid::uuid;
      end if;
      if not visible then
        payload := '{"redacted": "not visible to this tenant"}'::jsonb;
      end if;
    end if;
    if pg_column_size(payload) > 65536 then
      payload := '{"truncated": true}'::jsonb;
    end if;
    insert into samesight."RejectedWrite"
      ("tenantId", "actorUserId", "resourceType", "resourceId", "opType", payload,
       "reasonCode", "reasonMessage", "httpStatus")
    values (
      tenant,
      (select auth.uid()),
      left(coalesce(tbl, ''), 200),
      left(coalesce(rid, ''), 200),
      left(coalesce(r ->> 'op', ''), 20),
      payload,
      left(coalesce(r ->> 'code', 'UNKNOWN'), 100),
      left(coalesce(r ->> 'message', ''), 2000),
      case when jsonb_typeof(r -> 'status') = 'number' then (r ->> 'status')::numeric::integer else 0 end
    );
  end loop;
end;
$$;

revoke execute on function public.record_rejection(jsonb) from public, anon;
grant execute on function public.record_rejection(jsonb) to authenticated;
