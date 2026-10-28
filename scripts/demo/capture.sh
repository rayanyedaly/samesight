#!/usr/bin/env bash
# Captures audit catching the planted to-do list leak, as text and as two SVGs.
#
# It plants the leak the way examples/audit-todolist/scripts/verify-planted.sh does (the
# lists query loses its owner filter), audits the planted copy with a fixed seed, trims the
# output, writes docs/assets/audit-demo.txt and renders it with scripts/demo/render.mjs.
#
# Needs the demo's local stack, Supabase only (audit starts its own PowerSync), and Docker:
#
#   pnpm build:packages
#   pnpm --filter audit-todolist stack:up
#   bash scripts/demo/capture.sh
#   pnpm --filter audit-todolist stack:down
#
#   bash scripts/demo/capture.sh --trim <file>   trims a saved NO_COLOR run instead of running one
#
# It runs the built `samesight audit`, which forwards to the demo's @samesight/verify; the
# first line shows it as a user runs it, `npx samesight audit`, with the flags of the run.
# The replay line is printed by samesight-verify, so it names samesight-verify. Trimming,
# and nothing else:
#
#   - progress lines ("  19s  starting PowerSync ...") are dropped;
#   - run row ids (5a3e5a3e-xxxx-xxxx-xxxx-xxxxxxxxxxxx) are shortened to 5a3e5a3e-xxxx…;
#   - in a finding with several row blocks, only the first is kept, and the others become
#     one line naming how many were left out and their users; the replay line stays;
#   - the Coverage and Write path sections become one line saying they were left out;
#   - every other line, the summary line included, is kept as printed.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
demo="$root/examples/audit-todolist"
out="$root/docs/assets/audit-demo.txt"
planted=upstream/sync-config.planted.yaml
flags=(--project upstream --sync-config "$planted" --runs 3 --time-limit 60 --seed 1842)

trim() {
  sed -E 's/(5a3e5a3e-[0-9a-f]{4})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/\1…/g' |
    awk '
      # Blank lines are held back, so a dropped section takes its blank line with it.
      function emit(line) {
        if (blank) print ""
        blank = 0; print line
      }
      function flush_cut(   who, i) {
        for (i = 1; i <= cut; i++) who = who (i == 1 ? "" : i == cut ? " and " : ", ") users[i]
        if (cut) emit("    (" cut " more row block" (cut > 1 ? "s" : "") ", for " who ", left out of this capture)")
        cut = 0
      }
      /^  [0-9]+s  / { next }
      /^$/ { flush_cut(); blank = 1; skipping = 0; next }
      skipping { next }
      # A section title: unindented, after a blank line.
      blank && /^[A-Z]/ && !/^(ok|warn|FAIL) / && !/^(PASSED|FAILED|INCOMPLETE)/ {
        if ($0 ~ /^Coverage/ || $0 == "Write path") {
          skipping = 1
          if (!noted) emit("(Coverage and Write path sections left out of this capture)")
          noted = 1
          next
        }
      }
      # Row blocks: "    leak: u1 received ...", then lines indented further.
      /^    (leak|hidden|gap|unsent|differs): / {
        blocks++
        if (blocks > 1) {
          users[++cut] = $2
          inblock = 1
          next
        }
        inblock = 0
        emit($0); next
      }
      /^      replay / { flush_cut(); inblock = 0; emit($0); next }
      inblock && /^      / { next }
      { if (!/^ /) { flush_cut(); inblock = 0; blocks = 0 } emit($0) }
      END { flush_cut() }
    '
}

if [ "${1:-}" = "--trim" ]; then
  [ -f "${2:-}" ] || { echo "capture.sh: --trim needs a saved run" >&2; exit 2; }
  { echo "\$ npx samesight audit ${flags[*]}"; trim <"$2"; } >"$out"
  node "$root/scripts/demo/render.mjs"
  exit 0
fi

cd "$demo"
sed 's/^\( *- SELECT \* FROM lists\) WHERE owner_id = auth.user_id()$/\1/' upstream/sync-config.yaml >"$planted"
if cmp -s upstream/sync-config.yaml "$planted"; then
  echo "capture.sh: the lists query was not found; has the demo changed?" >&2
  exit 1
fi

raw=$(mktemp)
err=$(mktemp)
trap 'rm -f "$raw" "$err"' EXIT
# Plain text, whatever FORCE_COLOR the shell sets. Docker's pull progress goes to stderr.
set +e
NO_COLOR=1 node "$root/packages/samesight/dist/cli.js" audit "${flags[@]}" >"$raw" 2>"$err"
code=$?
set -e
if [ "$code" -ne 1 ] || ! grep -qE "^ *leak: u[0-9]+ .*received lists " "$raw"; then
  echo "capture.sh: the audit exited $code without the planted lists leak; nothing written" >&2
  cat "$raw" "$err" >&2
  exit 1
fi

{ echo "\$ npx samesight audit ${flags[*]}"; trim <"$raw"; } >"$out"
echo "wrote ${out#"$root"/}"
node "$root/scripts/demo/render.mjs"
