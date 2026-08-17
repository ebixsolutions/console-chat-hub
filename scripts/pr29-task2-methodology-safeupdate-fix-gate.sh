#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
SQL="$ROOT/sql/pr29/pr29_task2_methodology_safeupdate_fix.sql"
RB="$ROOT/sql/pr29/pr29_task2_methodology_safeupdate_fix.rollback.sql"
TEST="$ROOT/tests/sql/pr29_task2_methodology_safeupdate_fix_test.py"
fail(){ echo "PR29 SAFEUPDATE FIX GATE: FAIL — $1" >&2; exit 1; }
[ -s "$SQL" ] || fail "fix SQL missing"
[ -s "$RB" ] || fail "rollback note missing"
[ -s "$TEST" ] || fail "test missing"
python3 "$TEST" "$ROOT"
python3 - "$SQL" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
assert s.count("BEGIN;")==1
assert s.count("COMMIT;")==1
assert "SET LOCAL lock_timeout" in s
assert "SET LOCAL statement_timeout" in s
assert "WHERE s.current_evaluation_fingerprint IS DISTINCT FROM v_fingerprint;" in s
print("PASS transaction/source assertions")
PY
echo "PR29 SAFEUPDATE FIX GATE: PASS"
