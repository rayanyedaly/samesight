#!/usr/bin/env bash
# Stops Fieldbook's local stack. Data volumes are kept; `supabase db reset` and
# `docker compose down -v` clear them.
set -euo pipefail
cd "$(dirname "$0")/.."
# Compose resolves the required passwords even for `down`; any value works here, so a
# missing .env cannot leave Supabase running.
PS_STORAGE_PASSWORD=${PS_STORAGE_PASSWORD:-unused} PS_REPLICATION_PASSWORD=${PS_REPLICATION_PASSWORD:-unused} \
  docker compose down
pnpm exec supabase stop
