#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
fail(){ echo "WIDGET PREVIEW LIVE AI WIRING FINAL GATE: FAIL — $1" >&2; exit 1; }

FILES=(
  "src/routes/_authenticated/console.widget-preview.tsx"
  "tests/edge/widget-preview-live-ai-wiring-contract.py"
)
for f in "${FILES[@]}"; do
  [ -s "$ROOT/$f" ] || fail "$f missing/empty"
done

python3 "$ROOT/tests/edge/widget-preview-live-ai-wiring-contract.py" "$ROOT"

if command -v npx >/dev/null 2>&1; then
  (
    cd "$ROOT"
    npx tsc --noEmit --pretty false
  )
else
  fail "npx unavailable"
fi

echo "WIDGET PREVIEW LIVE AI WIRING FINAL GATE: PASS"
