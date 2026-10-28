create table public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  body text not null default ''
);

alter table public.notes enable row level security;

create policy "signed-in users read notes" on public.notes
  for select to authenticated
  using (true);
