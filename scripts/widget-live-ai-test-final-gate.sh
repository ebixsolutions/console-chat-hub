#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
fail(){ echo "WIDGET LIVE AI TEST FINAL GATE: FAIL — $1" >&2; exit 1; }

FILES=(
  "src/components/console/WidgetLiveAiTest.tsx"
  "src/routes/_authenticated/console.$.tsx"
  "supabase/functions/widget-live-ai-test/index.ts"
  "supabase/config.toml"
  "tests/edge/widget-live-ai-test-contract.py"
)
for f in "${FILES[@]}"; do
  [ -s "$ROOT/$f" ] || fail "$f missing/empty"
done

python3 "$ROOT/tests/edge/widget-live-ai-test-contract.py" "$ROOT"

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

echo "WIDGET LIVE AI TEST FINAL GATE: PASS"
