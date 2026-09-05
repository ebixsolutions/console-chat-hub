#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
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
old='deno check "$WORKER" "$RECEIVER" >/dev/null'
assert old in src
src=src.replace(old, 'deno check --node-modules-dir=auto "$WORKER" "$RECEIVER" >/dev/null')
Path('scripts/.hf3-director-final-gate.generated.sh').write_text(src)
PY
bash "$TMP"
