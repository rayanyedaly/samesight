#!/usr/bin/env bash
# Starts the to-do list demo's local stack: Supabase (the demo's own migration) plus the
# PowerSync service (docker-compose.yml) on 127.0.0.1:8081. Safe to re-run. Writes the
# gitignored .env that docker-compose.yml reads.
set -euo pipefail
cd "$(dirname "$0")/.."

# Re-fetch when the pinned commit in fetch.sh changes.
pinned=$(grep '^commit=' scripts/fetch.sh | cut -d= -f2)
[ "$(cat upstream/.commit 2>/dev/null || true)" = "$pinned" ] || bash scripts/fetch.sh

# 1. ES256 signing key for Supabase Auth; PowerSync verifies tokens via the JWKS.
keys=upstream/supabase/signing_keys.json
if [ ! -s "$keys" ] || [ "$(tr -d '[:space:]' < "$keys")" = "[]" ]; then
  echo "[]" > "$keys"
  # The key is local and gitignored; it is not printed into logs.
  pnpm exec supabase --workdir upstream gen signing-key --algorithm ES256 --append > /dev/null
fi

# 2. Supabase: Postgres, Auth, REST and the gateway are all the audit needs.
pnpm exec supabase --workdir upstream start -x realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor

# 3. A replication role for PowerSync, with a local random password. The demo connects
#    as postgres; a dedicated role keeps the upstream setup out of this repository.
#    BYPASSRLS, as PowerSync requires: its initial snapshot reads the tables under RLS.
if ! grep -q "^PS_STORAGE_PASSWORD=" .env 2>/dev/null; then
  PS_STORAGE_PASSWORD=unused PS_REPLICATION_PASSWORD=unused docker compose down -v
  # The wiped storage's replication slots would hold WAL, and the verifier would wait on them.
  docker exec supabase_db_react-supabase-todolist psql -q -U supabase_admin -d postgres \
    -c "select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name like 'powersync%' and not active" > /dev/null
fi
for name in PS_REPLICATION_PASSWORD PS_STORAGE_PASSWORD; do
  if ! grep -q "^${name}=" .env 2>/dev/null; then
    echo "${name}=$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')" >> .env
  fi
done
password=$(grep '^PS_REPLICATION_PASSWORD=' .env | cut -d= -f2)
docker exec -i supabase_db_react-supabase-todolist psql -v ON_ERROR_STOP=1 -q -U supabase_admin -d postgres <<SQL
do \$\$ begin
  if not exists (select from pg_roles where rolname = 'samesight_replication') then
    create role samesight_replication with replication bypassrls login;
  end if;
end \$\$;
alter role samesight_replication with replication bypassrls login password '${password}';
grant usage on schema public to samesight_replication;
grant select on public.lists, public.todos to samesight_replication;
SQL

# 4. PowerSync service. Recreated so it rereads its config (SYNC_CONFIG picks the file).
docker compose up -d --wait --force-recreate powersync
echo "To-do list demo stack is up. Audit it with: pnpm --filter audit-todolist verify"
