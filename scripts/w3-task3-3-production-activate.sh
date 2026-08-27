#!/bin/bash
set -Eeuo pipefail
REPO="${W3_T3_3_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
AUTH="${W3_T3_3_PRODUCTION_AUTHORIZED:-}"
PROJECT_REF="${W3_T3_3_PROJECT_REF:-}"
EXPECTED_REF="hvmtoqiwdqvgnjepxwrc"
stop(){ echo "STOP: $1" >&2; exit 2; }
[ "$AUTH" = "YES" ] || stop "explicit final production activation authorization missing"
[ "$PROJECT_REF" = "$EXPECTED_REF" ] || stop "project ref mismatch"
[ -d "$REPO/.git" ] || stop "repo missing"
[ "$(git -C "$REPO" branch --show-current)" = main ] || stop "branch must be main"
[ -z "$(git -C "$REPO" status --porcelain)" ] || stop "working tree must be clean"
cd "$REPO"

bash scripts/w3-task3-1-product-surface-final-gate.sh "$REPO"
python3 tests/edge/w3-task3-2-security-source-contract.py "$REPO"
bash scripts/pr10-two-tenant-security-source-gate.sh
bash scripts/pr10-cross-tenant-edge-api-source-gate.sh
bash scripts/pr10-cross-tenant-mutation-write-source-gate.sh
bash scripts/pr7-production-atomic-rollback-source-gate.sh
npm run build

export W2_T2_1_PRODUCTION_AUTHORIZED=YES
export W2_T2_1_RUN_PRODUCTION=true
bash scripts/w2-task2-1-final-gate.sh

export W2_T2_2_PRODUCTION_AUTHORIZED=YES
export W2_T2_2_RUN_PRODUCTION=true
bash scripts/w2-task2-2-final-gate.sh

export W2_T2_3_PRODUCTION_AUTHORIZED=YES
export W2_T2_3_RUN_PRODUCTION=true
export W2_T2_3_PROJECT_REF="$PROJECT_REF"
bash scripts/w2-task2-3-final-gate.sh

export W1_RUN_PRODUCTION_SMOKE=true
bash scripts/w1-task1-3-final-gate.sh

export W3_T3_2_RUN_PRODUCTION=true
bash scripts/w3-task3-2-security-final-gate.sh

echo "W3 TASK 3.3 ACTIVATION SEQUENCE: PASS"
