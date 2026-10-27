# Audit: PowerSync's Supabase to-do list demo

The first outside project `samesight-verify audit` runs on: PowerSync's
[react-supabase-todolist](https://github.com/powersync-ja/powersync-js/tree/main/demos/react-supabase-todolist)
demo (CC0 1.0), with its hand-written RLS and sync config and no Samesight policy.

Nothing from the demo is committed here. `scripts/fetch.sh` downloads its migration,
sync config and Supabase config at a pinned commit into `upstream/` (gitignored), checks
each file's hash, and only moves the Supabase ports (5532x, beside Fieldbook) and adds an
Auth signing key. The policies and sync config are audited as published.

[`sync-rules.yaml`](sync-rules.yaml) holds the same access rules written as legacy sync
rules (`bucket_definitions`), the form most PowerSync apps used before sync streams;
`verify:rules` audits it, then a copy whose parameter query lost its owner filter.

Only Supabase is started by hand. Each audit starts its own PowerSync service for the run
(it needs Docker), on whichever sync config it is given, and removes it afterwards; see
[what audit starts and removes](../../docs/verify.md#what-audit-starts-and-removes).
If you ran this example when it still had a `docker-compose.yml`, remove what that left once,
before `stack:down`, and delete `.env`:

```bash
docker compose -p audit-todolist down -v
docker exec -i supabase_db_react-supabase-todolist psql -U postgres <<'SQL'
select pg_drop_replication_slot(slot_name) from pg_replication_slots where not active and starts_with(slot_name, 'powersync');
do $$ begin
  if exists (select from pg_roles where rolname = 'samesight_replication') then
    revoke all on all tables in schema public from samesight_replication;
    revoke all on schema public from samesight_replication;
    drop role samesight_replication;
  end if;
end $$;
SQL
```

```bash
pnpm --filter audit-todolist stack:up        # fetch, then supabase start
pnpm --filter audit-todolist verify          # must pass on the demo as published
pnpm --filter audit-todolist verify:planted  # must fail: the lists query loses its owner filter
pnpm --filter audit-todolist verify:rules    # the same rules as legacy sync rules: pass, then a planted leak
pnpm --filter audit-todolist stack:down
```
