#!/bin/bash
set -Eeuo pipefail
S="scripts/pr10-cross-tenant-edge-api-runtime-smoke.sh"
F="scripts/pr7-production-final-gate.sh"
C360="supabase/functions/customer360-local/index.ts"
AA="supabase/functions/agent-assist/index.ts"
CE="supabase/functions/conversation-evaluate/index.ts"
SCOPE="supabase/functions/_shared/pre-activation-scope.ts"
fail=0
pass(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
for f in "$S" "$F" "$C360" "$AA" "$CE" "$SCOPE"; do [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }; done
has "$S" 'PR10_EDGE_API_FIXTURES_APPROVED' "Edge/API real-fixture approval required"
has "$S" 'Tenant A Customer360 own positive control' "Tenant A API positive control exists"
has "$S" 'Tenant B Customer360 own positive control' "Tenant B API positive control exists"
has "$S" 'Tenant A cannot enumerate Tenant B Customer360' "Customer360 A->B denial runtime exists"
has "$S" 'Tenant B cannot enumerate Tenant A Customer360' "Customer360 B->A denial runtime exists"
has "$S" 'Tenant A Agent Assist foreign conversation denial' "Agent Assist A->B denial runtime exists"
has "$S" 'Tenant B Agent Assist foreign conversation denial' "Agent Assist B->A denial runtime exists"
has "$S" 'Tenant A CE foreign conversation denial' "CE A->B denial runtime exists"
has "$S" 'Tenant B CE foreign conversation denial' "CE B->A denial runtime exists"
has "$C360" 'applyCompanyScope(' "Customer360 uses canonical scope helper"
has "$C360" 'resolveCallerScope(' "Customer360 resolves authenticated caller scope"
has "$C360" 'return json({ error: "not_found" }, 404)' "Customer360 cross-tenant enumeration fail-closed"
has "$SCOPE" 'query.eq(column, scope.companyId)' "canonical scope helper applies exact company_id"
has "$SCOPE" 'query.is(column, null)' "pre-activation scope remains NULL-company only"
has "$AA" 'resolveConversationScope(' "Agent Assist resolves canonical conversation boundary"
has "$AA" 'applyCompanyScope(' "Agent Assist re-applies exact company scope"
has "$AA" 'conversation_not_found' "Agent Assist cross-tenant enumeration returns not-found"
has "$SCOPE" 'conversationCompanyId && channelCompanyId && conversationCompanyId !== channelCompanyId' "conversation/channel tenant conflict fails closed"
has "$SCOPE" 'return await requireActiveCompanyMembership' "canonical conversation requires active membership"
has "$CE" 'if (!members || members.length === 0)' "CE membership guard retained"
has "$CE" 'detail: "not_a_member"' "CE cross-tenant membership denial retained"
python3 - "$AA" "$CE" <<'PY2' || { bad "provider-before-tenant-boundary guard order"; }
import sys
aa=open(sys.argv[1],encoding='utf-8').read()
ce=open(sys.argv[2],encoding='utf-8').read()

def p(t,n):
    i=t.find(n)
    if i<0:
        raise SystemExit(1)
    return i

# Search only inside Agent Assist request handling. The callClaude helper
# declaration is above Deno.serve and is not a provider invocation.
aa_serve=p(aa,'Deno.serve(async(req)=>')
aa_body=aa[aa_serve:]
aa_scope=p(aa_body,'const scopeResult=await resolveConversationScope')
aa_conv=p(aa_body,'applyCompanyScope(supabaseAdmin.from("conversations")')
aa_provider=p(aa_body,'await callClaude(')
aa_tenant=p(aa_body,'const tenant=await resolveTenantScope')
aa_rag=p(aa_body,'const kb=await fetchKBRag')
if not (aa_scope < aa_conv < aa_provider and aa_scope < aa_tenant < aa_rag):
    raise SystemExit(1)

# CE request handling resolves the evaluation scope before grounding.
ce_handle_start=p(ce,'async function handleEvaluate(')
ce_handle=ce[ce_handle_start:]
ce_scope=p(ce_handle,'const scope = await resolveEvaluationScope')
ce_ground=p(ce_handle,'const grounding = await fetchGrounding')
if not ce_scope < ce_ground:
    raise SystemExit(1)

# Canonical CE membership denial remains inside resolveEvaluationScope before
# the canonical success branch is returned.
ce_resolve_start=p(ce,'async function resolveEvaluationScope(')
ce_resolve_end=p(ce,'async function buildConversationOnlyBundle')
ce_resolve=ce[ce_resolve_start:ce_resolve_end]
mem_guard=p(ce_resolve,'if (!members || members.length === 0)')
canonical_success=p(ce_resolve,'mode: "canonical"')
if not mem_guard < canonical_success:
    raise SystemExit(1)

print('PASS provider/grounding occurs only after canonical tenant denial guards')
PY2
has "$F" 'pr10-cross-tenant-edge-api-runtime-smoke.sh' "production final gate executes Task 10.2 runtime"
[ "$fail" -eq 0 ] || { echo "TASK 10.2 CROSS-TENANT EDGE/API SOURCE STATUS: FAIL"; exit 1; }
echo "TASK 10.2 CROSS-TENANT EDGE/API SOURCE STATUS: PASS"
