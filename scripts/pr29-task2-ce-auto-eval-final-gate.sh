#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
fail(){ echo "PR29 TASK2 FINAL GATE: FAIL — $1" >&2; exit 1; }

need(){
  [ -s "$ROOT/$1" ] || fail "$1 missing/empty"
}

need sql/pr29/pr29_ce_auto_evaluation_runtime.sql
need sql/pr29/pr29_ce_auto_evaluation_runtime.rollback.sql
need supabase/functions/_shared/ce-automation-engine.ts
need supabase/functions/_shared/ce-grounding.ts
need supabase/functions/ce-evaluation-control/index.ts
need supabase/functions/ce-evaluation-worker/index.ts
need src/routes/_authenticated/console.conversation-evaluation.index.tsx
need tests/edge/pr29-task2-automation.test.ts
need tests/sql/pr29_task2_contract_test.py

python3 "$ROOT/tests/sql/pr29_task2_contract_test.py" "$ROOT"

python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
r=Path(sys.argv[1])
route=(r/"src/routes/_authenticated/console.conversation-evaluation.index.tsx").read_text()
engine=(r/"supabase/functions/_shared/ce-automation-engine.ts").read_text()
grounding=(r/"supabase/functions/_shared/ce-grounding.ts").read_text()
worker=(r/"supabase/functions/ce-evaluation-worker/index.ts").read_text()
control=(r/"supabase/functions/ce-evaluation-control/index.ts").read_text()
assert "const DWELL_MS = 3000" in route
assert 'key={`${selected}:${detailReloadKey}`}' in route
assert '"ce-evaluation-control"' in route
assert '"dirty","failed","stale_version"' in route
assert "callModel({" in engine
assert 'responseFormat: "json"' in engine
assert "DIMENSION_WEIGHT" in engine
assert "const canonicalCompanyId = companyId" in engine
assert 'detail: "ai_company_unresolved"' in grounding
assert "ensureCurrentMethodology" in worker
assert "ce_verify_worker_token_v1" in worker
assert "authorized(admin" in control
assert "company_id" not in route.split('body: { conversation_id: conversationId, source }')[0][-100:]
print("PASS source assertions")
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
  # google-auth-library reads GOOGLE_SDK_NODE_LOGGING during module initialization.
  # Grant only that env read to this deterministic test; no network/write/run permission.
  "${DENO[@]}" test --allow-env=GOOGLE_SDK_NODE_LOGGING --node-modules-dir=none tests/edge/pr29-task2-automation.test.ts
  "${DENO[@]}" check --node-modules-dir=none supabase/functions/ce-evaluation-control/index.ts
  "${DENO[@]}" check --node-modules-dir=none supabase/functions/ce-evaluation-worker/index.ts
)

echo "PR29 TASK2 FINAL GATE: PASS"
