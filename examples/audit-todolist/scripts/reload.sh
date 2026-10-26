# Sourced by the verify scripts. reload <file> recreates PowerSync on that sync config, then
# waits until it serves it: ready is not enough, since PowerSync keeps the old rules until
# the new ones have caught up. New rules get a new replication slot; they are live once it
# is the only one.

slots() {
  docker exec supabase_db_react-supabase-todolist psql -tA -U postgres -d postgres \
    -c "select slot_name from pg_replication_slots where slot_name like 'powersync%' order by 1"
}

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
  echo "reload: PowerSync did not take up $1 within 120s (slots: $now)" >&2
  return 1
}
