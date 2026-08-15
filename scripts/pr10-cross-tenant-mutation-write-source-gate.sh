#!/bin/bash
set -Eeuo pipefail

S="scripts/pr10-cross-tenant-mutation-write-runtime-smoke.sh"
F="scripts/pr7-production-final-gate.sh"
SHARED="supabase/functions/_shared/agent.ts"
SEND="supabase/functions/agent-send-reply/index.ts"
ASSIGN="supabase/functions/assign-conversation/index.ts"
TAKE="supabase/functions/take-over-conversation/index.ts"
TRANSFER="supabase/functions/transfer-conversation/index.ts"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }

for f in "$S" "$F" "$SHARED" "$SEND" "$ASSIGN" "$TAKE" "$TRANSFER"; do
  [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }
done

has "$S" 'PR10_MUTATION_FIXTURES_APPROVED' "real mutation fixture approval required"
has "$S" 'A_BEFORE="$(fingerprint "$A_CONV")"' "Tenant A pre-write fingerprint exists"
has "$S" 'B_BEFORE="$(fingerprint "$B_CONV")"' "Tenant B pre-write fingerprint exists"
has "$S" '[ "$A_AFTER" = "$A_BEFORE" ]' "Tenant A exact no-write assertion exists"
has "$S" '[ "$B_AFTER" = "$B_BEFORE" ]' "Tenant B exact no-write assertion exists"
has "$S" 'Tenant A cannot assign Tenant B agent' "foreign target-agent assignment denial exists"
has "$S" 'Tenant B cannot transfer to Tenant A agent' "foreign target-agent transfer denial exists"

for f in "$SEND" "$ASSIGN" "$TAKE" "$TRANSFER"; do
  has "$f" '.eq("company_id", scope.companyId)' "$(basename "$(dirname "$f")") conversation write path company-scoped"
done

has "$ASSIGN" 'validateTargetAgentInCompany' "assign target agent uses canonical company validation"
has "$TRANSFER" 'validateTargetAgentInCompany' "transfer target agent uses canonical company validation"
has "$SHARED" '.eq("company_id", companyId)' "target agent membership is company-scoped"
has "$SHARED" 'return json({ error: "Target agent not found" }, 404)' "foreign target agents remain non-enumerable"

python3 - "$SEND" "$ASSIGN" "$TAKE" "$TRANSFER" <<'PY' || { bad "tenant guards must execute before mutation RPCs"; }
import sys
files=sys.argv[1:]
checks=[
 ("agent_send_reply_tx", files[0]),
 ("assign_conversation_tx", files[1]),
 ("takeover_conversation_tx", files[2]),
 ("transfer_conversation_tx", files[3]),
]
for rpc,path in checks:
    text=open(path,encoding="utf-8").read()
    guard=text.find('.eq("company_id", scope.companyId)')
    mutation=text.find(rpc)
    if guard < 0 or mutation < 0 or guard >= mutation:
        raise SystemExit(1)
print("PASS all conversation tenant guards execute before service-role mutation RPC")
PY

python3 - "$ASSIGN" "$TRANSFER" <<'PY' || { bad "target-agent guards must execute before mutation RPCs"; }
import sys
checks=[("assign_conversation_tx",sys.argv[1]),("transfer_conversation_tx",sys.argv[2])]
for rpc,path in checks:
    text=open(path,encoding="utf-8").read()
    guard=text.find("validateTargetAgentInCompany")
    mutation=text.find(rpc)
    if guard < 0 or mutation < 0 or guard >= mutation:
        raise SystemExit(1)
print("PASS target-agent company validation executes before assignment/transfer RPC")
PY

has "$F" 'pr10-cross-tenant-mutation-write-runtime-smoke.sh' "production final gate executes Task 10.3 runtime"

if [ "$fail" -ne 0 ]; then
  echo "TASK 10.3 CROSS-TENANT MUTATION/WRITE SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 10.3 CROSS-TENANT MUTATION/WRITE SOURCE STATUS: PASS"
