-- apply_batch and record_rejection: the forged-write cases from the plan's write-path
-- check. Run with `pnpm --filter fieldbook test:db`. One transaction, rolled back.

begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

-- Fixtures ---------------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email) values
  ('a0000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-a@test.local'),
  ('a0000000-0000-0000-0000-00000000001a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'insp-a@test.local'),
  ('a0000000-0000-0000-0000-00000000002a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'insp2-a@test.local'),
  ('b0000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-b@test.local');

insert into public."Tenant" (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000000', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000000', 'Tenant B');

insert into public."Membership" ("userId", "tenantId", role, "displayName") values
  ('a0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000000', 'ADMIN', 'Admin A'),
  ('a0000000-0000-0000-0000-00000000001a', 'aaaaaaaa-0000-0000-0000-000000000000', 'INSPECTOR', 'Inspector A'),
  ('a0000000-0000-0000-0000-00000000002a', 'aaaaaaaa-0000-0000-0000-000000000000', 'INSPECTOR', 'Inspector A2'),
  ('b0000000-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000000', 'ADMIN', 'Admin B');

insert into public."Site" (id, "tenantId", name) values
  ('51000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000000', 'Site A'),
  ('51000000-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000000', 'Site B');

insert into public."Inspection" (id, "tenantId", "siteId", "assigneeId", title, status) values
  ('1a000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000000', '51000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000001a', 'IA', 'IN_PROGRESS'),
  ('1a000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000000', '51000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000002a', 'IA2', 'IN_PROGRESS'),
  ('1b000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000000', '51000000-0000-0000-0000-00000000000b', null, 'IB', 'DRAFT');

insert into public."Finding" (id, "tenantId", "inspectionId", body, severity, "createdBy") values
  ('fb000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000000', '1b000000-0000-0000-0000-000000000001', 'tenant B finding', 'LOW', 'b0000000-0000-0000-0000-00000000000b');

select ok(
  not (select bool_or(prosecdef) from pg_proc where oid in ('public.apply_batch(jsonb)'::regprocedure, 'public.record_rejection(jsonb)'::regprocedure)),
  'both functions run as the caller (SECURITY INVOKER), so RLS applies'
);

select ok(
  not has_function_privilege('anon', 'public.apply_batch(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.record_rejection(jsonb)', 'execute'),
  'anon cannot call apply_batch or record_rejection'
);

-- As inspector A ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000001a","role":"authenticated","tenant_id":"aaaaaaaa-0000-0000-0000-000000000000","app_role":"INSPECTOR"}', true);

select throws_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Finding","id":"f1000000-0000-0000-0000-000000000001",
    "data":{"tenantId":"bbbbbbbb-0000-0000-0000-000000000000","inspectionId":"1a000000-0000-0000-0000-000000000001",
            "body":"forged tenant","severity":"LOW"}}]'::jsonb)$$,
  'P0001', null,
  'a row carrying another tenant is refused (forged, or queued before the user changed tenant)'
);

select lives_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Finding","id":"f1000000-0000-0000-0000-000000000001",
    "data":{"tenantId":"aaaaaaaa-0000-0000-0000-000000000000","inspectionId":"1a000000-0000-0000-0000-000000000001",
            "body":"forged tenant","severity":"LOW","seq":999,"createdBy":"a0000000-0000-0000-0000-00000000002a",
            "createdAt":"garbage","nonsense":"x"}}]'::jsonb)$$,
  'a finding with a forged seq and createdBy, and a malformed createdAt, is accepted...'
);

select is(
  (select "tenantId"::text || ' ' || "createdBy"::text || ' ' || (seq <> 999)::text || ' ' || ("createdAt" > '2001-01-01')::text
     from public."Finding" where id = 'f1000000-0000-0000-0000-000000000001'),
  'aaaaaaaa-0000-0000-0000-000000000000 a0000000-0000-0000-0000-00000000001a true true',
  '...and lands with the caller as author, and server-set seq and createdAt'
);

select lives_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Finding","id":"f1000000-0000-0000-0000-000000000001",
    "data":{"inspectionId":"1a000000-0000-0000-0000-000000000001","body":"replayed with other text","severity":"HIGH"}}]'::jsonb)$$,
  'replaying a finding PUT succeeds...'
);

