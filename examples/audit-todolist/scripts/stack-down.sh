#!/usr/bin/env bash
# Stops the to-do list demo's Supabase stack. Data volumes are kept.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -d upstream/supabase ]; then pnpm exec supabase --workdir upstream stop; fi
