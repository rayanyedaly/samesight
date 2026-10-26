#!/usr/bin/env bash
# The other half of the Phase 5 gate: the audit must catch a divergence planted in the
# demo's sync config. The lists query loses its owner filter, so every device receives
# every list; RLS still returns each user only their own. PowerSync is restarted on the
# planted copy, the audit must fail with a leak, and the original is put back.
set -euo pipefail
cd "$(dirname "$0")/.."

planted=upstream/sync-config.planted.yaml
sed 's/^\( *- SELECT \* FROM lists\) WHERE owner_id = auth.user_id()$/\1/' upstream/sync-config.yaml > "$planted"
if cmp -s upstream/sync-config.yaml "$planted"; then
  echo "verify-planted.sh: the lists query was not found; has the demo changed?" >&2
  exit 1
fi

slots() {
  docker exec supabase_db_react-supabase-todolist psql -tA -U postgres -d postgres \
    -c "select slot_name from pg_replication_slots where slot_name like 'powersync%' order by 1"
}
# Recreates PowerSync on the given sync config, then waits until it serves it: ready is not
# enough, since PowerSync keeps the old rules until the new ones have caught up. New rules
# get a new replication slot; they are live once it is the only one.
reload() {
  local before now fresh
  before=$(slots)
  SYNC_CONFIG=$1 docker compose up -d --wait --force-recreate powersync > /dev/null
  for _ in $(seq 240); do
    now=$(slots)
    fresh=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$now") | grep -c . || true)
    if [ "$(printf '%s\n' "$now" | grep -c .)" = 1 ] && [ "$fresh" = 1 ]; then return 0; fi
    sleep 0.5
  done
  echo "verify-planted.sh: PowerSync did not take up $1 within 120s (slots: $now)" >&2
  return 1
}

log=$(mktemp)
restore() {
  rm -f "$log"
  reload ./upstream/sync-config.yaml
}
trap restore EXIT
reload "./$planted"

# One dataset shows the leak; the time limit bounds how long it is shrunk. Output streams
# as it runs (tee), so a run killed by a timeout still leaves its log.
set +e
pnpm exec samesight-verify audit --project upstream --sync-config "$planted" --powersync http://127.0.0.1:8081 --runs 3 --time-limit 60 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e
if [ "$code" -eq 0 ]; then
  echo "verify-planted.sh: the audit passed on the planted sync config" >&2
  exit 1
fi
if ! grep -q "received lists .*RLS returns no such row" "$log"; then
  echo "verify-planted.sh: the audit failed, but not on the planted lists leak" >&2
  exit 1
fi
echo "The audit caught the planted divergence."
