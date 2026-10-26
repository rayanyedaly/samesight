#!/usr/bin/env bash
# Audit mode on legacy sync rules (bucket_definitions). The demo's rules, written in that
# form in sync-rules.yaml, must pass; a planted copy whose parameter query lost its owner
# filter (every user gets a bucket for every list) must fail with a leak. PowerSync is put
# back on the published sync config on every exit.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=reload.sh
source scripts/reload.sh

planted=upstream/sync-rules.planted.yaml
sed 's/^\( *parameters: SELECT id AS list_id FROM lists\) WHERE owner_id = request.user_id()$/\1/' sync-rules.yaml > "$planted"
if cmp -s sync-rules.yaml "$planted"; then
  echo "verify-rules.sh: the parameter query was not found in sync-rules.yaml" >&2
  exit 1
fi

log=$(mktemp)
restore() {
  rm -f "$log" "$planted"
  reload ./upstream/sync-config.yaml
}
trap restore EXIT

reload ./sync-rules.yaml
pnpm exec samesight-verify audit --project upstream --sync-config sync-rules.yaml --powersync http://127.0.0.1:8081 --compose docker-compose.yml --runs 4

reload "./$planted"
set +e
pnpm exec samesight-verify audit --project upstream --sync-config "$planted" --powersync http://127.0.0.1:8081 --runs 3 --time-limit 60 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e
if [ "$code" -eq 0 ]; then
  echo "verify-rules.sh: the audit passed on the planted sync rules" >&2
  exit 1
fi
if ! grep -q "received lists .*RLS returns no such row" "$log"; then
  echo "verify-rules.sh: the audit failed, but not on the planted lists leak" >&2
  exit 1
fi
echo "Sync rules: the audit passes on the demo's rules and caught the planted divergence."
