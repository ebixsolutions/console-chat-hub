#!/bin/bash
set -Eeuo pipefail

E="supabase/functions/conversation-evaluate/index.ts"
C="supabase/functions/_shared/ce-contract.ts"
L="supabase/functions/_shared/llm-router.ts"
F="src/lib/api/ce.functions.ts"
UI="src/routes/_authenticated/console.conversation-evaluation.index.tsx"
S="sql/pr22/pr22_ce_runtime_precanonical_schema.sql"
CFG="supabase/config.toml"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$E" "$C" "$L" "$F" "$UI" "$S" "$CFG"; do
  [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }
done

# Exact six-evaluator scoring contract.
has "$C" '"accuracy",' "Accuracy dimension"
has "$C" '"policy",' "Policy dimension"
has "$C" '"tone",' "Tone dimension"
has "$C" '"sales",' "Sales dimension"
has "$C" '"context",' "Context dimension"
has "$C" '"hallucination_risk",' "Hallucination-risk dimension"
has "$C" 'accuracy: 0.25' "Accuracy weight 25%"
has "$C" 'policy: 0.2' "Policy weight 20%"
has "$C" 'tone: 0.2' "Tone weight 20%"
has "$C" 'sales: 0.15' "Sales weight 15%"
has "$C" 'context: 0.1' "Context weight 10%"
has "$C" 'hallucination_risk: 0.1' "Hallucination quality weight 10%"

# Conversation-first runtime path.
has "$E" 'CE_EDGE_RUNTIME_VERSION = "ce-conversation-first-1.0.0"' "Deployed runtime version marker"
has "$E" 'mode: "conversation_local"' "Conversation-local evaluation mode"
has "$E" 'LOCAL_EVALUATOR_SYSTEM_PROMPT' "Conversation-local evaluator prompts"
has "$E" 'CE_DIMENSIONS.map' "All six evaluators invoked"
has "$E" 'initiate_local_evaluation_v1' "Local attempt initiation"
has "$E" 'complete_local_evaluation_v1' "Local atomic persistence"
has "$E" 'readBackLocalEvaluation' "Persistence read-back verification"
has "$E" 'company?.company_id ?? null' "Pre-canonical LLM usage has nullable company id"
not_has "$E" 'company?.company_id ?? "conversation-local"' "Invalid UUID observability marker removed"

# Frontend actually invokes the Edge then reloads persisted results.
has "$UI" 'supabase.functions.invoke("conversation-evaluate"' "Evaluate button invokes Edge"
has "$UI" 'await invokeCe({ action: "evaluate", conversation_id: id })' "Exact conversation evaluation call"
has "$UI" 'reload();' "Successful evaluation reloads list/detail"
has "$F" '.from("ce_local_evaluation")' "List/detail reads local evaluation"
has "$F" 'canonical_evaluation_id' "Pre-canonical mapping column reader"

# Pre-canonical schema only: no canonical rebind.
has "$S" 'ADD COLUMN IF NOT EXISTS canonical_evaluation_id uuid' "Mapping column additive schema"
has "$S" 'CREATE TABLE IF NOT EXISTS public.ce_local_canonical_map' "Mapping table additive schema"
not_has "$S" 'rebind_local_evaluations_v1(' "Task1 does not execute/define canonical rebind"
not_has "$S" 'UPDATE public.conversations' "Task1 does not bind conversation company"
not_has "$S" 'UPDATE public.ce_local_evaluation' "Task1 does not mutate existing evaluation rows"

has "$CFG" '[functions.conversation-evaluate]' "Edge config block exists"
has "$CFG" 'verify_jwt = true' "Conversation Evaluation gateway JWT remains enabled"

if [ "$fail" -ne 0 ]; then
  echo "PR22 TASK1 CE RUNTIME SOURCE STATUS: FAIL"
  exit 1
fi
echo "PR22 TASK1 CE RUNTIME SOURCE STATUS: PASS"
