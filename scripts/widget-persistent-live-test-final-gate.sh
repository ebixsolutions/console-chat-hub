#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
fail(){ echo "WIDGET PERSISTENT LIVE TEST FINAL GATE: FAIL — $1" >&2; exit 1; }

FILES=(
  "src/routes/_authenticated/console.widget-preview.tsx"
  "supabase/functions/widget-live-ai-test/index.ts"
  "tests/edge/widget-persistent-live-test-contract.py"
)
for f in "${FILES[@]}"; do
  [ -s "$ROOT/$f" ] || fail "$f missing/empty"
done

python3 "$ROOT/tests/edge/widget-persistent-live-test-contract.py" "$ROOT"

if command -v deno >/dev/null 2>&1; then
  DENO=(deno)
elif command -v npx >/dev/null 2>&1; then
  DENO=(npx --yes deno)
else
  fail "deno/npx unavailable"
fi

(
  cd "$ROOT"
  "${DENO[@]}" check --node-modules-dir=none supabase/functions/widget-live-ai-test/index.ts
)

if command -v npx >/dev/null 2>&1; then
  (
    cd "$ROOT"
    npx tsc --noEmit --pretty false
  )
else
  fail "npx unavailable"
fi

echo "WIDGET PERSISTENT LIVE TEST FINAL GATE: PASS"
