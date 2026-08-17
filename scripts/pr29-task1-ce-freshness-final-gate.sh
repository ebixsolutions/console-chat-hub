#!/bin/bash
set -Eeuo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
MIG="$ROOT/sql/pr29/pr29_ce_evaluation_freshness_queue.sql"
RB="$ROOT/sql/pr29/pr29_ce_evaluation_freshness_queue.rollback.sql"
TEST="$ROOT/tests/sql/pr29_task1_contract_test.py"

fail(){ echo "PR29 TASK1 FINAL GATE: FAIL — $1" >&2; exit 1; }

[ -s "$MIG" ] || fail "migration missing/empty"
[ -s "$RB" ] || fail "rollback missing/empty"
[ -s "$TEST" ] || fail "contract test missing/empty"

python3 "$TEST" "$ROOT"

python3 - "$MIG" "$RB" <<'PY'
from pathlib import Path
import sys, re

for p in map(Path, sys.argv[1:]):
    s=p.read_text()
    assert s.count("BEGIN;") == 1, f"{p}: exactly one BEGIN required"
    assert s.count("COMMIT;") == 1, f"{p}: exactly one COMMIT required"
    assert "SET LOCAL lock_timeout" in s
    assert "SET LOCAL statement_timeout" in s

m=Path(sys.argv[1]).read_text()
assert "CREATE TABLE IF NOT EXISTS public.ce_evaluation_job" in m
assert "CREATE OR REPLACE FUNCTION public.ce_enqueue_evaluation_v1" in m
assert "CREATE OR REPLACE FUNCTION public.ce_finalize_evaluation_freshness_v1" in m
assert "extensions.digest" in m
assert "p_mark_existing_stale boolean DEFAULT false" in m
assert "DROP TRIGGER IF EXISTS trg_ce_message_evaluation_dirty" in m
print("PASS transaction/source assertions")
PY

echo "PR29 TASK1 FINAL GATE: PASS"
