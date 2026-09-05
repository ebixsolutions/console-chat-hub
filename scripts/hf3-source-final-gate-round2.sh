#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SRC="scripts/hf3-source-final-gate.sh"
TMP="scripts/.hf3-source-final-gate-round2.generated.sh"
trap 'rm -f "$TMP"' EXIT
python3 - <<'PY'
from pathlib import Path
src=Path('scripts/hf3-source-final-gate.sh').read_text()
src=src.replace("  co uuid:='40000000-0000-4000-8000-000000000001';\n r jsonb; n int;",
                "  co uuid:='40000000-0000-4000-8000-000000000001';\n r jsonb; b boolean; cls text; n int;")
src=src.replace(" SELECT training_candidate INTO r FROM hf3_learning_case WHERE evaluation_id=e1;\n IF r::boolean IS DISTINCT FROM true THEN",
                " SELECT training_candidate INTO b FROM hf3_learning_case WHERE evaluation_id=e1;\n IF b IS DISTINCT FROM true THEN")
src=src.replace(" SELECT handoff_classification INTO r FROM hf3_learning_case WHERE evaluation_id=e1;\n IF trim(both '\"' from r::text) <> 'potentially_avoidable' THEN",
                " SELECT handoff_classification INTO cls FROM hf3_learning_case WHERE evaluation_id=e1;\n IF cls <> 'potentially_avoidable' THEN")
src=src.replace(" SELECT handoff_classification INTO r FROM hf3_learning_case WHERE evaluation_id=e1;\n IF trim(both '\"' from r::text) <> 'unavoidable' THEN",
                " SELECT handoff_classification INTO cls FROM hf3_learning_case WHERE evaluation_id=e1;\n IF cls <> 'unavoidable' THEN")
src=src.replace(" SELECT training_candidate INTO r FROM hf3_learning_case WHERE evaluation_id=e2;\n IF r::boolean IS DISTINCT FROM false THEN",
                " SELECT training_candidate INTO b FROM hf3_learning_case WHERE evaluation_id=e2;\n IF b IS DISTINCT FROM false THEN")
src=src.replace(" SELECT training_candidate INTO r FROM hf3_learning_case WHERE evaluation_id=e3;\n IF r::boolean IS DISTINCT FROM true THEN",
                " SELECT training_candidate INTO b FROM hf3_learning_case WHERE evaluation_id=e3;\n IF b IS DISTINCT FROM true THEN")
assert "INTO r FROM hf3_learning_case" not in src
Path('scripts/.hf3-source-final-gate-round2.generated.sh').write_text(src)
PY
bash "$TMP"
