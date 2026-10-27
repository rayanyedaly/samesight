#!/usr/bin/env bash
# Fails when audit runs left anything behind on a project's local stack: auto-started
# containers, samesight_audit_ roles or replication slots, run users (@verify.samesight.test)
# or the runs' rows (uuid keys starting 5a3e5a3e). With a publication name, also fails when
# that publication is gone; with "all" after it, when it no longer lists every table.
#
#   scripts/ci/left-behind.sh <database container> [publication [all]]
set -euo pipefail

db="${1:?usage: left-behind.sh <database container> [publication [all]]}"
publication="${2:-}"
sql() { docker exec "$db" psql -v ON_ERROR_STOP=1 -tA -U postgres -d postgres -c "$1"; }

containers=$(docker ps --all --quiet --filter label=dev.samesight.audit.run | tr '\n' ' ')
roles=$(sql "select count(*) from pg_roles where starts_with(rolname, 'samesight_audit_')")
slots=$(sql "select count(*) from pg_replication_slots where starts_with(slot_name, 'samesight_audit_')")
users=$(sql "select count(*) from auth.users where email like '%@verify.samesight.test'")
# Every uuid column of every public table: a run's rows are keyed, and point at each other, by prefixed uuids.
rows=$(sql "select coalesce(sum((xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I where %I::text like %L', table_schema, table_name, column_name, '5a3e5a3e%'), false, true, '')))[1]::text::int), 0)
              from information_schema.columns where table_schema = 'public' and data_type = 'uuid'")

problems=()
[ -z "${containers// /}" ] || problems+=("containers: $containers")
[ "$roles" = 0 ] || problems+=("$roles samesight_audit_ roles")
[ "$slots" = 0 ] || problems+=("$slots samesight_audit_ replication slots")
[ "$users" = 0 ] || problems+=("$users run users")
[ "$rows" = 0 ] || problems+=("$rows values of run rows in public uuid columns")
if [ -n "$publication" ]; then
  filter=""
  [ "${3:-}" = "all" ] && filter=" and puballtables"
  [ "$(sql "select count(*) from pg_publication where pubname = '$publication'$filter")" = 1 ] || problems+=("publication $publication changed or gone")
fi

if [ "${#problems[@]}" -gt 0 ]; then
  printf 'left behind on %s:\n' "$db"
  printf '  %s\n' "${problems[@]}"
  exit 1
fi
echo "nothing left behind on $db"
