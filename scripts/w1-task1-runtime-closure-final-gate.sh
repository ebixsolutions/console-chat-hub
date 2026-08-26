#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

python3 "$ROOT/tests/edge/w1-task1-runtime-closure-contract.py"
python3 "$ROOT/tests/sql/w1-task1-runtime-closure-sql-contract.py"

python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
r=Path(sys.argv[1])
required=[
"src/components/console/CRMPanel.tsx",
"supabase/functions/_shared/kb-client.ts",
"supabase/functions/widget-live-ai-test/index.ts",
"supabase/migrations/20260826090000_widget_live_test_runtime_closure.sql",
"supabase/migrations/rollback/20260826090000_widget_live_test_runtime_closure.rollback.sql",
"tests/edge/w1-task1-runtime-closure-contract.py",
"tests/sql/w1-task1-runtime-closure-sql-contract.py",
]
missing=[x for x in required if not (r/x).is_file()]
empty=[x for x in required if (r/x).is_file() and (r/x).stat().st_size==0]
assert not missing, missing
assert not empty, empty
print("PASS expected files exist; missing=0 empty=0")
PY

echo "W1 TASK 1.1 FINAL SOURCE GATE: PASS"
