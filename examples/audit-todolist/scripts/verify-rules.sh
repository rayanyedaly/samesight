#!/usr/bin/env bash
# Audit mode on legacy sync rules (bucket_definitions). The demo's rules, written in that
# form in sync-rules.yaml, must pass; a planted copy whose parameter query lost its owner
# filter (every user gets a bucket for every list) must fail with a leak. Each audit starts
# PowerSync on the file it is given.
set -euo pipefail
# Plain output to grep, whatever FORCE_COLOR the runner sets.
export NO_COLOR=1
cd "$(dirname "$0")/.."

planted=upstream/sync-rules.planted.yaml
sed 's/^\( *parameters: SELECT id AS list_id FROM lists\) WHERE owner_id = request.user_id()$/\1/' sync-rules.yaml > "$planted"
if cmp -s sync-rules.yaml "$planted"; then
  echo "verify-rules.sh: the parameter query was not found in sync-rules.yaml" >&2
  exit 1
fi

log=$(mktemp)
trap 'rm -f "$log" "$planted"' EXIT

pnpm exec samesight-verify audit --project upstream --sync-config sync-rules.yaml --runs 4

set +e
pnpm exec samesight-verify audit --project upstream --sync-config "$planted" --runs 3 --time-limit 60 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e
if [ "$code" -eq 0 ]; then
  echo "verify-rules.sh: the audit passed on the planted sync rules" >&2
  exit 1
fi
# 1 is a finding; 2 is a run that could not finish, which caught nothing.
if [ "$code" -ne 1 ]; then
  echo "verify-rules.sh: the audit exited $code, not 1 (findings)" >&2
  exit 1
fi
if ! grep -qE "^ *leak: u[0-9]+ .*received lists .*; RLS returns no such row" "$log"; then
  echo "verify-rules.sh: the audit failed, but not on the planted lists leak" >&2
  exit 1
fi
echo "Sync rules: the audit passes on the demo's rules and caught the planted divergence."
