-- Members see only the projects they were added to; owners see every project.
create table public.project_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  project_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  unique (project_id, user_id),
  foreign key (org_id, project_id) references public.projects (org_id, id)
);
create index on public.project_members (user_id);
