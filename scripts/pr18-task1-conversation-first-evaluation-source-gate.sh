#!/bin/bash
set -Eeuo pipefail

F="src/lib/api/ce.functions.ts"
C="src/lib/i18n/ceReviewCopy.ts"
E="supabase/functions/conversation-evaluate/index.ts"
S="sql/pr18/pr18_ce_conversation_first_local_scope.sql"
R="sql/pr18/pr18_ce_conversation_first_local_scope.rollback.sql"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$F" "$C" "$E" "$S" "$R"; do
  [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }
done

has "$F" 'readinessForMessages' "Evaluation readiness is conversation-content based"
has "$F" 'customer_message_required' "Customer-message readiness reason"
has "$F" 'ai_response_required' "AI-response readiness reason"
has "$F" 'ce_local_evaluation' "Local evaluation reader exists"
not_has "$F" 'platform_company_identity_unresolved' "Company identity no longer blocks UI readiness"
not_has "$C" 'SU Platform company identity' "Old company blocker copy removed"
has "$C" 'Evaluation requires at least one customer message and one AI response.' "New readiness copy"

has "$E" 'mode: "conversation_local"' "Edge supports conversation-local mode"
has "$E" 'resolveEvaluationScope' "Single evaluation scope resolver exists"
has "$E" 'ce_conversation_first_enabled' "Conversation-first mode feature flag checked"
has "$E" 'user_roles' "Local mode authorizes against AI Chatbot roles"
has "$E" 'LOCAL_EVALUATOR_SYSTEM_PROMPT' "Conversation-only six-dimension evaluator prompts exist"
has "$E" 'initiate_local_evaluation_v1' "Local atomic initiation RPC wired"
has "$E" 'complete_local_evaluation_v1' "Local atomic completion RPC wired"
has "$E" 'buildCanonicalBundle' "Canonical tenant-bound path retained"
has "$E" 'fetchGrounding' "Canonical grounding path retained"
has "$E" 'lovableproject.com' "Current Lovable Preview CORS supported"
has "$E" 'PUBLISHED_CONSOLE_ORIGIN' "Published console origin retained"

has "$S" 'CREATE TABLE IF NOT EXISTS public.ce_local_evaluation' "Local evaluation store exists"
has "$S" 'company_id uuid NULL' "Local evaluation does not invent canonical company id"
has "$S" 'ce_local_actor_can_evaluate' "DB role guard exists"
has "$S" "role::text IN ('admin','supervisor','qa')" "Only CE run roles may initiate local evaluation"
has "$S" '0.25' "Accuracy weight preserved"
has "$S" '0.20' "Policy/tone weights preserved"
has "$S" '0.15' "Sales weight preserved"
has "$S" 'hallucination_risk' "Hallucination risk dimension preserved"
has "$R" 'PR18_ROLLBACK_BLOCKED_LOCAL_EVALUATIONS_EXIST' "Rollback refuses destructive deletion of real local evaluations"

if [ "$fail" -ne 0 ]; then
  echo "PR18 TASK1 CONVERSATION-FIRST EVALUATION STATUS: FAIL"
  exit 1
fi
echo "PR18 TASK1 CONVERSATION-FIRST EVALUATION STATUS: PASS"
