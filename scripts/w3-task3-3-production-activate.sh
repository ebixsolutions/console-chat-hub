#!/bin/bash
set -Eeuo pipefail
REPO="${W3_T3_3_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
AUTH="${W3_T3_3_PRODUCTION_AUTHORIZED:-}"
EXPECTED_REF="hvmtoqiwdqvgnjepxwrc"
CFG="$REPO/config/w3-task3-3-dev-identity.env"
stop(){ echo "STOP: $1" >&2; exit 2; }

[ -s "$CFG" ] || stop "Director DEV identity config missing"
source "$CFG"
[ "${W3_T3_3_DEV_CONFIG:-}" = YES ] || stop "Director DEV configuration not active"
[ "$AUTH" = YES ] || stop "explicit final production activation authorization missing"
[ "${W3_T3_3_PROJECT_REF:-}" = "$EXPECTED_REF" ] || stop "project ref mismatch"
[ "$(git -C "$REPO" branch --show-current)" = main ] || stop "branch must be main"
[ -z "$(git -C "$REPO" status --porcelain)" ] || stop "working tree must be clean"

cd "$REPO"
source scripts/w3-task3-3-runtime-inputs-load.sh

# Product-ready runtime aliases are derived from the frozen DEV config/runtime
# inputs. These are not second-stage dynamic identity bindings.
export PR7_CANONICAL_COMPANY_UUID="${W2_T2_1_CANONICAL_COMPANY_UUID}"
export PR9_KB_SMOKE_QUERY="${PR10_KB_TENANT_A_QUERY}"

# W1 Widget runtime uses the real Tenant A authenticated fixture.
export W1_SMOKE_USER_JWT="${PR10_TENANT_A_BEARER_TOKEN}"
export W1_KB_SMOKE_QUERY="${PR10_KB_TENANT_A_QUERY}"
export W1_SMOKE_AGENT_PROFILE_ID="${PR10_TENANT_A_AGENT_PROFILE_UUID}"

# Deliberately synthetic no-context probes. They are test messages only and are
# excluded from training by widget-live-ai-test. They must be genuinely distinct.
export W1_NO_CONTEXT_QUERY="${W1_NO_CONTEXT_QUERY:-runtime-smoke-unknown-alpha-7f3a91}"
export W1_NO_CONTEXT_QUERY_ALT="${W1_NO_CONTEXT_QUERY_ALT:-runtime-smoke-unknown-beta-4c82de}"

bash scripts/w3-task3-1-product-surface-final-gate.sh "$REPO"
python3 tests/edge/w3-task3-2-security-source-contract.py "$REPO"
bash scripts/pr10-two-tenant-security-source-gate.sh
bash scripts/pr10-cross-tenant-edge-api-source-gate.sh
bash scripts/pr10-cross-tenant-mutation-write-source-gate.sh
bash scripts/pr7-production-atomic-rollback-source-gate.sh
npm run build

# 2.1 — canonical DEV identity activation.
export W2_T2_1_PRODUCTION_AUTHORIZED=YES
export W2_T2_1_RUN_PRODUCTION=true
bash scripts/w2-task2-1-final-gate.sh

# 2.2 — canonical CE activation + real multi-agent runtime proof.
export W2_T2_2_PRODUCTION_AUTHORIZED=YES
export W2_T2_2_RUN_PRODUCTION=true
export PR7_PROJECT_REF="$W3_T3_3_PROJECT_REF"
export PR8_CE_SMOKE_FIXTURE_APPROVED=YES
export PR8_CE_SMOKE_CONVERSATION_ID="${PR10_TENANT_A_CONVERSATION_UUID}"
export PR8_CE_SMOKE_BEARER_TOKEN="${PR10_TENANT_A_BEARER_TOKEN}"
bash scripts/w2-task2-2-final-gate.sh

# Only after the legacy single-company canonicalization is complete do we add
# the second DEV tenant fixture.
export W3_DEV_FIXTURE_WRITE_AUTHORIZED=YES
bash scripts/w3-task3-2-dev-tenant-b-fixture-bootstrap.sh

# 2.3 — learning loop activation + Lovable-native deploy confirmation + runtime.
export W2_T2_3_PRODUCTION_AUTHORIZED=YES
export W2_T2_3_RUN_PRODUCTION=true
export W2_T2_3_PROJECT_REF="$W3_T3_3_PROJECT_REF"
bash scripts/w2-task2-3-final-gate.sh

# W1 Task 1.2 is a real runtime gate, not a source-only gate. It reuses the
# canonical Task2.3 write/publish/read-back path after 2.3 has been activated.
export W1_T1_2_RUN_PRODUCTION=true
bash scripts/w1-task1-2-kb-contract-final-gate.sh

# W1 Task 1.3 — full widget conversational runtime smoke.
export W1_RUN_PRODUCTION_SMOKE=true
bash scripts/w1-task1-3-final-gate.sh

bash scripts/w3-task3-2-runtime-fixture-config-gate.sh
export W3_T3_2_RUN_PRODUCTION=true
bash scripts/w3-task3-2-security-final-gate.sh

echo "W3 TASK 3.3 ACTIVATION SEQUENCE: PASS"
