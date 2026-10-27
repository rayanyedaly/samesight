-- Teams, who is in which, and a custom access token hook that copies the user's team and
-- role there into the token as top-level claims (team_id, team_role). Team leads read their
-- team's documents. Written for Samesight; modelled on the pattern Supabase documents for
-- access token hooks, none copied.

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  role text not null check (role in ('lead', 'member'))
);

alter table public.documents add column team_id uuid references public.teams (id) on delete set null;

grant select on public.teams, public.memberships to authenticated;
grant select, insert, update, delete on public.teams, public.memberships to service_role;

alter table public.teams enable row level security;
alter table public.memberships enable row level security;

-- Users read their own membership and their team; only the service role writes them.
create policy "own membership" on public.memberships
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "own team" on public.teams
  for select to authenticated
  using (id = ((select auth.jwt()) ->> 'team_id')::uuid);

-- The hook runs as supabase_auth_admin, which RLS does not exempt: it reads memberships
-- through a policy of its own.
grant usage on schema public to supabase_auth_admin;
grant select on public.memberships to supabase_auth_admin;

create policy "auth hook reads memberships" on public.memberships
  for select to supabase_auth_admin
  using (true);

create function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := event -> 'claims';
  m record;
begin
  select team_id, role into m from public.memberships where user_id = (event ->> 'user_id')::uuid;
  if found then
    claims := jsonb_set(claims, '{team_id}', to_jsonb(m.team_id::text));
    claims := jsonb_set(claims, '{team_role}', to_jsonb(m.role));
  end if;
  return jsonb_set(event, '{claims}', claims);
end
$$;

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated, service_role;

-- Leads read their team's documents (archived ones stay with their owner, as above).
create policy "team leads read team documents" on public.documents
  for select to authenticated
  using (team_id = ((select auth.jwt()) ->> 'team_id')::uuid and ((select auth.jwt()) ->> 'team_role') = 'lead');
