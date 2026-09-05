#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MIG2="supabase/migrations/20260905143500_hf3_handoff_precedence_closure.sql"
test -s "$MIG2" || { echo "HF3_PRECEDENCE_MIGRATION=FAIL"; exit 1; }
grep -q "WHEN 'E2' THEN 1" "$MIG2"
grep -q "WHEN 'R1' THEN 3" "$MIG2"
grep -q "WHEN 'R2' THEN 5" "$MIG2"
echo "HF3_PRECEDENCE_SOURCE_ASSERTIONS=PASS"
TMP="scripts/.hf3-director-final-gate.generated.sh"
trap 'rm -f "$TMP"' EXIT
python3 - <<'PY'
from pathlib import Path
src=Path('scripts/hf3-source-final-gate.sh').read_text()
src=src.replace(" co uuid:='40000000-0000-4000-8000-000000000001';\n r jsonb; n int;",
                " co uuid:='40000000-0000-4000-8000-000000000001';\n r jsonb; b boolean; cls text; n int;")
repls={
" SELECT training_candidate INTO r FROM hf3_learning_case WHERE evaluation_id=e1;\n IF r::boolean IS DISTINCT FROM true THEN":" SELECT training_candidate INTO b FROM hf3_learning_case WHERE evaluation_id=e1;\n IF b IS DISTINCT FROM true THEN",
" SELECT handoff_classification INTO r FROM hf3_learning_case WHERE evaluation_id=e1;\n IF trim(both '\"' from r::text) <> 'potentially_avoidable' THEN":" SELECT handoff_classification INTO cls FROM hf3_learning_case WHERE evaluation_id=e1;\n IF cls <> 'potentially_avoidable' THEN",
" SELECT handoff_classification INTO r FROM hf3_learning_case WHERE evaluation_id=e1;\n IF trim(both '\"' from r::text) <> 'unavoidable' THEN":" SELECT handoff_classification INTO cls FROM hf3_learning_case WHERE evaluation_id=e1;\n IF cls <> 'unavoidable' THEN",
" SELECT training_candidate INTO r FROM hf3_learning_case WHERE evaluation_id=e2;\n IF r::boolean IS DISTINCT FROM false THEN":" SELECT training_candidate INTO b FROM hf3_learning_case WHERE evaluation_id=e2;\n IF b IS DISTINCT FROM false THEN",
" SELECT training_candidate INTO r FROM hf3_learning_case WHERE evaluation_id=e3;\n IF r::boolean IS DISTINCT FROM true THEN":" SELECT training_candidate INTO b FROM hf3_learning_case WHERE evaluation_id=e3;\n IF b IS DISTINCT FROM true THEN",
}
for old,new in repls.items():
    assert old in src, old
    src=src.replace(old,new)
assert "r jsonb; b boolean; cls text; n int;" in src
assert "INTO r FROM hf3_learning_case" not in src
old='psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres -d hf3 -f "$MIG" >/tmp/hf3-migration.log'
assert old in src
src=src.replace(old, old + '\npsql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres -d hf3 -f "supabase/migrations/20260905143500_hf3_handoff_precedence_closure.sql" >>/tmp/hf3-migration.log')
old='deno check "$WORKER" "$RECEIVER" >/dev/null'
assert old in src
src=src.replace(old, 'deno check --node-modules-dir=auto "$WORKER" "$RECEIVER" >/dev/null')
Path('scripts/.hf3-director-final-gate.generated.sh').write_text(src)
PY
bash "$TMP"