select results_eq(
  $$select count(*)::int, max(body), max(severity) from public."Finding" where "inspectionId" = '1a000000-0000-0000-0000-000000000001'$$,
  $$values (1, 'forged tenant', 'LOW')$$,
  '...and changes nothing'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Finding","id":"fb000000-0000-0000-0000-000000000001",
    "data":{"inspectionId":"1a000000-0000-0000-0000-000000000001","body":"x","severity":"LOW"}}]'::jsonb)$$,
  'P0001', null,
  'a PUT reusing another tenant''s finding id is refused, not silently skipped'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"PATCH","table":"Finding","id":"f1000000-0000-0000-0000-000000000001","data":{"body":"edited"}}]'::jsonb)$$,
  'P0001', 'apply_batch: Finding is append-only; add a new row instead',
  'PATCH on an append-only table is refused'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"DELETE","table":"Finding","id":"f1000000-0000-0000-0000-000000000001"}]'::jsonb)$$,
  'P0001', 'apply_batch: Finding is append-only and cannot be deleted',
  'DELETE on an append-only table is refused'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Membership","id":"00000000-0000-0000-0000-000000000001","data":{"role":"ADMIN"}}]'::jsonb)$$,
  'SS001', null,
  'a table outside the allowlist is refused as a server mismatch (held by the client, not discarded)'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"MERGE","table":"Site","data":[]}]'::jsonb)$$,
  'SS001', null,
  'an op this server does not know is held (SS001) before any shape check'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Finding","id":"f1000000-0000-0000-0000-000000000002",
    "data":{"inspectionId":"1b000000-0000-0000-0000-000000000001","body":"x","severity":"LOW"}}]'::jsonb)$$,
  '42501', null,
  'a finding on another tenant''s inspection is refused (RLS, before the tenant foreign key)'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Finding","id":"f1000000-0000-0000-0000-000000000003",
    "data":{"inspectionId":"1a000000-0000-0000-0000-000000000002","body":"x","severity":"LOW"}}]'::jsonb)$$,
  '42501', null,
  'a finding on an inspection assigned to someone else is refused by RLS'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"PATCH","table":"Inspection","id":"1a000000-0000-0000-0000-000000000002","data":{"status":"DRAFT"}}]'::jsonb)$$,
  'P0001', null,
  'a PATCH on a row RLS hides raises instead of updating nothing'
);

select throws_ok(
  $$select public.apply_batch('[
    {"op":"PUT","table":"Finding","id":"f1000000-0000-0000-0000-000000000004",
     "data":{"inspectionId":"1a000000-0000-0000-0000-000000000001","body":"first op","severity":"LOW"}},
    {"op":"PATCH","table":"Finding","id":"f1000000-0000-0000-0000-000000000004","data":{"body":"second op"}}]'::jsonb)$$,
  'P0001', null,
  'a batch with one refused op fails...'
);

select is(
  (select count(*)::int from public."Finding" where id = 'f1000000-0000-0000-0000-000000000004'),
  0,
  '...and none of its ops are applied'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"PATCH","table":"Inspection","id":"1a000000-0000-0000-0000-000000000001",
    "data":{"status":"DRAFT","siteId":"51000000-0000-0000-0000-00000000000b"}}]'::jsonb)$$,
  'P0001', null,
  'a PATCH changing a column clients may not change is refused, not half-applied...'
);

select lives_ok(
  $$select public.apply_batch('[{"op":"PATCH","table":"Inspection","id":"1a000000-0000-0000-0000-000000000001","data":{"status":"DRAFT"}}]'::jsonb)$$,
  '...while one changing only allowed columns applies'
);

select is(
  (select status || ' ' || "siteId"::text from public."Inspection" where id = '1a000000-0000-0000-0000-000000000001'),
  'DRAFT 51000000-0000-0000-0000-00000000000a',
  'the inspection has the new status and its original site'
);

-- PowerSync sends PUT for a local upsert too. An inspector may update this inspection but
-- not insert one; the existing row goes to the UPDATE path, never past the INSERT policy.
select is(
  public.apply_batch('[{"op":"PUT","table":"Inspection","id":"1a000000-0000-0000-0000-000000000001",
    "data":{"title":"IA renamed","status":"IN_PROGRESS","siteId":"51000000-0000-0000-0000-00000000000a"}}]'::jsonb),
  1,
  'a PUT of an existing row by a role that may update but not insert it applies, and apply_batch counts it'
);

select is(
  (select title || ' ' || status from public."Inspection" where id = '1a000000-0000-0000-0000-000000000001'),
  'IA renamed IN_PROGRESS',
  '...as an update of the allowed columns'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"DELETE","table":"Inspection","id":"1a000000-0000-0000-0000-000000000001"}]'::jsonb)$$,
  'P0001', null,
  'a DELETE that RLS refuses on a visible row raises instead of reporting success'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"PATCH","table":"Inspection","id":"1a000000-0000-0000-0000-000000000001","data":{"status":"PUBLISHED"}}]'::jsonb)$$,
  '42501', null,
  'an inspector cannot publish through apply_batch'
);

-- As admin A -------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000000a","role":"authenticated","tenant_id":"aaaaaaaa-0000-0000-0000-000000000000","app_role":"ADMIN"}', true);

select throws_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Site","id":"51000000-0000-0000-0000-0000000000a2",
    "data":{"tenantId":"bbbbbbbb-0000-0000-0000-000000000000","name":"New site","address":"1 Road"}}]'::jsonb)$$,
  'P0001', null,
  'a site queued under another tenant is refused, not re-homed into the current one'
);

select lives_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Site","id":"51000000-0000-0000-0000-0000000000a2",
    "data":{"tenantId":"aaaaaaaa-0000-0000-0000-000000000000","name":"New site","address":"1 Road"}}]'::jsonb)$$,
  'an admin creates a site...'
);

