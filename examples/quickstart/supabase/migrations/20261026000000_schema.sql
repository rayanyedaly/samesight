create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  org_id uuid not null references public.organizations (id),
  role text not null check (role in ('owner', 'member'))
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (org_id, id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  project_id uuid not null,
  title text not null,
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  assignee_id uuid references auth.users (id),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, project_id) references public.projects (org_id, id)
);
create index on public.tasks (project_id);
