#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(pwd)}"
cd "$ROOT"

python3 tests/edge/w1-task1-2-kb-contract.py "$ROOT"
python3 tests/edge/product-ready-learning-approval-guard-contract.py "$ROOT"
python3 tests/edge/product-ready-learning-rag-readback-integrity-contract.py "$ROOT"

for f in \
  supabase/functions/_shared/kb-auth.ts \
  supabase/functions/_shared/kb-client.ts \
  supabase/functions/_shared/kb-aggregation-response.ts \
  supabase/functions/training-kb-sync/index.ts \
  supabase/functions/training-kb-finalize/index.ts \
  scripts/pr9-singapore-kb-authenticated-runtime-smoke.sh \
  scripts/w2-task2-3-learning-loop-runtime-smoke.sh
do
  test -s "$f" || { echo "FAIL missing/empty required W1 Task1.2 file: $f" >&2; exit 1; }
done

! grep -q 'rag\.has_context' supabase/functions/training-kb-finalize/index.ts
! grep -q 'rag\.documents' supabase/functions/training-kb-finalize/index.ts
! grep -q 'max_summary:' supabase/functions/training-kb-finalize/index.ts
! grep -q 'max_full_chunks:' supabase/functions/training-kb-finalize/index.ts
! grep -q 'Authorization: `Bearer ${token}`' supabase/functions/training-kb-sync/index.ts
! grep -q 'Authorization: `Bearer ${token}`' supabase/functions/training-kb-finalize/index.ts

grep -q 'company_id: companyId' supabase/functions/_shared/kb-client.ts
grep -q 'company_id: upstreamCompanyId' supabase/functions/training-kb-finalize/index.ts
grep -q 'resolveSingaporeCredential' supabase/functions/training-kb-sync/index.ts
grep -q 'resolveSingaporeCredential' supabase/functions/training-kb-finalize/index.ts
grep -q 'full_content_evidence' supabase/functions/training-kb-finalize/index.ts
grep -q 'kb_update_not_verified_approved' supabase/functions/training-kb-sync/index.ts
grep -q 'rag_new_content_verified: true' supabase/functions/training-kb-finalize/index.ts

if [ "${W1_T1_2_RUN_PRODUCTION:-false}" != "true" ]; then
  echo "STOP: W1 Task 1.2 source implementation complete; authenticated read + real write/read-back runtime proof still required" >&2
  exit 2
fi

bash scripts/pr9-singapore-kb-authenticated-runtime-smoke.sh
[ "${W1_T1_2_WRITE_PROOF_CONFIRMED:-}" = "YES" ] || {
  echo "STOP: governed KB write/publish/new-content RAG proof was not completed earlier in this activation run" >&2
  exit 2
}

echo "PASS governed KB write/publish/new-content RAG proof already completed by Task 2.3"

echo "W1 TASK 1.2 FINAL STATUS: READY"
