#!/usr/bin/env bash
# Runs an example's audit and fails unless it passes and its Coverage summary matches the
# pattern given: a later change that leaves rules untested shows up here, not only as warnings.
#
#   scripts/ci/verify-coverage.sh <example dir> <summary pattern (grep -E)> [audit arguments...]
set -euo pipefail
# Plain output to grep, whatever FORCE_COLOR the runner sets.
export NO_COLOR=1

dir="${1:?usage: verify-coverage.sh <example dir> <summary pattern> [audit arguments...]}"
pattern="${2:?usage: verify-coverage.sh <example dir> <summary pattern> [audit arguments...]}"
shift 2
cd "$dir"

log=$(mktemp)
trap 'rm -f "$log"' EXIT
set +e
pnpm exec samesight-verify audit "$@" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
set -e
if [ "$code" -ne 0 ]; then
  echo "verify-coverage.sh: the audit failed (exit $code)" >&2
  exit "$code"
fi
if ! grep -qE "^ok +coverage: $pattern" "$log"; then
  echo "verify-coverage.sh: the Coverage summary does not match: $pattern" >&2
  exit 1
fi
echo "Coverage is as expected."
