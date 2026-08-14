#!/bin/bash
set -Eeuo pipefail

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

KB="supabase/functions/_shared/kb-client.ts"
PROXY="supabase/functions/kb-search-proxy/index.ts"
REPLY="supabase/functions/generate-reply/index.ts"
ASSIST="supabase/functions/agent-assist/index.ts"
CE="supabase/functions/_shared/ce-grounding.ts"

for f in "$KB" "$PROXY" "$REPLY" "$ASSIST" "$CE"; do
  [ -s "$f" ] && pass "file $f" || { bad "missing $f"; }
done

# Canonical Singapore adapter contract.
must_have "$KB" 'SINGAPORE_RAG_PATH = "/api/v1/rag/context-search"' "canonical Singapore RAG endpoint"
must_have "$KB" 'top_k: Math.max(queryInput.top_k, 12)' "RAG candidate depth >=12"
must_have "$KB" 'score_threshold: 0.05' "RAG score threshold"
must_have "$KB" 'max_documents: 1' "RAG one-document contract"
must_have "$KB" 'max_summary: 1' "RAG max one summary"
must_have "$KB" 'max_full_chunks: 3' "RAG max three full-content chunks"
must_have "$KB" 'doc.status !== "published"' "selected document must be published"
must_have "$KB" 'doc.production_status !== "production"' "selected document must be production"
must_have "$KB" 'doc.available_to_live_console !== true' "selected document must be live-console enabled"
must_have "$KB" 'doc.is_outdated === true' "outdated selected document rejected"
must_have "$KB" 'KB_CROSS_DOCUMENT_MISMATCH' "cross-document response rejected"
must_have "$KB" 'citation.chunk_type !== "full_content"' "only full_content enters evidence"
must_have "$KB" 'faq_pair/section are NOT substituted' "faq/section not promoted to exact evidence"

# kb-search-proxy uses canonical adapter and never permits browser tenant scope.
must_have "$PROXY" 'from "../_shared/kb-client.ts"' "KB proxy imports canonical adapter"
must_have "$PROXY" 'resolveTenantScope(conversationId)' "KB proxy conversation tenant resolver"
must_have "$PROXY" 'fetchKBRag(' "KB proxy uses canonical RAG fetch"
must_have "$PROXY" 'body?.tenant_id !== undefined' "KB proxy rejects browser tenant id"
must_have "$PROXY" 'body?.company_id !== undefined' "KB proxy rejects browser company id"
must_have "$PROXY" 'cross-document aggregation mismatch' "KB proxy defense-in-depth cross-document guard"

# Auto reply uses canonical adapter and structured evidence.
must_have "$REPLY" 'from "../_shared/kb-client.ts"' "generate-reply imports canonical adapter"
must_have "$REPLY" 'resolveTenantScope(conversation_id)' "generate-reply resolves canonical KB tenant"
must_have "$REPLY" 'await callKBAdapter(conversation_id, userQuery, _kbTenantResult.scope)' "generate-reply passes resolved scope to KB"
must_have "$REPLY" 'The RAG summary is orientation only' "generate-reply summary is orientation only"
must_have "$REPLY" 'Full Content Evidence: none. Do not assert exact facts' "generate-reply exact-fact fail-safe"

# Agent Assist uses same contract for suggest + policy.
must_have "$ASSIST" 'from "../_shared/kb-client.ts"' "Agent Assist imports canonical adapter"
must_have "$ASSIST" 'tenantResult.scope.aiCompanyId !== scope.companyId' "Agent Assist independently checks company"
must_have "$ASSIST" 'full_content_evidence' "Agent Assist requires structured full-content evidence"
must_have "$ASSIST" 'suggest_insufficient_evidence' "Suggest Reply fails closed without evidence"
must_have "$ASSIST" 'status: "insufficient_evidence"' "Policy Check reports insufficient evidence"

# CE uses same adapter and checks independent resolver consistency.
must_have "$CE" 'from "./kb-client.ts"' "CE grounding imports canonical adapter"
must_have "$CE" 'fetchKBRag(' "CE grounding uses canonical RAG"
must_have "$CE" 'primary.aiCompanyId !== args.company.company_id' "CE rejects company resolver mismatch"
must_have "$CE" 'kb_resolution_changed_within_request' "CE rejects tenant drift between retrievals"
must_have "$CE" 'full_content_evidence' "CE builds grounding from full-content evidence"

if [ "$fail" -ne 0 ]; then
  echo "TASK 4.3 KB CALL-CHAIN STATUS: FAIL"
  exit 1
fi
echo "TASK 4.3 KB CALL-CHAIN STATUS: PASS"
