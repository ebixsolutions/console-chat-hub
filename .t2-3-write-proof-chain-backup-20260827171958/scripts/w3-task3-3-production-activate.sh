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

# CRITICAL PRE-MUTATION PREFLIGHT:
# load/validate every external runtime dependency, including explicit
# Lovable-native Edge deployment confirmation, BEFORE Task2.1/2.2 or any other
# DB/bootstrap mutation begins.
source scripts/w3-task3-3-runtime-inputs-load.sh
[ "${W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED:-}" = "YES" ] \
  || stop "Lovable-native Supabase Edge deployment not confirmed before activation"

# Product-ready runtime aliases are derived from the frozen DEV config/runtime
# inputs. These are not second-stage dynamic identity bindings.
export PR7_CANONICAL_COMPANY_UUID="${W2_T2_1_CANONICAL_COMPANY_UUID}"
export PR9_KB_SMOKE_QUERY="${PR10_KB_TENANT_A_QUERY}"

# W1 runtime must be deterministic in the one-click path. The Supabase URL is
# public project metadata and can be safely derived from the frozen project ref;
# do not require an extra runtime secret/env variable.
export SUPABASE_URL="${SUPABASE_URL:-https://${W3_T3_3_PROJECT_REF}.supabase.co}"

# W1 Widget runtime uses the real Tenant A authenticated fixture.
export W1_SMOKE_USER_JWT="${PR10_TENANT_A_BEARER_TOKEN}"
export W1_KB_SMOKE_QUERY="${PR10_KB_TENANT_A_QUERY}"
export W1_SMOKE_AGENT_PROFILE_ID="${PR10_TENANT_A_AGENT_PROFILE_UUID}"

export W1_NO_CONTEXT_QUERY="${W1_NO_CONTEXT_QUERY:-runtime-smoke-unknown-alpha-7f3a91}"
export W1_NO_CONTEXT_QUERY_ALT="${W1_NO_CONTEXT_QUERY_ALT:-runtime-smoke-unknown-beta-4c82de}"

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
export PR7_PROJECT_REF="$W3_T3_3_PROJECT_REF"
export PR8_CE_SMOKE_FIXTURE_APPROVED=YES
export PR8_CE_SMOKE_CONVERSATION_ID="${PR10_TENANT_A_CONVERSATION_UUID}"
export PR8_CE_SMOKE_BEARER_TOKEN="${PR10_TENANT_A_BEARER_TOKEN}"
bash scripts/w2-task2-2-final-gate.sh

export W3_DEV_FIXTURE_WRITE_AUTHORIZED=YES
bash scripts/w3-task3-2-dev-tenant-b-fixture-bootstrap.sh

bash scripts/w2-task2-1-two-tenant-identity-runtime-gate.sh

export W2_T2_3_PRODUCTION_AUTHORIZED=YES
export W2_T2_3_RUN_PRODUCTION=true
export W2_T2_3_PROJECT_REF="$W3_T3_3_PROJECT_REF"
export W2_T2_3_FIXTURE_APPROVED=YES
export W2_T2_3_CONVERSATION_ID="${PR10_TENANT_A_CONVERSATION_UUID}"
export W2_T2_3_REVIEW_BEARER_TOKEN="${PR10_TENANT_A_BEARER_TOKEN}"
unset W2_T2_3_EVALUATION_ID
bash scripts/w2-task2-3-final-gate.sh

export W1_T1_2_RUN_PRODUCTION=true
bash scripts/w1-task1-2-kb-contract-final-gate.sh

export W1_RUN_PRODUCTION_SMOKE=true
bash scripts/w1-task1-3-final-gate.sh

bash scripts/w3-task3-2-runtime-fixture-config-gate.sh
export W3_T3_2_RUN_PRODUCTION=true
bash scripts/w3-task3-2-security-final-gate.sh

echo "W3 TASK 3.3 ACTIVATION SEQUENCE: PASS"
