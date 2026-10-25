#!/usr/bin/env bash
# Starts Fieldbook's local stack: Supabase (supabase start) plus the PowerSync service
# (docker-compose.yml). Safe to re-run. Writes two gitignored files:
#   .env        PS_REPLICATION_PASSWORD and PS_STORAGE_PASSWORD, read by docker-compose.yml
#   .env.local  the public URLs and publishable key, read by Next.js
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. ES256 signing key for Supabase Auth; PowerSync verifies tokens via the JWKS.
keys=supabase/signing_keys.json
if [ ! -s "$keys" ] || [ "$(tr -d '[:space:]' < "$keys")" = "[]" ]; then
  echo "[]" > "$keys"
  pnpm exec supabase gen signing-key --algorithm ES256 --append
fi

# 2. Supabase: Postgres, Auth, REST, Storage. Applies supabase/migrations.
pnpm exec supabase start

# 3. Local passwords for the replication role and PowerSync bucket storage: random,
#    generated once, never committed. Postgres applies POSTGRES_PASSWORD only when it
#    creates its volume, so a new storage password also means a new (empty) volume.
#    Bucket storage is a cache that PowerSync rebuilds from the database.
if ! grep -q "^PS_STORAGE_PASSWORD=" .env 2>/dev/null; then
  PS_STORAGE_PASSWORD=unused PS_REPLICATION_PASSWORD=unused docker compose down -v
fi
for name in PS_REPLICATION_PASSWORD PS_STORAGE_PASSWORD; do
  if ! grep -q "^${name}=" .env 2>/dev/null; then
    echo "${name}=$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')" >> .env
  fi
done
password=$(grep '^PS_REPLICATION_PASSWORD=' .env | cut -d= -f2)
docker exec supabase_db_fieldbook psql -v ON_ERROR_STOP=1 -q -U supabase_admin -d postgres \
  -c "alter role powersync_role with login password '${password}'"

# 4. Next.js environment (public values only). POWERSYNC_PORT may come from the shell
#    or from .env, as it can for docker compose.
port=${POWERSYNC_PORT:-$(grep "^POWERSYNC_PORT=" .env 2>/dev/null | cut -d= -f2 || true)}
status=$(pnpm exec supabase status -o env)
value() { printf '%s\n' "$status" | grep "^$1=" | cut -d= -f2- | tr -d '"'; }
cat > .env.local <<ENV
NEXT_PUBLIC_SUPABASE_URL=$(value API_URL)
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$(value PUBLISHABLE_KEY)
NEXT_PUBLIC_POWERSYNC_URL=http://127.0.0.1:${port:-8080}
ENV

# 5. PowerSync service. Restart it so it rereads powersync/*.yaml.
docker compose up -d --wait --force-recreate powersync
echo "Fieldbook stack is up. Seed it with: pnpm --filter fieldbook seed"
