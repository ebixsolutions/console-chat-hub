#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
SQL="$ROOT/sql/pr29/pr29_task2_scheduler_cutoff_revive_fix.sql"
RB="$ROOT/sql/pr29/pr29_task2_scheduler_cutoff_revive_fix.rollback.sql"
TEST="$ROOT/tests/sql/pr29_task2_scheduler_cutoff_revive_fix_test.py"
fail(){ echo "PR29 TASK2 CUTOFF GATE: FAIL — $1" >&2; exit 1; }

[ -s "$SQL" ] || fail "fix SQL missing/empty"
[ -s "$RB" ] || fail "rollback missing/empty"
[ -s "$TEST" ] || fail "test missing/empty"

python3 "$TEST" "$ROOT"

python3 - "$SQL" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
assert s.count("BEGIN;")==1
assert s.count("COMMIT;")==1
assert "automation_started_at" in s
assert "COALESCE(s.dirty_since,s.last_activity_at) >= v_cfg.automation_started_at" in s
assert "v_job.status IN ('cancelled','failed')" in s
assert "p_source IN (" in s
print("PASS transaction/source assertions")
PY

echo "PR29 TASK2 CUTOFF GATE: PASS"
