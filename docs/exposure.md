# Exposure map

`samesight exposure` prints, for each table a sync config sends, who receives its rows and which of its columns go with them, and marks the columns that look personal. It reads the sync config and the SQL migrations, nothing else: no database, no PowerSync, no policy file.

## Why columns

PowerSync replicates your tables with a database role that bypasses row level security, so the sync config alone decides which rows reach which device. Lint and audit check which rows each device gets. But RLS is per row: it says which rows a user may read, never which columns. A query that sends a row sends every column it selects, and a `SELECT *` sends them all. A member's email and phone number go to everyone the row reaches, unless the query leaves them out.

The map answers one question: who receives which columns of which tables. What devices do not need, do not send. That is the idea behind data minimisation in the GDPR and the minimum necessary standard in HIPAA; the map shows where to look, nothing more.

## Running it

```bash
npx samesight exposure
npx samesight exposure powersync/sync-config.yaml --migrations supabase/migrations
npx samesight exposure --format json
```

With no file named, it looks for the sync config where lint does: `sync-config.yaml` or `sync-rules.yaml`, in the current directory and then under `powersync/`. It reads the migrations in `supabase/migrations`, or in the directory `--migrations` names. Without them, it says so on stderr: a `SELECT *` lists no columns, since only the migrations say what the table holds, no column comment is read, and every table is taken to be keyed by `id`.

It exits 0 whatever the map shows: it informs, it never fails a run. It exits 2 when a file cannot be read, no sync config is found or an option is wrong.

## An example

A sync config that sends each user the members of their organisations, and their own notes:

<!-- exposure-example:org-members -->
`sync-config.yaml`:

```yaml
config:
  edition: 3

streams:
  org_members:
    auto_subscribe: true
    with:
      my_orgs: SELECT org_id FROM org_members WHERE user_id = auth.user_id()
    query: SELECT * FROM org_members WHERE org_id IN my_orgs
  my_notes:
    auto_subscribe: true
    query: SELECT id, title, body FROM notes WHERE owner_id = auth.user_id()
```

`migrations/20261029000000_orgs.sql`:

```sql
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
```
<!-- /exposure-example -->

What the map shows:

<!-- exposure:org-members -->
```console
$ npx samesight exposure sync-config.yaml --migrations migrations
notes
  sent by  stream my_notes, query  (sync-config.yaml:12)
  to       only the row's owner (owner_id)
  columns  id, title, body [free text, marked in its comment]

org_members
  sent by  stream org_members, query  (sync-config.yaml:9)
  to       members of the row's group, through with.my_orgs
  columns  id, org_id, user_id, full_name [identifier], email [contact], phone [contact], role  (all columns, from the migrations)

2 tables. 3 likely personal columns reach users other than the row's owner: org_members.full_name, org_members.email, org_members.phone.
Columns are matched by name or a samesight comment marker, never by their data.
```
<!-- /exposure -->

RLS and the sync config agree here: no device gets a row its user may not read. Still, every member of an organisation receives every other member's full name, email and phone number. If the app shows only names, the query can list the columns it needs instead of `*`. The notes' body is marked personal in its comment, but only its owner receives it, so the summary leaves it out.

## Reading it

Each table gets a block, and each query that sends it three lines:

- `sent by`: the stream (or sync rules bucket) and query, and where it starts in the file. `when the app subscribes` marks a stream that is not `auto_subscribe`: devices get its rows only when the app subscribes, with the parameters it sends. `as t on devices` says an alias renames the table on the device.
- `to`: who receives the rows. For a sync rules bucket with several parameter queries, the widest audience comes first, then one `through parameters[n]` line for each.
- `columns`: the columns as devices name them. `[contact]` marks a column that looks personal, with its category, and `marked in its comment` says a comment marker decided it. `(from email)` names the columns a renamed or computed column is read from, when its name does not show them. A `SELECT *` lists the table's columns from the migrations; when the migrations define the table only in part (`LIKE`, `INHERITS`, `CREATE TABLE AS`), or not at all, it says so.

Then queries it could not read, with why, and a summary: how many tables, and the columns that look personal and reach users other than the row's owner, one for each column sent: as `table.column`, with `as name` when the device names it otherwise (`members.email as contact`). When some of what those users receive is not known (a query it could not read, a `*` whose columns the migrations do not give), the summary says so and claims nothing about it.

## Who receives the rows

The audiences, narrowest first. The map reads them from the sync config, as lint does, with the tables' primary keys from the migrations when it has them. A table the migrations do not define, or every table when no migrations are read, is taken to be keyed by `id`, as PowerSync's own examples are; a table the migrations give no primary key has no owner through it.

