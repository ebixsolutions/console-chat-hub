#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

python3 tests/edge/w3-task3-2-security-source-contract.py "$ROOT"
bash scripts/w3-task3-1-product-surface-final-gate.sh "$ROOT"
bash scripts/pr10-two-tenant-security-source-gate.sh
bash scripts/pr10-cross-tenant-edge-api-source-gate.sh
bash scripts/pr10-cross-tenant-mutation-write-source-gate.sh
bash scripts/pr7-production-atomic-rollback-source-gate.sh

# Security-sensitive source must still fail closed around tenant membership and
# server-only KB identity/auth.
grep -q 'tenant_identity_conflict' supabase/functions/conversation-evaluate/index.ts
grep -q 'not_a_member' supabase/functions/conversation-evaluate/index.ts
grep -q 'validateTargetAgentInCompany' supabase/functions/assign-conversation/index.ts
grep -q 'validateTargetAgentInCompany' supabase/functions/transfer-conversation/index.ts
grep -q '"x-api-key": credential.value' supabase/functions/_shared/kb-auth.ts
grep -q 'company_id: companyId' supabase/functions/_shared/kb-client.ts

npm run build

if [ "${W3_T3_2_RUN_PRODUCTION:-false}" != "true" ]; then
  echo "STOP: W3 Task 3.2 source/build/rollback gates pass; real approved two-tenant runtime fixtures are still required" >&2
  exit 2
fi

bash scripts/pr10-two-tenant-security-runtime-smoke.sh
bash scripts/pr10-cross-tenant-edge-api-runtime-smoke.sh
bash scripts/pr10-cross-tenant-mutation-write-runtime-smoke.sh

echo "W3 TASK 3.2 FINAL STATUS: READY"
