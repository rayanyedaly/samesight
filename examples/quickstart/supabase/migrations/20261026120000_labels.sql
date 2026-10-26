-- Labels every organization shares: written by migrations or the service role, never by clients.
create table public.labels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null,
  status text not null default 'active' check (status in ('active', 'retired'))
);

insert into public.labels (name, color, status) values
  ('bug', '#d73a4a', 'active'),
  ('design', '#a2eeef', 'active'),
  ('legacy', '#cccccc', 'retired');
