#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
CORS="$ROOT/supabase/functions/_shared/ce-cors.ts"
TEST="$ROOT/tests/edge/pr29-task2-ce-control-cors-headers.test.ts"
fail(){ echo "PR29 CE CORS HEADERS GATE: FAIL — $1" >&2; exit 1; }

[ -s "$CORS" ] || fail "CORS helper missing/empty"
[ -s "$TEST" ] || fail "test missing/empty"

python3 - "$CORS" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
for token in [
    '"authorization"',
    '"apikey"',
    '"content-type"',
    '"x-client-info"',
    '"x-supabase-api-version"',
    'resolveCeAllowedHeaders',
    'Vary: "Origin, Access-Control-Request-Headers"',
]:
    assert token in s, token
assert '"Access-Control-Allow-Origin": "*"' not in s
assert '"x-evil-header"' not in s
print("PASS CORS header allowlist assertions")
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
  "${DENO[@]}" test --node-modules-dir=none tests/edge/pr29-task2-ce-control-cors-headers.test.ts
  "${DENO[@]}" check --node-modules-dir=none supabase/functions/_shared/ce-cors.ts
)

echo "PR29 CE CORS HEADERS GATE: PASS"
