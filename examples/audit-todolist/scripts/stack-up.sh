#!/usr/bin/env bash
# Starts the to-do list demo's local Supabase stack, with the demo's own migration. Safe to
# re-run. PowerSync is not started here: each audit starts its own for the run (Docker),
# with the sync config it is given, and removes it at the end.
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

# 3. Wait until Postgres takes connections: the CLI can return while it still restarts.
project=$(sed -n 's/^project_id *= *"\(.*\)"/\1/p' upstream/supabase/config.toml)
[ -n "$project" ] || { echo "stack-up.sh: no project_id in config.toml" >&2; exit 1; }
for _ in $(seq 1 60); do
  docker exec "supabase_db_$project" pg_isready -U postgres -q && break
  sleep 1
done
docker exec "supabase_db_$project" pg_isready -U postgres -q || { echo "stack-up.sh: Postgres is not ready after 60s" >&2; exit 1; }
echo "To-do list demo stack is up. Audit it with: pnpm --filter audit-todolist verify"
