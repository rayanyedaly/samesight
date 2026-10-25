#!/usr/bin/env bash
# Wipes Fieldbook's local data and reseeds: stops PowerSync and clears its bucket
# storage (its replication slot goes with the old database), reapplies
# supabase/migrations, then brings the stack back up and seeds it.
set -euo pipefail
cd "$(dirname "$0")/.."
PS_STORAGE_PASSWORD=${PS_STORAGE_PASSWORD:-unused} PS_REPLICATION_PASSWORD=${PS_REPLICATION_PASSWORD:-unused} \
  docker compose down -v
pnpm exec supabase db reset
bash scripts/stack-up.sh
node scripts/seed.ts
