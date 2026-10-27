#!/usr/bin/env bash
# The audit must catch a leak only some run users can see, planted in a copy of the sync
# config:
#   editor (the default): the editor stream loses its status filter, so editors receive
#     drafts and archived documents RLS refuses them. Users holding no role pass it.
#   team: the team stream loses its lead filter, so team members receive their team's
#     documents, which RLS gives leads only. Users with no membership rows pass it: the
#     team and team role come from the access token hook.
set -euo pipefail
cd "$(dirname "$0")/.."

which="${1:-editor}"
planted=sync-config.planted.yaml
case "$which" in
  editor)
    sed "s/^\( *- SELECT \* FROM documents WHERE auth.parameter('\$.app_metadata.role') = 'editor'\) AND status = 'published'$/\1/" sync-config.yaml > "$planted"
    caught="u[0-9]+ \([^)]*app_metadata\.role=editor[,)].*received documents .*\(stream editor\); RLS returns no such row"
    ;;
  team)
    sed "s/^\( *- SELECT \* FROM documents WHERE team_id = auth.parameter('team_id')\) AND auth.parameter('team_role') = 'lead'\( AND status != 'archived'\)$/\1\2/" sync-config.yaml > "$planted"
    caught="u[0-9]+ \([^)]*team_role=member\).*received documents .*\(stream team\); RLS returns no such row"
    ;;
  *)
    echo "verify-planted.sh: plant editor or team, not $which" >&2
    exit 2
    ;;
esac
if cmp -s sync-config.yaml "$planted"; then
  echo "verify-planted.sh: the $which query was not found in sync-config.yaml" >&2
  exit 1
fi

log=$(mktemp)
trap 'rm -f "$log" "$planted"' EXIT
set +e
pnpm exec samesight-verify audit --sync-config "$planted" --runs 3 --time-limit 60 --seed 7 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e
if [ "$code" -eq 0 ]; then
  echo "verify-planted.sh: the audit passed on the planted sync config" >&2
  exit 1
fi
if ! grep -qE "$caught" "$log"; then
  echo "verify-planted.sh: the audit failed, but not on the planted $which leak" >&2
  exit 1
fi
echo "The audit caught the planted $which leak."
