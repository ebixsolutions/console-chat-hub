#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
fail(){ echo "PR27 KB AGGREGATION GATE: FAIL — $1" >&2; exit 1; }

FILES=(
  "supabase/functions/_shared/kb-aggregation-response.ts"
  "supabase/functions/_shared/kb-client.ts"
  "tests/edge/pr27-kb-aggregation-response.test.ts"
  "tests/sql/pr27_kb_aggregation_contract_test.py"
)
for f in "${FILES[@]}"; do [ -s "$ROOT/$f" ] || fail "$f missing/empty"; done

python3 "$ROOT/tests/sql/pr27_kb_aggregation_contract_test.py" "$ROOT"

if command -v deno >/dev/null 2>&1; then
  DENO=(deno)
elif command -v npx >/dev/null 2>&1; then
  DENO=(npx --yes deno)
else
  fail "deno/npx unavailable"
fi

(
  cd "$ROOT"
  "${DENO[@]}" test --node-modules-dir=none tests/edge/pr27-kb-aggregation-response.test.ts
  "${DENO[@]}" check --node-modules-dir=none supabase/functions/_shared/kb-aggregation-response.ts
  "${DENO[@]}" check --node-modules-dir=none supabase/functions/_shared/kb-client.ts
)

echo "PR27 KB AGGREGATION GATE: PASS"