- **only the row's owner (owner_id)**: each row goes to one user, the one whose id is in that column of the row.
- **only the owner of its lists row (lists.owner_id)**: each row goes to one user, the owner of the one row it points at by key (a to-do goes to its list's owner).
- **members of the row's group, through ...**: users tied to the row through something they share: a membership subquery or CTE, a token claim other than the user id, or a sync rules parameter query, which the name after `through` gives.
- **whoever passes a role or claim check**: users who pass a check on who is asking (a role claim, an admin list), not tied to the row.
- **every user, for rows a fixed filter picks**: a fixed filter (`status = 'public'`) picks the rows, and every user gets them.
- **whichever rows a client asks for**: a parameter the client sends picks the rows, so any client can ask for any.
- **every user, for some rows or all (the token check does not tie rows to users)**: the query reads the token, but not in a way that ties a row to the users it reaches (below), so some rows, or all, can reach every user.
- **every user**: nothing limits the rows.

Owner is claimed only where each row surely goes to one user: the user id itself compared with a column of the row, or of the one parent row it points at by key, in every `OR` branch. A group is claimed only where the token is compared plainly with the row, in a query whose tables are all joined by equalities. A token read mixed with more can let users through with no tie to the row: a literal or a column beside it in an `IN` list (`owner_id IN (auth.user_id(), 'system')`), a fallback for a claim a token may lack (`coalesce(auth.parameter('org_id'), 'public')`), a `CASE`, an `IS NULL` test, or a table joined `ON true`. The map says every user, for some rows or all, there. Anything less certain gets the wider audience, never the narrower.

## How personal columns are found

By the column's name or a comment marker, never by its data: the map never reads a row.

- **Whole words**: a name is split into words at `_`, `-`, case changes and digits, and only whole words match. `emailAddress` is an email; `filename` has no `name`, `adobe` no `dob`.
- **Strong words** count anywhere in the name: `user_email`, `home_phone`, `date_of_birth`, `diagnosis_code`, `iban`, `password_hash`. `zip` and `mobile` count only as the last word (`billing_zip`, `work_mobile`, but not `zip_url` or `mobile_app_version`). A name whose last word says something about the data rather than holding it is not counted (`email_verified`, `phone_type`, `owner_id`, though `blood_type` and `patient_id` are), nor is a flag (`is_public`, `has_email`) or a boolean column.
- **Weak words** (`name`, `address`, `city`, `gender`, `notes`, `condition`, `age` and a few more) count only as the whole name of a column (or a numbered one, `address2`) in a table named for people, whose last whole word is `users`, `profiles`, `members`, `patients`, `customers`, `contacts`, `employees` or the like (so `trellouser` is not one): `users.name` and `team_members.name` are personal, `projects.name` is not.
- **Coordinates**: a latitude counts only beside its longitude in the same table.
- **Renamed or computed columns** are checked by the column they read (`lower(email) AS contact` is still the email), else by their name on the device, else by the JSON key they pick (`data ->> 'phone'`).

A comment marker settles what a name cannot, either way. Put it anywhere in the column's comment, in a migration:

```sql
comment on column patients.chief_complaint is 'samesight:personal=health';
comment on column members.email is 'The team''s shared inbox. samesight:not-personal';
```

The categories are `identifier`, `contact`, `location`, `birth`, `health`, `financial`, `secret`, `free-text` and `personal`; `samesight:personal` alone means `personal`, and so does a category it does not know. Markers are read from the migrations, so they count only when it reads them.

## Limits

- It matches names and markers, so it misses a column whose name gives nothing away (`info` holding phone numbers) and can flag one that holds nothing personal. Mark either in its comment.
- It reads the migrations as lint does, best-effort: plain DDL in file order, not tables changed inside functions, `DO` blocks or dynamic SQL. See [lint](cli.md#lint).
- It says what the files show. The [`personal-columns`](rules/personal-columns.md) lint rule flags the same columns in CI. `samesight-verify audit` tests the rows each device receives against RLS, but not their columns, today.

## JSON

`--format json` prints one object on stdout: `version` (1), `files`, `migrations` (the directory it read, or `null`), `maps`, one per file it could read, and `unreadable`, each file it could not read with its error. Each map has its `file`, `kind` (`streams` or `bucket definitions`), `tables` and `unread`. A query there has its `stream`, its label as `query`, `sql`, `autoSubscribe`, `deviceTable`, `audience` (with `mixed: true` on an `everyone` the token check does not tie), `paths` (for a sync rules bucket, the audience through each parameter query, named in `via`; for a stream, its one audience) and `columns`: their `source` (`list`, `schema` or `unknown`), whether they are `complete`, and `items`. Each item has its `name` on the device, the columns it is read `from`, whether it is `derived` and, when it looks personal, `personal` (its category, what matched and whether a name or a comment), `matchedOn` when the match was made on one of the table's columns, and `jsonKey` when it was made on a JSON key. A query also has the `line` it starts on, when found. Notes stay on stderr.
