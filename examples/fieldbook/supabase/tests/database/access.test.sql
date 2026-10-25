-- Fieldbook access layer: the claims hook, RLS writes and reads, grants and the
-- append-only rules. Run with `pnpm --filter fieldbook test:db` (supabase test db)
-- against the local stack. Everything runs in one transaction and is rolled back.
--
-- Each "as <user>" block sets the same things PostgREST sets for a request: role
-- authenticated and request.jwt.claims (sub, tenant_id, app_role).

begin;
create extension if not exists pgtap with schema extensions;
select plan(61);

-- Fixtures ---------------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email) values
  ('a0000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin-a@test.local'),
  ('a0000000-0000-0000-0000-00000000001a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'insp-a@test.local'),
  ('a0000000-0000-0000-0000-00000000002a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'insp2-a@test.local'),
  ('a0000000-0000-0000-0000-00000000003a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer-a@test.local'),
  ('b0000000-0000-0000-0000-00000000001b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'insp-b@test.local');

insert into public."Tenant" (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000000', 'Tenant A'),
  ('bbbbbbbb-0000-0000-0000-000000000000', 'Tenant B');

insert into public."Membership" ("userId", "tenantId", role, "displayName") values
  ('a0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000000', 'ADMIN', 'Admin A'),
  ('a0000000-0000-0000-0000-00000000001a', 'aaaaaaaa-0000-0000-0000-000000000000', 'INSPECTOR', 'Inspector A'),
  ('a0000000-0000-0000-0000-00000000002a', 'aaaaaaaa-0000-0000-0000-000000000000', 'INSPECTOR', 'Inspector A2'),
  ('a0000000-0000-0000-0000-00000000003a', 'aaaaaaaa-0000-0000-0000-000000000000', 'VIEWER', 'Viewer A'),
  ('b0000000-0000-0000-0000-00000000001b', 'bbbbbbbb-0000-0000-0000-000000000000', 'INSPECTOR', 'Inspector B');

insert into public."Site" (id, "tenantId", name) values
  ('51000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000000', 'Site A'),
  ('51000000-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000000', 'Site B');

-- IA: assigned to inspector A. IA2: assigned to inspector A2. IA3: inspector A's,
-- already published. IB: tenant B.
insert into public."Inspection" (id, "tenantId", "siteId", "assigneeId", title, status, "updatedAt") values
  ('1a000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000000', '51000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000001a', 'IA', 'IN_PROGRESS', '2000-01-01'),
  ('1a000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000000', '51000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000002a', 'IA2', 'IN_PROGRESS', '2000-01-01'),
  ('1a000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000000', '51000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000001a', 'IA3', 'PUBLISHED', '2000-01-01'),
  ('1b000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000000', '51000000-0000-0000-0000-00000000000b', 'b0000000-0000-0000-0000-00000000001b', 'IB', 'IN_PROGRESS', '2000-01-01');

insert into public."Finding" (id, "tenantId", "inspectionId", body, severity, "createdBy") values
  ('f1000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000000', '1a000000-0000-0000-0000-000000000001', 'on IA', 'LOW', 'a0000000-0000-0000-0000-00000000001a'),
  ('f1000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000000', '1a000000-0000-0000-0000-000000000002', 'on IA2', 'LOW', 'a0000000-0000-0000-0000-00000000002a');

insert into public."Photo" (id, "tenantId", "inspectionId", "storagePath", sha256, "createdBy") values
  ('9f000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000000', '1a000000-0000-0000-0000-000000000001', 'a/ia/p.jpg', repeat('0', 64), 'a0000000-0000-0000-0000-00000000001a');

-- Custom access token hook --------------------------------------------------------------

select is(
  samesight.custom_access_token_hook(jsonb_build_object(
    'user_id', 'a0000000-0000-0000-0000-00000000001a',
    'claims', jsonb_build_object('sub', 'a0000000-0000-0000-0000-00000000001a', 'role', 'authenticated')
  )) -> 'claims',
  jsonb_build_object(
    'sub', 'a0000000-0000-0000-0000-00000000001a', 'role', 'authenticated',
    'tenant_id', 'aaaaaaaa-0000-0000-0000-000000000000', 'app_role', 'INSPECTOR'
  ),
  'hook: a member gets tenant_id and app_role from Membership; other claims pass through'
);

select is(
  samesight.custom_access_token_hook(jsonb_build_object(
    'user_id', 'c0000000-0000-0000-0000-000000000000',
    'claims', jsonb_build_object(
      'sub', 'c0000000-0000-0000-0000-000000000000', 'role', 'authenticated',
      'tenant_id', 'bbbbbbbb-0000-0000-0000-000000000000', 'app_role', 'ADMIN'
    )
  )) -> 'claims',
  jsonb_build_object('sub', 'c0000000-0000-0000-0000-000000000000', 'role', 'authenticated'),
  'hook: a non-member loses any tenant_id and app_role already in the claims'
);

select ok(
  not has_function_privilege('authenticated', 'samesight.custom_access_token_hook(jsonb)', 'execute')
  and not has_function_privilege('anon', 'samesight.custom_access_token_hook(jsonb)', 'execute')
  and has_function_privilege('supabase_auth_admin', 'samesight.custom_access_token_hook(jsonb)', 'execute'),
  'hook: only supabase_auth_admin can execute it'
);

-- Grants -----------------------------------------------------------------------------

select ok(
  not has_table_privilege('anon', 'public."Inspection"', 'select')
  and not has_table_privilege('anon', 'public."Finding"', 'select'),
  'grants: anon cannot read application tables'
);

select ok(
  not has_sequence_privilege('authenticated', 'public."Finding_seq_seq"', 'usage')
  and not has_sequence_privilege('authenticated', 'public."Finding_seq_seq"', 'update'),
  'grants: authenticated cannot move the Finding seq sequence'
);

select ok(
  not has_column_privilege('authenticated', 'public."Inspection"', 'tenantId', 'update')
  and not has_column_privilege('authenticated', 'public."Inspection"', 'siteId', 'update')
  and not has_column_privilege('authenticated', 'public."Inspection"', 'updatedAt', 'update'),
  'grants: tenantId, siteId and updatedAt are not client-updatable'
);

-- Inserts are granted per column: server-owned columns are not among them.
select ok(
  not has_column_privilege('authenticated', 'public."Inspection"', 'createdAt', 'insert')
  and not has_column_privilege('authenticated', 'public."Inspection"', 'updatedAt', 'insert')
  and not has_column_privilege('authenticated', 'public."Site"', 'createdAt', 'insert')
  and not has_column_privilege('authenticated', 'public."Finding"', 'seq', 'insert')
  and not has_column_privilege('authenticated', 'public."Finding"', 'createdAt', 'insert')
  and not has_column_privilege('authenticated', 'public."Photo"', 'createdAt', 'insert')
  and has_column_privilege('authenticated', 'public."Finding"', 'createdBy', 'insert'),
  'grants: server-owned columns are not client-insertable (the author column is, for its check)'
);

select is_empty(
  $$select t from unnest(array['Tenant', 'Membership', 'Site', 'Inspection', 'Finding', 'Photo']) t
     where has_table_privilege('authenticated', format('public.%I', t), 'insert')
        or has_table_privilege('authenticated', format('public.%I', t), 'update')$$,
  'grants: no table-wide insert or update for authenticated, only column grants'
);

select ok(
  not has_any_column_privilege('authenticated', 'public."Tenant"', 'insert, update')
  and not has_any_column_privilege('authenticated', 'public."Membership"', 'insert, update')
  and not has_table_privilege('authenticated', 'public."Tenant"', 'delete')
  and not has_table_privilege('authenticated', 'public."Membership"', 'delete'),
  'grants: clients cannot write Tenant or Membership'
);

-- The admin stream sends every Finding and Photo of the tenant without checking the
-- inspection: safe only while these composite keys and NOT NULLs hold.
select fk_ok('public', 'Finding', array['tenantId', 'inspectionId'], 'public', 'Inspection', array['tenantId', 'id']);
select fk_ok('public', 'Photo', array['tenantId', 'inspectionId'], 'public', 'Inspection', array['tenantId', 'id']);
select col_not_null('public', 'Finding', 'inspectionId', 'Finding.inspectionId is NOT NULL');
select col_not_null('public', 'Photo', 'inspectionId', 'Photo.inspectionId is NOT NULL');

select set_eq(
  $$select tablename::text from pg_publication_tables where pubname = 'powersync'$$,
  array['Tenant', 'Membership', 'Site', 'Inspection', 'Finding', 'Photo'],
  'replication: the publication carries exactly the synced tables'
);

select ok(
  (select rolreplication and rolbypassrls from pg_roles where rolname = 'powersync_role'),
  'replication: powersync_role has REPLICATION and BYPASSRLS'
);

select policies_are('public', 'Site', array['Site: read', 'Site: insert', 'Site: update', 'Site: delete'], 'Site carries only the generated policies');

-- As inspector A ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000001a","role":"authenticated","tenant_id":"aaaaaaaa-0000-0000-0000-000000000000","app_role":"INSPECTOR"}', true);

select results_eq(
  'select title from public."Inspection" order by title',
  $$values ('IA'), ('IA3')$$,
  'inspector reads only the inspections assigned to them'
);

select results_eq(
  'select body from public."Finding" order by body',
  $$values ('on IA')$$,
  'inspector reads findings only on their assigned inspection'
);

select lives_ok(
  $$insert into public."Finding" (id, "tenantId", "inspectionId", body, severity, "createdBy")
    values ('f1000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000000', '1a000000-0000-0000-0000-000000000001', 'new', 'LOW', 'a0000000-0000-0000-0000-00000000001a')$$,
  'inspector adds a finding to their assigned inspection (seq is assigned without sequence grants)'
);

select throws_ok(
  $$insert into public."Finding" (id, "tenantId", "inspectionId", body, severity, "createdBy")
    values (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000000', '1b000000-0000-0000-0000-000000000001', 'x', 'LOW', 'a0000000-0000-0000-0000-00000000001a')$$,
  '42501', null,
  'inspector cannot write a finding into another tenant'
);

select throws_ok(
  $$insert into public."Finding" (id, "tenantId", "inspectionId", body, severity, "createdBy")
    values (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000000', '1b000000-0000-0000-0000-000000000001', 'x', 'LOW', 'a0000000-0000-0000-0000-00000000001a')$$,
  '42501', null,
  'inspector cannot attach a finding to another tenant''s inspection under their own tenantId'
);

select throws_ok(
  $$insert into public."Finding" (id, "tenantId", "inspectionId", body, severity, "createdBy")
    values (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000000', '1a000000-0000-0000-0000-000000000002', 'x', 'LOW', 'a0000000-0000-0000-0000-00000000001a')$$,
  '42501', null,
  'inspector cannot add findings to an inspection assigned to someone else'
);

select throws_ok(
  $$insert into public."Finding" (id, "tenantId", "inspectionId", body, severity, "createdBy")
    values (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000000', '1a000000-0000-0000-0000-000000000001', 'x', 'LOW', 'a0000000-0000-0000-0000-00000000002a')$$,
  '42501', null,
  'inspector cannot create a finding as another user'
);

select throws_ok(
  $$insert into public."Finding" (id, "tenantId", "inspectionId", "supersedesId", body, severity, "createdBy")
    values ('f1000000-0000-0000-0000-0000000000ff', 'aaaaaaaa-0000-0000-0000-000000000000', '1a000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-0000000000ff', 'x', 'LOW', 'a0000000-0000-0000-0000-00000000001a')$$,
  '23514', null,
  'a finding cannot supersede itself'
);

select throws_ok(
  $$insert into public."Finding" (id, "tenantId", "inspectionId", "supersedesId", body, severity, "createdBy")
    values (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000000', '1a000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000002', 'x', 'LOW', 'a0000000-0000-0000-0000-00000000001a')$$,
  '23503', null,
  'an amendment must supersede a finding on the same inspection'
);

select throws_ok(
  $$update public."Finding" set body = 'edited' where id = 'f1000000-0000-0000-0000-000000000001'$$,
  '42501', null,
  'inspector cannot edit a finding'
);

-- The positive case first, so the rejections below fail on policy, not missing grants.
select lives_ok(
  $$update public."Inspection" set status = 'DRAFT', "internalNotes" = 'checked' where id = '1a000000-0000-0000-0000-000000000001'$$,
  'inspector updates status and notes on their own in-progress inspection'
);

select is(
  (select status || ':' || "internalNotes" from public."Inspection" where id = '1a000000-0000-0000-0000-000000000001'),
  'DRAFT:checked',
  '...and the change is applied'
);

select throws_ok(
  $$update public."Inspection" set "assigneeId" = 'a0000000-0000-0000-0000-00000000002a' where id = '1a000000-0000-0000-0000-000000000001'$$,
  '42501', null,
  'inspector cannot hand their inspection to someone else'
);

select throws_ok(
  $$update public."Inspection" set status = 'PUBLISHED' where id = '1a000000-0000-0000-0000-000000000001'$$,
  '42501', null,
  'inspector cannot publish'
);

select throws_ok(
  $$update public."Inspection" set "tenantId" = 'bbbbbbbb-0000-0000-0000-000000000000' where id = '1a000000-0000-0000-0000-000000000001'$$,
  '42501', null,
  'inspector cannot move an inspection to another tenant'
);

select lives_ok(
  $$update public."Inspection" set status = 'IN_PROGRESS' where id = '1a000000-0000-0000-0000-000000000003'$$,
  'an inspector un-publishing their published inspection runs...'
);

select is(
  (select status from public."Inspection" where id = '1a000000-0000-0000-0000-000000000003'),
  'PUBLISHED',
  '...and changes nothing: only an admin changes a published inspection'
);

select lives_ok(
  $$update public."Inspection" set status = 'DRAFT' where id = '1a000000-0000-0000-0000-000000000002'$$,
  'an update to an inspection the inspector cannot see runs...'
);

reset role;
select is(
  (select status from public."Inspection" where id = '1a000000-0000-0000-0000-000000000002'),
  'IN_PROGRESS',
  '...and changes nothing (RLS filters the row; PostgREST reports 0 rows, no error)'
);

-- Write role gates: the column grants go to every signed-in user, so the role term in
-- each write policy is all that keeps inspectors and viewers out.

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000001a","role":"authenticated","tenant_id":"aaaaaaaa-0000-0000-0000-000000000000","app_role":"INSPECTOR"}', true);

select throws_ok(
  $$insert into public."Site" (id, "tenantId", name) values ('51000000-0000-0000-0000-0000000000ff', 'aaaaaaaa-0000-0000-0000-000000000000', 'x')$$,
  '42501', null,
  'an inspector cannot add a site'
);
select throws_ok(
  $$insert into public."Inspection" (id, "tenantId", "siteId", title) values ('1a000000-0000-0000-0000-0000000000ff', 'aaaaaaaa-0000-0000-0000-000000000000', '51000000-0000-0000-0000-00000000000a', 'x')$$,
  '42501', null,
  'an inspector cannot create an inspection'
);
select lives_ok($$update public."Site" set name = 'renamed' where id = '51000000-0000-0000-0000-00000000000a'$$, 'an inspector''s site rename runs...');
select lives_ok($$delete from public."Inspection" where id = '1a000000-0000-0000-0000-000000000001'$$, '...as does an inspector''s inspection delete...');

reset role;
select ok(
  (select name = 'Site A' from public."Site" where id = '51000000-0000-0000-0000-00000000000a')
  and exists (select from public."Inspection" where id = '1a000000-0000-0000-0000-000000000001'),
  '...and neither changes anything'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000003a","role":"authenticated","tenant_id":"aaaaaaaa-0000-0000-0000-000000000000","app_role":"VIEWER"}', true);
select throws_ok(
  $$insert into public."Photo" (id, "tenantId", "inspectionId", "storagePath", sha256) values ('9f000000-0000-0000-0000-0000000000ff', 'aaaaaaaa-0000-0000-0000-000000000000', '1a000000-0000-0000-0000-000000000003', 'x', repeat('0', 64))$$,
  '42501', null,
  'a viewer cannot add a photo'
);
reset role;

-- As viewer A ------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000003a","role":"authenticated","tenant_id":"aaaaaaaa-0000-0000-0000-000000000000","app_role":"VIEWER"}', true);

select results_eq(
  'select title from public."Inspection"',
  $$values ('IA3')$$,
  'viewer reads only published and archived inspections'
);

select is(
  (select count(*)::int from public."Finding"),
  0,
  'viewer reads no findings of unpublished inspections'
);

select throws_ok(
  $$insert into public."Finding" (id, "tenantId", "inspectionId", body, severity, "createdBy")
    values (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000000', '1a000000-0000-0000-0000-000000000001', 'x', 'LOW', 'a0000000-0000-0000-0000-00000000003a')$$,
  '42501', null,
  'viewer cannot add findings'
);

-- As admin A -------------------------------------------------------------------------

reset role;
update public."Inspection" set status = 'PUBLISHED' where id = '1a000000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000000a","role":"authenticated","tenant_id":"aaaaaaaa-0000-0000-0000-000000000000","app_role":"ADMIN"}', true);

select is(
  (select count(*)::int from public."Site" where "tenantId" = 'bbbbbbbb-0000-0000-0000-000000000000'),
  0,
  'admin reads nothing from another tenant'
);

select throws_ok(
  $$update public."Inspection" set "assigneeId" = 'b0000000-0000-0000-0000-00000000001b' where id = '1a000000-0000-0000-0000-000000000001'$$,
  '42501', null,
  'admin cannot assign a user from another tenant'
);

select throws_ok(
  $$update public."Inspection" set "assigneeId" = 'a0000000-0000-0000-0000-00000000003a' where id = '1a000000-0000-0000-0000-000000000001'$$,
  '42501', null,
  'admin cannot assign a viewer'
);

select throws_ok(
  $$insert into public."Inspection" (id, "tenantId", "siteId", title)
    values (gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000000', '51000000-0000-0000-0000-00000000000b', 'x')$$,
  '42501', null,
  'admin cannot create an inspection in another tenant'
);

select lives_ok(
  $$update public."Site" set name = 'Site A renamed' where id = '51000000-0000-0000-0000-00000000000a'$$,
  'admin renames a site in their tenant'
);

select is(
  (select name from public."Site" where id = '51000000-0000-0000-0000-00000000000a'),
  'Site A renamed',
  '...and the change is applied'
);

-- Backdate updatedAt (with the trigger off) so the next check sees the admin's update.
reset role;
alter table public."Inspection" disable trigger "Inspection_touch";
update public."Inspection" set "updatedAt" = '2000-01-01' where id = '1a000000-0000-0000-0000-000000000001';
alter table public."Inspection" enable trigger "Inspection_touch";
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000000a","role":"authenticated","tenant_id":"aaaaaaaa-0000-0000-0000-000000000000","app_role":"ADMIN"}', true);

select lives_ok(
  $$update public."Inspection" set "assigneeId" = 'a0000000-0000-0000-0000-00000000002a', status = 'ARCHIVED'
    where id = '1a000000-0000-0000-0000-000000000001'$$,
  'admin reassigns to an inspector in their tenant and archives'
);

reset role;
select is(
  (select "updatedAt" from public."Inspection" where id = '1a000000-0000-0000-0000-000000000001'),
  now(),
  'updatedAt is set by the server on update'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-00000000000a","role":"authenticated","tenant_id":"aaaaaaaa-0000-0000-0000-000000000000","app_role":"ADMIN"}', true);

select throws_ok(
  $$delete from public."Inspection" where id = '1a000000-0000-0000-0000-000000000001'$$,
  '23503', null,
  'an inspection with findings cannot be deleted'
);

-- Append-only, below RLS ---------------------------------------------------------------

reset role;

select throws_ok(
  $$update public."Finding" set body = 'edited' where id = 'f1000000-0000-0000-0000-000000000001'$$,
  '23001', null,
  'append-only: UPDATE on Finding fails even for the table owner'
);

select throws_ok(
  $$delete from public."Finding" where id = 'f1000000-0000-0000-0000-000000000001'$$,
  '23001', null,
  'append-only: DELETE on Finding fails even for the table owner'
);

select throws_ok(
  'truncate public."Photo"',
  '23001', null,
  'append-only: TRUNCATE on Photo fails'
);

select has_trigger(
  'public', 'Finding', 'Finding_no_truncate',
  'Finding has its own TRUNCATE guard (the cascade below would also hit Photo''s)'
);

select throws_ok(
  'truncate public."Finding" cascade',
  '23001', null,
  'append-only: TRUNCATE on Finding fails'
);

select throws_ok(
  $$delete from public."Site" where id = '51000000-0000-0000-0000-00000000000a'$$,
  '23503', null,
  'deleting a site does not cascade into findings'
);

set local role service_role;
select throws_ok(
  $$update public."Finding" set body = 'edited' where id = 'f1000000-0000-0000-0000-000000000001'$$,
  '42501', null,
  'service_role has no UPDATE on Finding'
);
select throws_ok(
  'truncate public."Photo"',
  '42501', null,
  'service_role has no TRUNCATE on Photo'
);

select * from finish();
rollback;
