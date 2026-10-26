#!/usr/bin/env bash
# Stops the to-do list demo's stack. Data volumes are kept.
set -euo pipefail
cd "$(dirname "$0")/.."
PS_STORAGE_PASSWORD=${PS_STORAGE_PASSWORD:-unused} PS_REPLICATION_PASSWORD=${PS_REPLICATION_PASSWORD:-unused} \
  docker compose down
if [ -d upstream/supabase ]; then pnpm exec supabase --workdir upstream stop; fi
