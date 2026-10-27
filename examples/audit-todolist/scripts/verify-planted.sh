#!/usr/bin/env bash
# The other half of the Phase 5 gate: the audit must catch a divergence planted in the
# demo's sync config. The lists query loses its owner filter, so every device receives
# every list; RLS still returns each user only their own. The audit starts PowerSync on
# the planted copy and must fail with that leak.
set -euo pipefail
# Plain output to grep, whatever FORCE_COLOR the runner sets.
export NO_COLOR=1
cd "$(dirname "$0")/.."

planted=upstream/sync-config.planted.yaml
sed 's/^\( *- SELECT \* FROM lists\) WHERE owner_id = auth.user_id()$/\1/' upstream/sync-config.yaml > "$planted"
if cmp -s upstream/sync-config.yaml "$planted"; then
  echo "verify-planted.sh: the lists query was not found; has the demo changed?" >&2
  exit 1
fi

log=$(mktemp)
json=$(mktemp)
report=$(mktemp)
trap 'rm -f "$log" "$json" "$report"' EXIT
# One dataset shows the leak; the time limit bounds how long it is shrunk. With --json the
# text goes to stderr, which streams as it runs (tee), so a run killed by a timeout still
# leaves its log; stdout holds the JSON report, and --report writes the Markdown one.
set +e
{ pnpm exec samesight-verify audit --project upstream --sync-config "$planted" --runs 3 --time-limit 60 --json --report "$report" >"$json"; } 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e
if [ "$code" -eq 0 ]; then
  echo "verify-planted.sh: the audit passed on the planted sync config" >&2
  exit 1
fi
# 1 is a finding; 2 is a run that could not finish, which caught nothing.
if [ "$code" -ne 1 ]; then
  echo "verify-planted.sh: the audit exited $code, not 1 (findings)" >&2
  exit 1
fi
if ! grep -qE "^ *leak: u[0-9]+ .*received lists .*; RLS returns no such row" "$log"; then
  echo "verify-planted.sh: the audit failed, but not on the planted lists leak" >&2
  exit 1
fi
# The leak's bug report: the query that sent it, the policy that refuses it, and the fix.
block=$(grep -m1 -A5 -E "^ *leak: u[0-9]+ .*received lists " "$log")
for line in "sent by +stream user_data, queries\[0\]$" "^ +SELECT \* FROM lists$" "refused by +policy \"owned lists\" on lists$" \
  "likely fix +queries\[0\] has no owner_id filter, which policy \"owned lists\" has; add$" "^ +WHERE owner_id = auth\.user_id\(\)$"; do
  if ! grep -qE "$line" <<<"$block"; then
    echo "verify-planted.sh: the leak's report lacks a line matching: $line" >&2
    exit 1
  fi
done
# And the command that replays it: this run's flags, with the seed that failed.
if ! grep -qE "^ +replay +samesight-verify audit --project upstream --sync-config $planted --runs 3 --time-limit 60 --seed [0-9]+$" "$log"; then
  echo "verify-planted.sh: the report lacks the replay line" >&2
  exit 1
fi
# The JSON report: valid against the published schema, and saying what the text says.
if ! npx --yes ajv-cli@5.0.0 validate --spec=draft2020 -s ../../packages/verify/schema/report.schema.json -d "$json"; then
  echo "verify-planted.sh: the --json report does not match its schema" >&2
  exit 1
fi
if ! node -e '
const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const rows = d.sections.flatMap((s) => s.findings).flatMap((f) => f.rows ?? []);
const leak = rows.find((r) => r.kind === "leak" && r.table === "lists");
process.exit(d.exitCode === 1 && d.result === "failed" && d.mode === "audit" && leak?.fix?.add === "WHERE owner_id = auth.user_id()" ? 0 : 1);
' "$json"; then
  echo "verify-planted.sh: the --json report lacks the planted leak, or its exit code" >&2
  exit 1
fi
# The same report as Markdown, for an issue: the leak's heading and its query's SQL.
if ! grep -qE "^### leak: u[0-9]+ .*received lists .*; RLS returns no such row" "$report"; then
  echo "verify-planted.sh: the --report file lacks the leak's heading" >&2
  exit 1
fi
if ! grep -qx '```sql' "$report" || ! grep -qx 'SELECT \* FROM lists' "$report"; then
  echo "verify-planted.sh: the --report file lacks the query's SQL in a sql block" >&2
  exit 1
fi
echo "The audit caught the planted divergence."
