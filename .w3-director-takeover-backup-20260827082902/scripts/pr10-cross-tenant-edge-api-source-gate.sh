#!/bin/bash
set -Eeuo pipefail

S="scripts/pr10-cross-tenant-edge-api-runtime-smoke.sh"
F="scripts/pr7-production-final-gate.sh"
C360="supabase/functions/customer360-local/index.ts"
AA="supabase/functions/agent-assist/index.ts"
CE="supabase/functions/conversation-evaluate/index.ts"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }

for f in "$S" "$F" "$C360" "$AA" "$CE"; do
  [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }
done

has "$S" 'PR10_EDGE_API_FIXTURES_APPROVED' "Edge/API real-fixture approval required"
has "$S" 'Tenant A Customer360 own positive control' "Tenant A API positive control exists"
has "$S" 'Tenant B Customer360 own positive control' "Tenant B API positive control exists"
has "$S" 'Tenant A cannot enumerate Tenant B Customer360' "Customer360 A->B denial runtime exists"
has "$S" 'Tenant B cannot enumerate Tenant A Customer360' "Customer360 B->A denial runtime exists"
has "$S" 'Tenant A Agent Assist foreign conversation denial' "Agent Assist A->B denial runtime exists"
has "$S" 'Tenant B Agent Assist foreign conversation denial' "Agent Assist B->A denial runtime exists"
has "$S" 'Tenant A CE foreign conversation denial' "CE A->B denial runtime exists"
has "$S" 'Tenant B CE foreign conversation denial' "CE B->A denial runtime exists"

has "$C360" '.eq("company_id", companyId)' "Customer360 queries remain canonical-company scoped"
has "$C360" 'return json({ error: "not_found" }, 404)' "Customer360 cross-tenant enumeration fail-closed"
has "$AA" 'conv.company_id !== scope.companyId' "Agent Assist exact company boundary retained"
has "$AA" 'conversation_not_found' "Agent Assist cross-tenant enumeration returns not-found"
has "$CE" 'if (!members || members.length === 0)' "CE membership guard retained"
has "$CE" 'detail: "not_a_member"' "CE cross-tenant membership denial retained"

# Order guards: foreign Agent Assist and CE must be rejected before provider use.
python3 - "$AA" "$CE" <<'PY' || { bad "provider-before-tenant-boundary guard order"; }
import sys
aa=open(sys.argv[1],encoding="utf-8").read()
ce=open(sys.argv[2],encoding="utf-8").read()
aa_guard=aa.find('conv.company_id !== scope.companyId')
aa_provider=aa.find('// Tool execution')
ce_guard=ce.find('if (!members || members.length === 0)')
ce_ground=ce.find('const grounding = await fetchGrounding')
if min(aa_guard,aa_provider,ce_guard,ce_ground) < 0:
    raise SystemExit(1)
if not (aa_guard < aa_provider and ce_guard < ce_ground):
    raise SystemExit(1)
print("PASS provider/grounding occurs only after tenant denial guard")
PY

has "$F" 'pr10-cross-tenant-edge-api-runtime-smoke.sh' "production final gate executes Task 10.2 runtime"

if [ "$fail" -ne 0 ]; then
  echo "TASK 10.2 CROSS-TENANT EDGE/API SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 10.2 CROSS-TENANT EDGE/API SOURCE STATUS: PASS"
