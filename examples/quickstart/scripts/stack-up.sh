#!/usr/bin/env bash
# Steps 5 and 6 of docs/getting-started.md as a script: an ES256 signing key for Auth,
# `supabase start` (which applies the migrations, the generated one included), a local
# password for the replication role, and the PowerSync service. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

keys=supabase/signing_keys.json
if [ ! -s "$keys" ] || [ "$(tr -d '[:space:]' < "$keys")" = "[]" ]; then
  echo "[]" > "$keys"
  pnpm exec supabase gen signing-key --algorithm ES256 --append
fi

pnpm exec supabase start

if ! grep -q "^PS_STORAGE_PASSWORD=" .env 2>/dev/null; then
  PS_STORAGE_PASSWORD=unused PS_REPLICATION_PASSWORD=unused docker compose down -v
fi
for name in PS_REPLICATION_PASSWORD PS_STORAGE_PASSWORD; do
  if ! grep -q "^${name}=" .env 2>/dev/null; then
    echo "${name}=$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')" >> .env
  fi
done
password=$(grep '^PS_REPLICATION_PASSWORD=' .env | cut -d= -f2)
docker exec supabase_db_quickstart psql -v ON_ERROR_STOP=1 -q -U supabase_admin -d postgres \
  -c "alter role powersync_role with login password '${password}'"

docker compose up -d --wait --force-recreate powersync
echo "Quickstart stack is up. Verify it with: pnpm --filter quickstart policy:verify"
