#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
TEST="$ROOT/tests/edge/pr27-kb-company-api-key.test.ts"
fail(){ echo "PR27 KB COMPANY API KEY GATE: FAIL — $1" >&2; exit 1; }

FILES=(
  "supabase/functions/_shared/kb-auth.ts"
  "supabase/functions/_shared/kb-client.ts"
  "tests/edge/pr27-kb-company-api-key.test.ts"
  "tests/sql/pr27_kb_company_api_key_contract_test.py"
)

for f in "${FILES[@]}"; do
  [ -s "$ROOT/$f" ] || fail "$f missing/empty"
done

python3 "$ROOT/tests/sql/pr27_kb_company_api_key_contract_test.py" "$ROOT"

python3 - "$TEST" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
assert '"valid-looking-key-but\\nnewline"' in s
assert '"valid-looking-key-but\\\\nnewline"' not in s
print("PASS control-character test fixture")
PY

if command -v deno >/dev/null 2>&1; then
  DENO=(deno)
elif command -v npx >/dev/null 2>&1; then
  DENO=(npx --yes deno)
else
  fail "deno/npx unavailable"
fi

(
  cd "$ROOT"
  "${DENO[@]}" test --node-modules-dir=none tests/edge/pr27-kb-company-api-key.test.ts
  "${DENO[@]}" check --node-modules-dir=none supabase/functions/_shared/kb-auth.ts
  "${DENO[@]}" check --node-modules-dir=none supabase/functions/_shared/kb-client.ts
)

echo "PR27 KB COMPANY API KEY GATE: PASS"
