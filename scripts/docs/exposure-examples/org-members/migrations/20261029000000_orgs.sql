create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  user_id uuid not null references auth.users (id),
  full_name text not null,
  email text not null,
  phone text,
  role text not null default 'member'
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  title text not null,
  body text not null default ''
);

comment on column public.notes.body is 'Whatever the user writes. samesight:personal=free-text';

alter table public.org_members enable row level security;
alter table public.notes enable row level security;

-- The user's organisations, read as the function's owner, so the policy below does not
-- read org_members through its own RLS.
create function public.my_org_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select org_id from public.org_members where user_id = (select auth.uid()) $$;

create policy "members read their organisations' members" on public.org_members
  for select to authenticated
  using (org_id in (select public.my_org_ids()));

create policy "owners read their notes" on public.notes
  for select to authenticated
  using (owner_id = (select auth.uid()));
