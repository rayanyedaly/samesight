# personal-columns

Level: warning, or info (a note) when a role check decides who gets the rows, or when any client or every user gets them.

A column that likely holds personal data, sent to users other than the row's owner.

## What it catches

PowerSync sends a device every column a query selects, and for `SELECT *` every column of the table. RLS does not narrow that: PowerSync replicates past it, and RLS filters rows, not columns. So a row a user is meant to see can carry a column they are not: a colleague's email or full name, a patient's diagnosis, on every device in the organisation, in a local database its user can open.

For each query, lint reads who receives its rows, as [`unscoped-query`](unscoped-query.md) and [`client-scoped`](client-scoped.md) read them, and which columns it sends (see [the exposure map](../exposure.md)). It reports each column that likely holds personal data, once per query that sends it to anyone but the row's owner:

- a warning when the members of a group get it (through a membership subquery or CTE, a token claim such as `org_id`, or a sync rules parameter query), or every user for the rows a fixed filter picks (`status = 'public'`). Often meant, so it is a decision: do they need that column?
- a note when whoever passes a check on who is asking gets it (a role claim, an admin list): often admins, so confirm only users meant to see it pass the check. A sync rules bucket that a group or a fixed filter also reaches, through another parameter query, warns instead, and the message names each way in. And a note when any client or every user gets it: `unscoped-query` or `client-scoped` usually fails that query already, and the note keeps the column in view if that error is accepted with `--allow`. (A sync rules parameter query whose users lint cannot read, such as one with `UNION`, counts as reaching every user, and may have no error of its own.)

Rows only their owner gets (`owner_id = auth.user_id()`, or through the owner of the parent row they point at) are not reported, and a query lint cannot read is [`unreadable-query`](unreadable-query.md)'s.

### What counts as personal

Lint judges a column by its name and its comment, never by its data, so a finding from a name says "likely":

- Whole words of the name, split at `_`, `-`, a change of case and a run of digits: `email`, `phone`, `first_name`, `date_of_birth`, `ssn`, `ip_address`, `diagnosis`, `iban`, `password`, wherever they stand (`billing_email`, `homeZip`). `filename` has no `name`, and `gzip` no `zip`.
- Weak words (`name`, `address`, `city`, `gender`, `notes`, `age`, `condition` and a few more) count only as the whole name of a column, or a numbered one (`address2`), in a table named for people (`users`, `profiles`, `members`, `customers`, `contacts`, `patients`, `employees`, `team_members`): `members.name`, but not `projects.name` or `members.role_name`.
- A flag or a column about the data is not the data: `is_public`, `has_email`, `email_verified`, `phone_type`, `owner_id`, `created_by`, and a column the migrations declare `boolean`. `display_name` and `username` are left out, since people choose them to be shown.
- A latitude counts only beside its longitude (`lat` with `lng`, `home_latitude` with `home_longitude`).
- A renamed or derived column counts by the table column it reads (`lower(email) AS contact` is still the email), else by its name on the device, else by the JSON key it picks (`data ->> 'phone'`). A literal holds nobody's data.

A comment settles what a name cannot: see [Marking columns](#marking-columns). Comments, and the columns a `SELECT *` sends, are read from the migrations (`supabase/migrations`, or the directory `--migrations` names); without them lint reports only the columns a query lists.

## Example

A team app syncs each user the members of their organisations, with a policy that lets them read the same rows through the API:

<!-- example:personal-columns -->
`sync-config.yaml`:

```yaml
config:
  edition: 3

streams:
  org_members:
    auto_subscribe: true
    with:
      my_orgs: SELECT org_id FROM members WHERE user_id = auth.user_id()
    query: SELECT * FROM members WHERE org_id IN my_orgs
```

`migrations/20261029000000_members.sql`:

```sql
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
```
<!-- /example -->

Every row is one the user may read, but the `*` sends each colleague's email and full name with it, though the app shows only display names.

## What lint prints

<!-- rule-lint:personal-columns -->
```console
$ npx samesight lint sync-config.yaml --migrations migrations
sync-config.yaml:9  warning  stream org_members, query sends members.email (likely contact data, by its name) to members of the row's group, through with.my_orgs, not only the row's owner; fine if they need it, else drop it from the query  (personal-columns)
sync-config.yaml:9  warning  stream org_members, query sends members.full_name (likely identifying data, by its name) to members of the row's group, through with.my_orgs, not only the row's owner; fine if they need it, else drop it from the query  (personal-columns)
2 warnings
```
<!-- /rule-lint -->

## The fix

List the columns the app needs, and leave the others out:

```yaml
    query: SELECT id, org_id, user_id, display_name, joined_at FROM members WHERE org_id IN my_orgs
```

The user's own email is in their session (`supabase.auth.getUser()`), so the app does not need the stream for it. A column the table gains later is not sent until the query names it.

## What audit does

Audit tests rows, not columns, today. It compares the rows each device holds with the rows RLS returns its user, so a personal column sent with rows the user may read is no leak to it: here each device holds only the members of its user's organisations, which RLS returns too, and the differential does not fail. Which columns go with the rows is lint's to check.

## Accepting it

When the group does need the column, such as a team directory with emails, accept the finding by column, by table, or by stream:

```bash
npx samesight lint sync-config.yaml --migrations supabase/migrations --allow personal-columns:members.email
npx samesight lint sync-config.yaml --migrations supabase/migrations --allow personal-columns:members
```

A column that is not personal, whatever its name says, is better marked in its comment (below): the mark keeps it quiet wherever it is sent. `--allow personal-columns` accepts every finding of the rule. See [lint](../cli.md#lint).

## Marking columns

A `samesight:` marker in a column's comment, in the migrations, settles what its name cannot:

```sql
comment on column public.visits.reason is 'Why the patient came in. samesight:personal=health';
comment on column public.teams.contact_email is 'The team''s shared inbox. samesight:not-personal';
```

- `samesight:personal=<category>` marks a column personal, whatever its name; the finding then says what the comment marks (`health data, marked in its comment`). The categories are `identifier`, `contact`, `location`, `birth`, `health`, `financial`, `secret`, `free-text` and `personal`; `samesight:personal` alone, or a category lint does not know, means `personal`.
- `samesight:not-personal` marks a column not personal, whatever its name, and whatever a query renames it to.

The marker can stand anywhere in the comment, in any case; the first one counts. A comment set in a function, a `DO` block or dynamic SQL is not seen, as the [migrations reader](../cli.md#lint) follows plain DDL only.
