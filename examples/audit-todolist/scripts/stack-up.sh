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
echo "To-do list demo stack is up. Audit it with: pnpm --filter audit-todolist verify"
