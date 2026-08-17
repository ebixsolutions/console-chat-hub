#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
SRC="$ROOT/supabase/functions/ce-evaluation-control/index.ts"
CORS="$ROOT/supabase/functions/_shared/ce-cors.ts"
TEST="$ROOT/tests/edge/pr29-task2-ce-control-cors.test.ts"
fail(){ echo "PR29 CE CONTROL CORS GATE: FAIL — $1" >&2; exit 1; }

[ -s "$SRC" ] || fail "source missing/empty"
[ -s "$CORS" ] || fail "CORS helper missing/empty"
[ -s "$TEST" ] || fail "test missing/empty"

python3 - "$SRC" "$CORS" <<'PY'
from pathlib import Path
import sys
src=Path(sys.argv[1]).read_text()
cors=Path(sys.argv[2]).read_text()

assert 'import { ceCorsHeaders } from "../_shared/ce-cors.ts";' in src
assert 'return ceCorsHeaders(req.headers.get("Origin") ?? "");' in src

required=[
  'const PROJECT_ID = "4dbf593e-577e-4af4-a553-460441c34473"',
  'const PROJECT_PREVIEW_HOST = `${PROJECT_ID}.lovable.app`',
  'host.endsWith(`--${PROJECT_PREVIEW_HOST}`)',
  'origin === ALLOWED_ORIGIN',
  '"Access-Control-Allow-Origin": allow',
  'Vary: "Origin"',
]
for x in required:
    assert x in cors, x
assert 'hostname.endsWith(".lovable.app")' not in cors
assert 'Access-Control-Allow-Origin": "*"' not in cors
assert "Deno.serve" not in cors
print("PASS pure CORS helper/source assertions")
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
  "${DENO[@]}" test --node-modules-dir=none tests/edge/pr29-task2-ce-control-cors.test.ts
  "${DENO[@]}" check --node-modules-dir=none supabase/functions/_shared/ce-cors.ts
  "${DENO[@]}" check --node-modules-dir=none supabase/functions/ce-evaluation-control/index.ts
)

echo "PR29 CE CONTROL CORS GATE: PASS"
