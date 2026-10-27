#!/usr/bin/env bash
# Stops the example's Supabase stack. Data volumes are kept.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm exec supabase stop
