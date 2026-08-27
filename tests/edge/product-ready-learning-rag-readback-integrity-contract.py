#!/usr/bin/env python3
from pathlib import Path
import sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(root/"supabase/functions/training-kb-finalize/index.ts").read_text()

assert 'PR6B_SINGAPORE_KB_FINALIZE_V3' in s
assert 'newContentEvidenceMatches' in s
assert 'verificationWindows' in s
assert 'normalize("NFKC")' in s

# Existing closed-loop gates remain.
assert 'text(document.content_hash) !== expectedNewHash' in s
assert 'text(document.production_vector_status) !== "indexed"' in s
assert 'parsed.selectedDocumentId === documentId' in s
assert 'full_content_evidence' in s

# Tenant must still be exact.
assert 'kb_document_tenant_mismatch' in s
assert 'String(document.company_id ?? "") !== String(tenantId)' in s

# New critical behavior: same document alone is not success.
assert 'kb_rag_new_content_not_visible' in s
assert 'rag_new_content_verified: true' in s

# Stale-vector mismatch is pending/retryable, not published or destructive failure.
idx=s.index('if (!newContentEvidenceMatches(newContent, sameDocumentEvidence))')
block=s[idx:s.index('await finish("published", null)', idx)]
assert 'await finish("pending", "kb_rag_new_content_not_visible")' in block
assert 'state: "pending"' in block
assert 'state: "published"' not in block

# Publication occurs only after new-content proof.
assert s.index('newContentEvidenceMatches(newContent, sameDocumentEvidence)') < s.index('await finish("published", null)')

print("PASS product-ready learning RAG readback integrity source contract")
