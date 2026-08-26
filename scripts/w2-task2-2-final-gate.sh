#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"
python3 tests/edge/w2-task2-2-source-contract.py "$ROOT"

# Frozen dependency source markers are required for the activation call chain.
for f in \
  sql/pr7/pr7_company_membership_foundation.sql \
  sql/pr7/pr7_channel_ownership_foundation.sql \
  sql/pr7/pr7_conversation_lineage_foundation.sql \
  sql/pr20/pr20_ce_canonical_rebinding.sql \
  scripts/pr7-company-membership-bootstrap.sh \
  scripts/pr7-channel-ownership-bootstrap.sh \
  scripts/pr7-conversation-lineage-bootstrap.sh \
  scripts/pr20-ce-local-to-canonical-migrate.sh
 do test -s "$f"; done

grep -q 'rebind_local_evaluations_v1' sql/pr20/pr20_ce_canonical_rebinding.sql

action="${W2_T2_2_RUN_PRODUCTION:-false}"
if [ "$action" != "true" ]; then
  echo "STOP: Task 2.2 implementation complete; production activation requires explicit authorization" >&2
  exit 2
fi
bash scripts/w2-task2-2-canonical-ce-activate.sh
bash scripts/w2-task2-2-runtime-gate.sh
echo "W2 TASK 2.2 FINAL STATUS: READY"
