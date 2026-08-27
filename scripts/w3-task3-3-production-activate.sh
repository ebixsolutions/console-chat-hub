#!/bin/bash
set -Eeuo pipefail
REPO="${W3_T3_3_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
AUTH="${W3_T3_3_PRODUCTION_AUTHORIZED:-}"
PROJECT_REF="${W3_T3_3_PROJECT_REF:-}"
EXPECTED_REF="hvmtoqiwdqvgnjepxwrc"
CFG="$REPO/config/w3-task3-3-dev-identity.env"
stop(){ echo "STOP: $1" >&2; exit 2; }

# Auto-load the Director-owned DEV config when it exists.
# Do NOT require W3_T3_3_DEV_CONFIG to be pre-exported in a fresh shell.
if [ -s "$CFG" ]; then
  # shellcheck disable=SC1090
  source "$CFG"
  PROJECT_REF="${W3_T3_3_PROJECT_REF:-}"
fi

[ "${W3_T3_3_DEV_CONFIG:-}" = "YES" ] || stop "Director DEV configuration not active"
[ "$AUTH" = "YES" ] || stop "explicit final production activation authorization missing"
[ "$PROJECT_REF" = "$EXPECTED_REF" ] || stop "project ref mismatch"
[ -d "$REPO/.git" ] || stop "repo missing"
[ "$(git -C "$REPO" branch --show-current)" = main ] || stop "branch must be main"
[ -z "$(git -C "$REPO" status --porcelain)" ] || stop "working tree must be clean"
cd "$REPO"

# PHASE A — source/build/security gates before the first write.
bash scripts/w3-task3-1-product-surface-final-gate.sh "$REPO"
python3 tests/edge/w3-task3-2-security-source-contract.py "$REPO"
python3 tests/edge/w3-task3-2-runtime-fixture-config-contract.py "$REPO"
python3 tests/edge/w3-task3-2-dev-tenant-b-fixture-contract.py "$REPO"
bash scripts/pr10-two-tenant-security-source-gate.sh
bash scripts/pr10-cross-tenant-edge-api-source-gate.sh
bash scripts/pr10-cross-tenant-mutation-write-source-gate.sh
bash scripts/pr7-production-atomic-rollback-source-gate.sh
npm run build

# PHASE B — canonical Tenant 1 identity and legacy canonicalization.
export W2_T2_1_PRODUCTION_AUTHORIZED=YES
export W2_T2_1_RUN_PRODUCTION=true
bash scripts/w2-task2-1-final-gate.sh

export W2_T2_2_PRODUCTION_AUTHORIZED=YES
export W2_T2_2_RUN_PRODUCTION=true
bash scripts/w2-task2-2-final-gate.sh

# PHASE C — isolated Tenant B DEV security fixture only after Task 2.2.
export W3_DEV_FIXTURE_WRITE_AUTHORIZED=YES
bash scripts/w3-task3-2-dev-tenant-b-fixture-bootstrap.sh

# PHASE D — learning loop + runtime closure.
export W2_T2_3_PRODUCTION_AUTHORIZED=YES
export W2_T2_3_RUN_PRODUCTION=true
export W2_T2_3_PROJECT_REF="$PROJECT_REF"
bash scripts/w2-task2-3-final-gate.sh

export W1_RUN_PRODUCTION_SMOKE=true
bash scripts/w1-task1-3-final-gate.sh

bash scripts/w3-task3-2-runtime-fixture-config-gate.sh

export W3_T3_2_RUN_PRODUCTION=true
bash scripts/w3-task3-2-security-final-gate.sh

echo "W3 TASK 3.3 ACTIVATION SEQUENCE: PASS"
