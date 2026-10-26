#!/usr/bin/env bash
# Fetches PowerSync's Supabase to-do list demo (CC0 1.0) at a pinned commit into upstream/
# (gitignored): its RLS migration, sync config and Supabase config, nothing else, checked
# against the hashes below. Only the Supabase config is then adjusted for this machine:
# its ports move from 5432x to 5532x (so it runs beside Fieldbook) and Auth gets an ES256
# signing key, which PowerSync verifies tokens with. The policies and the sync config are
# audited exactly as published.
set -euo pipefail
cd "$(dirname "$0")/.."

commit=d6a9cb48992b6682b11eef61c76b88fadce7a3a0
base="https://raw.githubusercontent.com/powersync-ja/powersync-js/${commit}/demos/react-supabase-todolist"
files=(
  "6d489af6292662d9e36d34ce49423784984a5f6e41d7b58f49b01264df59fa03 LICENSE"
  "cdb4c5da98be9618f80f0ce2a7e0f13ddc277647af523d9b933b7762080604cd sync-config.yaml"
  "2e49adbb65024bf4be5171a044b062749bee98f1dc06c55fa8fd53e9211b5422 supabase/config.toml"
  "97710667bcaeed2b9b4a087ef4f13fa4e6f3b34e3832cc7d202e526994dac9ce supabase/migrations/20250121000000_configure_powersync.sql"
)

rm -rf upstream.tmp && mkdir upstream.tmp
# Whatever fails below, the half-built copy (and the signing key copied into it) goes.
trap 'rm -rf upstream.tmp' EXIT
for entry in "${files[@]}"; do
  sum=${entry%% *}
  path=${entry#* }
  mkdir -p "upstream.tmp/$(dirname "$path")"
  curl -fsSL --retry 3 "$base/$path" -o "upstream.tmp/$path"
  actual=$(sha256sum "upstream.tmp/$path" | cut -d' ' -f1 | tr -d '*')
  if [ "$actual" != "$sum" ]; then
    echo "fetch.sh: $path does not match its pinned hash ($actual)" >&2
    rm -rf upstream.tmp
    exit 1
  fi
done

config=upstream.tmp/supabase/config.toml
sed -i -E 's/^(port|shadow_port|vector_port) = 543([0-9]{2})$/\1 = 553\2/' "$config"
sed -i -E 's/^(\[auth\])$/\1\nsigning_keys_path = ".\/signing_keys.json"/' "$config"
grep -q '^signing_keys_path' "$config" || { echo "fetch.sh: could not add the signing key to config.toml" >&2; exit 1; }
if grep -qE '^(port|shadow_port|vector_port) = 543' "$config"; then
  echo "fetch.sh: config.toml still uses a 543xx port" >&2
  exit 1
fi

# Keep an existing signing key, so tokens stay valid across a re-fetch.
if [ -s upstream/supabase/signing_keys.json ]; then cp upstream/supabase/signing_keys.json upstream.tmp/supabase/; fi
echo "$commit" > upstream.tmp/.commit
rm -rf upstream && mv upstream.tmp upstream
echo "Fetched the to-do list demo at ${commit:0:7} into upstream/."
