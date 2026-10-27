-- Orgs and their documents. Who reads what comes from the user id and from two claims an
-- admin sets in the user's app_metadata: a role (editor or admin) and the user's org.
-- Written for Samesight; modelled on patterns common in public Supabase apps, none copied.

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.orgs, public.documents to authenticated;
grant select, insert, update, delete on public.orgs, public.documents to service_role;

alter table public.orgs enable row level security;
alter table public.documents enable row level security;

-- Orgs: the owner, the org's members and admins read them; only the owner writes.
create policy "org owners" on public.orgs
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "org members" on public.orgs
  for select to authenticated
  using (id = ((select auth.jwt()) -> 'app_metadata' ->> 'org_id')::uuid);

create policy "admins read orgs" on public.orgs
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Documents: owners read and write their own; editors read published ones; admins and the
-- org's members read the rest. Nobody but the owner reads an archived document.
create policy "own documents" on public.documents
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "editors read published" on public.documents
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'editor' and status = 'published');

create policy "admins read all" on public.documents
  for select to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "org members read" on public.documents
  for select to authenticated
  using (org_id = ((select auth.jwt()) -> 'app_metadata' ->> 'org_id')::uuid);

create policy "no archived" on public.documents
  as restrictive for select to authenticated
  using (status <> 'archived' or owner_id = (select auth.uid()));

create publication powersync for table public.orgs, public.documents;
