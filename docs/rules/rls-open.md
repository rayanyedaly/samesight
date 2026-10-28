# rls-open

Level: warning.

A policy on a synced table that lets any client or any signed-in user through.

## What it catches

A permissive policy with `using (true)` or `with check (true)` for `anon`, `authenticated` or `public` lets them read or write every row of the table through the Supabase API, whatever the sync config sends. The sync config may well send each device only its user's rows: PowerSync replicates past RLS, so the two never meet, and a client that calls the API directly gets what the policy allows.

Lint names what the policy lets through, from its command: reading, updating or deleting every row for `using (true)`, and writing rows with any values for `with check (true)`. Policies for other roles (such as `supabase_auth_admin`) are not reported, nor are restrictive ones, which can only narrow what permissive policies allow. Lint follows `create policy`, `alter policy` and `drop policy` in the migrations, in file order, and the rule runs only with migrations, as [`rls-off`](rls-off.md) does.

## Example

The migration enables RLS on the table the stream sends, then lets every signed-in user read all of it:

<!-- example:rls-open -->
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

alter table public.notes enable row level security;

create policy "signed-in users read notes" on public.notes
  for select to authenticated
  using (true);
```
<!-- /example -->

## What lint prints

<!-- rule-lint:rls-open -->
```console
$ npx samesight lint sync-config.yaml --migrations migrations
sync-config.yaml:7  warning  policy "signed-in users read notes" on notes (migrations/20261028000000_notes.sql:9) lets every signed-in user read every row through the Supabase API, whatever the sync config sends  (rls-open)
1 warning
```
<!-- /rule-lint -->

## The fix

A new migration that replaces the policy with one that compares the row with the user:

```sql
drop policy "signed-in users read notes" on public.notes;

create policy "owners read their notes" on public.notes
  for select to authenticated
  using (owner_id = (select auth.uid()));
```

When every signed-in user is meant to read every row, keep the policy and accept the finding.

## What audit does

Audit compares what devices hold with what RLS returns, so RLS wider than the sync config is no leak to it: here each device holds only its user's notes, which RLS returns too, and the differential passes. Its Database catalog section lists each synced table's policies, and warns about any policy that reads (`SELECT` or `ALL`) and applies to `anon` or `public` on a table `anon` can select. A policy like this one, for `authenticated`, gets no warning, so lint is the check for it.

Audit's write path does fail one case of it: an insert RLS allows that its writer cannot read back, which `with check (true)` beside a narrower read policy lets through.

## Accepting it

Accept the finding by table or policy name:

```bash
npx samesight lint sync-config.yaml --migrations supabase/migrations --allow rls-open:notes
```

A policy name with spaces needs quoting (`--allow 'rls-open:signed-in users read notes'`); the GitHub Action splits `args` on spaces, so accept by table there. `--allow rls-open` accepts every finding of the rule. See [lint](../cli.md#lint).
