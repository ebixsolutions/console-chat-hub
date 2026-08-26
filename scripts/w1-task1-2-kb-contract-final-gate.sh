#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(pwd)}"
cd "$ROOT"

python3 tests/edge/w1-task1-2-kb-contract.py "$ROOT"

for f in \
  supabase/functions/_shared/kb-auth.ts \
  supabase/functions/_shared/kb-client.ts \
  supabase/functions/_shared/kb-aggregation-response.ts \
  supabase/functions/training-kb-sync/index.ts \
  supabase/functions/training-kb-finalize/index.ts
do
  test -s "$f"
done

# No old finalizer RAG contract or direct Bearer-only writer is allowed.
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

echo "PASS W1 Task 1.2 final source gate"
