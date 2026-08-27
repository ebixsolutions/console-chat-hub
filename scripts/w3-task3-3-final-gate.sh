#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

python3 tests/edge/w3-task3-3-source-contract.py "$ROOT"
python3 tests/edge/w3-task3-3-consolidated-closure-contract.py "$ROOT"

for f in \
  scripts/w2-task2-1-final-gate.sh \
  scripts/w2-task2-2-final-gate.sh \
  scripts/w2-task2-3-final-gate.sh \
  scripts/w1-task1-2-kb-contract-final-gate.sh \
  scripts/w1-task1-3-final-gate.sh \
  scripts/w3-task3-1-product-surface-final-gate.sh \
  scripts/w3-task3-2-security-final-gate.sh \
  scripts/w3-task3-3-runtime-inputs-load.sh \
  config/w3-task3-3-dev-identity.env
do
  test -s "$f" || { echo "FAIL missing/empty final-gate dependency: $f" >&2; exit 1; }
done

npm run build

if [ "${W3_T3_3_RUN_PRODUCTION:-false}" != true ]; then
  echo "STOP: W3 Task 3.3 source/build complete; explicit final production authorization required" >&2
  exit 2
fi

# IMPORTANT: production-activate runs as a child shell. Any config/runtime vars it
# sources there do NOT propagate back to this final-gate shell. Load the same
# frozen non-secret DEV config and runtime bridge here before activation, so the
# subsequent whole-product smoke sees the exact same project/deploy state.
source "$ROOT/config/w3-task3-3-dev-identity.env"
source "$ROOT/scripts/w3-task3-3-runtime-inputs-load.sh"

[ "${W3_T3_3_PROJECT_REF:-}" = "hvmtoqiwdqvgnjepxwrc" ] || {
  echo "STOP: final-gate project ref mismatch" >&2
  exit 2
}
[ "${W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED:-}" = "YES" ] || {
  echo "STOP: final-gate Lovable-native deployment confirmation missing" >&2
  exit 2
}

bash scripts/w3-task3-3-production-activate.sh

# These are intentionally checked in the parent shell after activation. They
# must remain available for the whole-product smoke regardless of child-shell
# environment scope.
[ "${W3_T3_3_PROJECT_REF:-}" = "hvmtoqiwdqvgnjepxwrc" ] || {
  echo "FAIL: final-gate project ref lost before whole-product smoke" >&2
  exit 1
}
[ "${W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED:-}" = "YES" ] || {
  echo "FAIL: deployment confirmation lost before whole-product smoke" >&2
  exit 1
}

bash scripts/w3-task3-3-whole-product-smoke.sh

echo "W3 TASK 3.3 FINAL STATUS: READY"
