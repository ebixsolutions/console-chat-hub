#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
fail(){ echo "WIDGET PRODUCTION LLM ROUTER FINAL GATE: FAIL — $1" >&2; exit 1; }

FILES=(
  "supabase/functions/generate-reply/index.ts"
  "supabase/functions/_shared/escalation-policy.ts"
  "tests/edge/widget-production-llm-router-alignment-contract.py"
)
for f in "${FILES[@]}"; do [ -s "$ROOT/$f" ] || fail "$f missing/empty"; done

python3 "$ROOT/tests/edge/widget-production-llm-router-alignment-contract.py" "$ROOT"

# TypeScript parser check even before Deno dependency resolution.
(
  cd "$ROOT"
  npx tsc --noEmit --pretty false
)

if command -v deno >/dev/null 2>&1; then DENO=(deno); elif command -v npx >/dev/null 2>&1; then DENO=(npx --yes deno); else fail "deno/npx unavailable"; fi
(
 cd "$ROOT"
 "${DENO[@]}" check --node-modules-dir=none supabase/functions/generate-reply/index.ts
 "${DENO[@]}" check --node-modules-dir=none supabase/functions/_shared/escalation-policy.ts
)

echo "WIDGET PRODUCTION LLM ROUTER FINAL GATE: PASS"
