# rls-off

Level: warning.

A synced table whose migrations never enable row level security.

## What it catches

Here RLS does not fail to stop a leak: it is missing. PowerSync replicates past RLS, so devices are unaffected, and the sync config alone decides what they receive. The risk is the Supabase API, which lets any client holding the project's public anon key read and change every row of a `public` table without RLS, unless the table's grants to `anon` and `authenticated` were revoked.

Lint reads RLS from the migrations, best-effort: it follows plain DDL in file order (`alter table` enabling or disabling row level security, renaming the table or moving it out of `public`, `drop table`), and does not see RLS changed inside functions, `DO` blocks or dynamic SQL. So a table whose RLS is switched on some other way is reported too. The rule runs only with migrations, from `supabase/migrations` or the directory `--migrations` names; without them, lint says on stderr that it did not run.

## Example

The migration creates the table the stream sends, and never enables RLS on it:

<!-- example:rls-off -->
`sync-config.yaml`:

```yaml
config:
  edition: 3

streams:
  my_notes:
    auto_subscribe: true
    query: SELECT * FROM notes WHERE owner_id = auth.user_id()
```

`migrations/20261028000000_notes.sql`:

```sql
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  body text not null default ''
);
```
<!-- /example -->

## What lint prints

<!-- rule-lint:rls-off -->
```console
$ npx samesight lint sync-config.yaml --migrations migrations
sync-config.yaml:7  warning  notes is synced, but the migrations never enable row level security on it, so unless its grants to anon and authenticated were revoked, any client can read and change every row through the Supabase API  (rls-off)
1 warning
```
<!-- /rule-lint -->

## The fix

A new migration that enables RLS on the table, with a policy for the rows each user may read:

```sql
alter table public.notes enable row level security;

create policy "owners read their notes" on public.notes
  for select to authenticated
  using (owner_id = (select auth.uid()));
```

With RLS on and no policy, the API returns no row of the table to clients, so add the policies the app needs.

## What audit does

Audit reads the database, not the migrations. Its Database catalog section fails when RLS is off on a synced table (`row level security: off on notes, so the REST API returns every row to anyone with a grant`), and the run stops before the differential. A table whose RLS is on in the database, however it got there, passes.

## Accepting it

When the table's grants to `anon` and `authenticated` are revoked, or RLS is enabled in a way lint cannot follow, accept the finding by table name:

```bash
npx samesight lint sync-config.yaml --migrations supabase/migrations --allow rls-off:notes
```

`--allow rls-off` accepts every finding of the rule. See [lint](../cli.md#lint).
