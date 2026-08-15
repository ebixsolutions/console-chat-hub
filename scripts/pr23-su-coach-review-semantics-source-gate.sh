#!/bin/bash
set -Eeuo pipefail

F="src/lib/api/ce.functions.ts"
C="supabase/functions/_shared/ce-contract.ts"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$F" "$C"; do
  [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }
done

has "$F" 'const SU_COACH_REVIEW_THRESHOLD = 75;' "SU Coach review threshold = 75"
has "$F" 'score_below_75' "Low-score review reason"
has "$F" 'hallucination_detected' "Hallucination review reason"
has "$F" 'policy_conflict_detected' "Policy-conflict review reason"
has "$F" 'conversation_pending' "Pending/escalation review reason"
has "$F" 'String(args.reviewStatus ?? "pending") !== "pending"' "Reviewed items leave Needs Review"
has "$F" '.from("ce_discrepancy")' "Canonical evaluator findings drive review semantics"
has "$F" '.from("ce_local_discrepancy")' "Local evaluator findings drive review semantics"
has "$F" '.in("dimension", ["hallucination", "policy"])' "Only hallucination/policy findings mapped to those triggers"
has "$F" 'needs_review_reasons: reviewTrigger.reasons' "List exposes review trigger provenance"
has "$F" 'rows = rows.filter((r) => r.needs_review);' "Needs Review tab uses unified semantics"

not_has "$F" 'Number(latest.overall_score) < 70' "Old local score<70 shortcut removed"
not_has "$F" 'Number(r.overall_score) < 70' "Old evaluation-list score<70 shortcut removed"
not_has "$F" 'canonicalNeedsReview' "Old canonical view-based divergent Needs Review removed"
not_has "$F" 'ce_conversation_status_v' "Old canonical <70 Needs Review view no longer used"

has "$C" 'accuracy: 0.25' "Accuracy weight unchanged"
has "$C" 'policy: 0.2' "Policy weight unchanged"
has "$C" 'tone: 0.2' "Tone weight unchanged"
has "$C" 'sales: 0.15' "Sales weight unchanged"
has "$C" 'context: 0.1' "Context weight unchanged"
has "$C" 'hallucination_risk: 0.1' "Hallucination weight unchanged"

# Python 3.9-safe deterministic function-body scan.
python3 - "$F" <<'PY' || { bad "Training Ready excluded from Needs Review semantics"; }
import sys

s = open(sys.argv[1], encoding="utf-8").read()
start_marker = "function suCoachReviewTrigger(args: {"
end_marker = "\nfunction addFinding("

start = s.find(start_marker)
if start < 0:
    raise SystemExit("suCoachReviewTrigger start not found")

end = s.find(end_marker, start)
if end < 0:
    raise SystemExit("suCoachReviewTrigger end not found")

body = s[start:end].lower()
if "training" in body:
    raise SystemExit("training state leaked into Needs Review trigger")

required = [
    "su_coach_review_threshold",
    "hallucination_detected",
    "policy_conflict_detected",
    "conversation_pending",
]
for marker in required:
    if marker not in body:
        raise SystemExit("missing marker: " + marker)

print("PASS Training Ready excluded from AI Chatbot review trigger")
PY

if [ "$fail" -ne 0 ]; then
  echo "PR23 TASK2 SU COACH REVIEW SEMANTICS STATUS: FAIL"
  exit 1
fi

echo "PR23 TASK2 SU COACH REVIEW SEMANTICS STATUS: PASS"
