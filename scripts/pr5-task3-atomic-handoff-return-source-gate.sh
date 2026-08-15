#!/bin/bash
set -Eeuo pipefail

S="sql/pr5/pr5_task3_atomic_handoff_return_lifecycle.sql"
R="sql/pr5/pr5_task3_atomic_handoff_return_lifecycle.rollback.sql"
AI="sql/pr7/pr7_ai_reply_source_message_atomic_guard.sql"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$S" "$R" "$AI"; do
  [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }
done

# All manual lifecycle writers share the same locked conversation authority.
for fn in assign_conversation_tx takeover_conversation_tx transfer_conversation_tx return_to_ai_tx; do
  has "$S" "FUNCTION public.${fn}" "${fn} replaced as full function"
done

COUNT=$(grep -Fc "FOR UPDATE;" "$S")
[ "$COUNT" -ge 4 ] && pass "all four lifecycle RPCs lock conversation row" || bad "all four lifecycle RPCs lock conversation row"

has "$S" "JOIN public.company_membership" "DB functions enforce canonical company membership"
has "$S" "cm.company_id = v_conv.company_id" "membership is bound to conversation company"
has "$S" "company_role NOT IN ('admin','supervisor')" "elevated RBAC enforced in DB"
has "$S" "'tenant_unresolved'" "null company fails closed"

# Assign must establish actual human-control state, not just owner pointer.
python3 - "$S" <<'PY' || { bad "Assign atomic human-control status contract"; }
import sys,re
s=open(sys.argv[1],encoding="utf-8").read()
m=re.search(r'CREATE OR REPLACE FUNCTION public\.assign_conversation_tx\(.*?\n\$function\$;',s,re.S)
if not m: raise SystemExit(1)
b=m.group(0)
for required in [
    "SET assigned_agent_id = p_target_agent_id,",
    "status = 'pending'",
    "conversation_status_log",
    "conversation_assignment",
    "handoff_event",
    "audit_log",
]:
    if required not in b: raise SystemExit(1)
print("PASS assign sets owner + pending + assignment/status/handoff/audit atomically")
PY

# Takeover can claim pending/unassigned automatic handoff and rejects stale owner/status.
has "$S" "v_conv.status IS DISTINCT FROM p_expected_status" "takeover/return expected-state race guard retained"
has "$S" "v_conv.assigned_agent_id IS DISTINCT FROM p_expected_owner" "expected-owner race guard retained"

# Return-to-AI: only owner or elevated actor can release; pending unassigned needs elevated.
has "$S" "An unassigned AI handoff (pending + owner NULL)" "unassigned automatic handoff release rule documented"
has "$S" "AND v_conv.assigned_agent_id IS DISTINCT FROM p_actor_agent_id" "non-elevated return-to-AI restricted to current owner"
has "$S" "status = 'open'" "Return-to-AI resumes canonical open state"
has "$S" "SET assigned_agent_id = NULL" "Return-to-AI clears human owner"

# Actor/target agents must belong to the canonical conversation company.
[ "$(grep -Fc "cm.company_id = v_conv.company_id" "$S")" -ge 6 ] \
  && pass "actor/target company membership defense-in-depth" \
  || bad "actor/target company membership defense-in-depth"
has "$S" "WHERE ap.id = p_target_agent_id" "Assign target company validation"
has "$S" "WHERE ap.id = p_to_agent_id" "Transfer target company validation"

# Frozen automatic escalation writers must not be redefined by this Task.
for fn in explicit_handoff_tx s0_handoff_tx required_escalation_handoff_tx required_escalation_clarification_tx; do
  not_has "$S" "FUNCTION public.${fn}" "frozen ${fn} not reopened"
done

# Existing PR-7 AI commit gate is the final collision guard: pending/unassigned
# automatic handoff still blocks a stale/new AI answer at commit time.
has "$AI" "v_conv.status IN (" "AI commit state gate exists"
has "$AI" "'pending','transferred','human_needed','human_control'," "pending/human-control AI commit denial retained"
has "$AI" "RETURN jsonb_build_object('result', 'human_control')" "AI reply suppressed under human-control state"
has "$AI" "FOR UPDATE;" "AI reply commit shares conversation row lock"

# ACL.
has "$S" "FROM PUBLIC, anon, authenticated" "direct authenticated RPC execution revoked"
has "$S" "TO service_role" "service-role-only lifecycle execution retained"

# Rollback is exact source restoration, no data deletion.
for fn in assign_conversation_tx takeover_conversation_tx transfer_conversation_tx return_to_ai_tx; do
  has "$R" "FUNCTION public.${fn}" "rollback restores ${fn}"
done
not_has "$R" "DELETE FROM" "rollback does not delete production data"
not_has "$R" "DROP TABLE" "rollback does not drop tables"

if [ "$fail" -ne 0 ]; then
  echo "PR5 TASK3 ATOMIC HANDOFF / RETURN-TO-AI SOURCE STATUS: FAIL"
  exit 1
fi

echo "PR5 TASK3 ATOMIC HANDOFF / RETURN-TO-AI SOURCE STATUS: PASS"
