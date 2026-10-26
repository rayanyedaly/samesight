#!/usr/bin/env bash
# Stops the quickstart's PowerSync service and Supabase, keeping the data.
set -euo pipefail
cd "$(dirname "$0")/.."
PS_STORAGE_PASSWORD=${PS_STORAGE_PASSWORD:-unused} PS_REPLICATION_PASSWORD=${PS_REPLICATION_PASSWORD:-unused} \
  docker compose down
pnpm exec supabase stop
