#!/bin/bash
set -Eeuo pipefail
F="src/lib/api/ce.functions.ts"
P="src/components/console/ce/CeDetailPanel.tsx"
S="sql/pr19/pr19_ce_local_detail_workflow.sql"
R="sql/pr19/pr19_ce_local_detail_workflow.rollback.sql"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$F" "$P" "$S" "$R"; do [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }; done

# Local detail read/write closure
has "$F" 'ce_local_root_cause' "Local Root Cause reader wired"
has "$F" 'ce_local_qa_case' "Local QA Case reader wired"
has "$F" 'ce_create_local_qa_case_v1' "Local QA Case writer wired"
has "$F" 'ce_record_local_root_cause_v1' "Local Root Cause writer wired"
not_has "$F" 'conversation_local_qa_pending_task2' "Task1 QA placeholder removed"
not_has "$F" 'conversation_local_root_cause_pending_task2' "Task1 Root Cause placeholder removed"

# Existing complete detail UX must remain intact
has "$P" 'type CeDetailTab = "overview" | "evaluation" | "emotion" | "nextSteps" | "replay"' "Five CE detail tabs retained"
has "$P" 'createCeQaCaseFn' "QA Case action retained"
has "$P" 'recordCeRootCauseFn' "Root Cause action retained"
has "$P" 'd?.discrepancies' "Discrepancy Analysis retained"
has "$P" 'd?.emotion' "Emotion Journey retained"
has "$P" 'd?.nextSteps' "Next Steps retained"
has "$P" 'snapshot.normalized_transcript' "Replay transcript retained"
has "$P" 'snapshot.canonical_input' "Replay canonical input retained"
has "$P" 'snapshot.grounding_evidence' "Replay grounding retained"
has "$P" 'submitCeReviewFn' "Review workflow retained"
not_has "$P" 'Training Ready' "No Training Ready UI in AI Chatbot"
not_has "$P" '>Trained<' "No Trained UI in AI Chatbot"

# DB authorization + integrity
has "$S" 'CREATE TABLE IF NOT EXISTS public.ce_local_qa_case' "Local QA storage exists"
has "$S" 'CREATE TABLE IF NOT EXISTS public.ce_local_root_cause' "Local Root Cause storage exists"
has "$S" "role::text IN ('admin','supervisor')" "Local mutations restricted to Admin/Supervisor"
has "$S" 'p_expected_conversation_id' "Mutation RPCs bind expected conversation"
has "$S" 'pg_advisory_xact_lock' "QA case numbering/idempotency serialized"
has "$S" "remote_sync_state text NOT NULL DEFAULT 'local_only'" "Local records explicitly remain local before Task3"
has "$R" 'PR19_ROLLBACK_BLOCKED_LOCAL_DETAIL_DATA_EXISTS' "Rollback protects real QA/Root Cause data"

if [ "$fail" -ne 0 ]; then
  echo "PR19 TASK2 FULL CE DETAIL WORKFLOW STATUS: FAIL"
  exit 1
fi
echo "PR19 TASK2 FULL CE DETAIL WORKFLOW STATUS: PASS"
