#!/usr/bin/env bash
# The audit must catch a leak only users holding a role can see: the editor stream loses its
# status filter, so editors receive drafts and archived documents RLS refuses them. A run
# whose users held no role (as before audit gave them claims) passes this planted config.
set -euo pipefail
cd "$(dirname "$0")/.."

planted=sync-config.planted.yaml
sed "s/^\( *- SELECT \* FROM documents WHERE auth.parameter('\$.app_metadata.role') = 'editor'\) AND status = 'published'$/\1/" sync-config.yaml > "$planted"
if cmp -s sync-config.yaml "$planted"; then
  echo "verify-planted.sh: the editor query was not found in sync-config.yaml" >&2
  exit 1
fi

log=$(mktemp)
trap 'rm -f "$log" "$planted"' EXIT
set +e
pnpm exec samesight-verify audit --sync-config "$planted" --runs 3 --time-limit 60 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e
if [ "$code" -eq 0 ]; then
  echo "verify-planted.sh: the audit passed on the planted sync config" >&2
  exit 1
fi
if ! grep -qE "u[0-9]+ \([^)]*app_metadata\.role=editor[,)].*received documents .*RLS returns no such row" "$log"; then
  echo "verify-planted.sh: the audit failed, but not on an editor receiving a document RLS refuses" >&2
  exit 1
fi
echo "The audit caught the planted editor leak."