select lives_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Site","id":"51000000-0000-0000-0000-0000000000a2","data":{"name":"Renamed site","address":"1 Road"}}]'::jsonb)$$,
  '...a second PUT of the same site updates it (last write wins)...'
);

select is(
  (select name || ' ' || "tenantId"::text from public."Site" where id = '51000000-0000-0000-0000-0000000000a2'),
  'Renamed site aaaaaaaa-0000-0000-0000-000000000000',
  '...in the admin''s own tenant'
);

select throws_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Site","id":"51000000-0000-0000-0000-00000000000b","data":{"name":"Hijacked"}}]'::jsonb)$$,
  'P0001', null,
  'a PUT reusing another tenant''s site id cannot overwrite it'
);

select lives_ok(
  $$select public.apply_batch('[{"op":"DELETE","table":"Site","id":"51000000-0000-0000-0000-0000000000ff"}]'::jsonb)$$,
  'deleting a site that does not exist is a no-op (a replayed delete)'
);

select lives_ok(
  $$select public.apply_batch('[{"op":"DELETE","table":"Site","id":"51000000-0000-0000-0000-00000000000b"}]'::jsonb)$$,
  'deleting another tenant''s site looks like a no-op...'
);

reset role;
select is(
  (select count(*)::int from public."Site" where id = '51000000-0000-0000-0000-00000000000b'),
  1,
  '...and leaves it in place'
);
set local role authenticated;

select lives_ok(
  $$select public.record_rejection('[{"table":"Finding","id":"f9","op":"PUT","data":{"tenantId":"aaaaaaaa-0000-0000-0000-000000000000","body":"lost text"},
    "code":"42501","message":"refused","status":403,"tenantId":"bbbbbbbb-0000-0000-0000-000000000000"}]'::jsonb)$$,
  'record_rejection stores a refused write...'
);

select is(
  (select "tenantId"::text || ' ' || "actorUserId"::text || ' ' || (payload ->> 'body')
     from samesight."RejectedWrite" where "resourceId" = 'f9'),
  'aaaaaaaa-0000-0000-0000-000000000000 a0000000-0000-0000-0000-00000000000a lost text',
  '...under the caller''s tenant and identity, whatever the payload claims'
);

select is(
  (select count(*)::int from samesight."RejectedWrite"),
  1,
  'the tenant''s admin reads it'
);

select lives_ok(
  $$select public.record_rejection('[
    {"table":"Finding","id":"f7","op":"PUT","data":{"tenantId":"bbbbbbbb-0000-0000-0000-000000000000","body":"old tenant text"},"code":"P0001","message":"x","status":400},
    {"table":"Inspection","id":"1b000000-0000-0000-0000-000000000001","op":"PATCH","data":{"internalNotes":"old tenant notes"},"code":"P0001","message":"x","status":400},
    {"table":"Inspection","id":"1a000000-0000-0000-0000-000000000001","op":"PATCH","data":{"status":"DRAFT"},"code":"42501","message":"x","status":403}]'::jsonb)$$,
  'record_rejection takes writes queued under another tenant...'
);

select results_eq(
  $$select "resourceId", payload::text from samesight."RejectedWrite" where "resourceId" in ('f7', '1b000000-0000-0000-0000-000000000001', '1a000000-0000-0000-0000-000000000001') order by "resourceId"$$,
  $$values ('1a000000-0000-0000-0000-000000000001', '{"status": "DRAFT"}'),
           ('1b000000-0000-0000-0000-000000000001', '{"redacted": "not visible to this tenant"}'),
           ('f7', '{"redacted": "another tenant"}')$$,
  '...but keeps their content only when it belongs to the current tenant'
);

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000001a","role":"authenticated","tenant_id":"aaaaaaaa-0000-0000-0000-000000000000","app_role":"INSPECTOR"}', true);

select is(
  (select count(*)::int from samesight."RejectedWrite"),
  0,
  'an inspector of the same tenant does not'
);

-- Without a tenant (a token minted before the membership existed) ----------------------

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000001a","role":"authenticated"}', true);

select throws_ok(
  $$select public.apply_batch('[{"op":"PUT","table":"Site","id":"51000000-0000-0000-0000-0000000000a3","data":{"name":"x"}}]'::jsonb)$$,
  '28000', null,
  'apply_batch without a tenant raises 28000 (refresh and retry), not a refusal'
);

select throws_ok(
  $$select public.record_rejection('[{"table":"Finding","id":"f8","op":"PUT","data":{},"code":"x","message":"x","status":400}]'::jsonb)$$,
  '28000', null,
  'record_rejection without a tenant stores nothing'
);

-- As admin B ---------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-00000000000b","role":"authenticated","tenant_id":"bbbbbbbb-0000-0000-0000-000000000000","app_role":"ADMIN"}', true);

select is(
  (select count(*)::int from samesight."RejectedWrite"),
  0,
  'another tenant''s admin cannot read those rejections'
);

select * from finish();
rollback;
