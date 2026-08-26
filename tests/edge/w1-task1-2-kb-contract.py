#!/usr/bin/env python3
from pathlib import Path
import re, sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
def read(p): return (root / p).read_text(encoding="utf-8")

auth = read("supabase/functions/_shared/kb-auth.ts")
client = read("supabase/functions/_shared/kb-client.ts")
agg = read("supabase/functions/_shared/kb-aggregation-response.ts")
sync = read("supabase/functions/training-kb-sync/index.ts")
fin = read("supabase/functions/training-kb-finalize/index.ts")

assert '"x-api-key": credential.value' in auth
assert '?? "x-api-key"' in client
assert 'KB_SINGAPORE_BASE_URL' in client
assert 'company_id: companyId' in client
assert 'candidate_top_k' in client and 'max_summary_chunks' in client and 'max_full_content_chunks' in client
assert 'KB_COMPANY_ID_INVALID' in client
assert 'combined_text' in agg and 'intentionally not used as factual evidence' in agg
assert 'chunkType === "full_content"' in agg
assert 'selected_documents.length !== 1' in agg

for src in (sync, fin):
    assert 'resolveSingaporeCredential' in src
    assert 'singaporeCredentialHeaders' in src
    assert 'mintJwt' not in src
    assert 'Authorization: `Bearer ${token}`' not in src
    assert 'KB_SINGAPORE_TENANT_MAP_JSON' in src

assert 'parseAggregationResponse' in fin
assert 'rag.has_context' not in fin
assert 'rag.documents' not in fin
assert 'max_summary:' not in fin
assert 'max_full_chunks:' not in fin
assert '"top_k"' not in fin and "'top_k'" not in fin
assert 'company_id: upstreamCompanyId' in fin
assert 'max_summary_chunks: 1' in fin
assert 'max_full_content_chunks: 3' in fin
assert 'full_content_evidence' in fin
assert 'idempotency_key: idem' in sync
assert 'expected_content_hash_mismatch' in sync
assert 'kb_version_snapshot_conflict' in sync
print("PASS W1 Task 1.2 KB contract source assertions")
