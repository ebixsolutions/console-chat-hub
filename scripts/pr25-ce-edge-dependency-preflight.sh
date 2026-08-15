#!/bin/bash
set -Eeuo pipefail

DENO_VERSION="2.9.4"
TARGET="supabase/functions/conversation-evaluate/index.ts"

run_deno() {
  if command -v deno >/dev/null 2>&1; then
    deno "$@"
  else
    command -v npx >/dev/null 2>&1 || return 127
    npx --yes "deno@$DENO_VERSION" "$@"
  fi
}

[ -s "$TARGET" ] || { echo "FAIL missing $TARGET"; exit 1; }

# Resolve npm: dependencies through Deno's global cache, not the repo's
# package.json/manual node_modules directory.
run_deno info --node-modules-dir=none "$TARGET" >/tmp/pr25-deno-info.txt
grep -Fq 'npm:@supabase/supabase-js@2.45.0' "$TARGET"
echo "PASS Deno global-cache dependency preflight"
