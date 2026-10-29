create table public.members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid not null references auth.users (id),
  display_name text not null,
  email text not null,
  full_name text not null,
  joined_at timestamptz not null default now()
);

alter table public.members enable row level security;

-- The requesting user's orgs, read past RLS so the policy below does not recurse.
create function public.my_org_ids() returns setof uuid
  language sql stable security definer set search_path = ''
  as $$ select org_id from public.members where user_id = (select auth.uid()) $$;

create policy "org members read each other" on public.members
  for select to authenticated
  using (org_id in (select public.my_org_ids()));
