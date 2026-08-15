#!/bin/bash
set -Eeuo pipefail
F="src/lib/api/ce.functions.ts"
S="sql/pr24/pr24_ce_metadata_legacy_qa.sql"
R="sql/pr24/pr24_ce_metadata_legacy_qa.rollback.sql"
C="supabase/functions/_shared/ce-contract.ts"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$F" "$S" "$R" "$C"; do
  [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }
done

has "$S" 'ADD COLUMN IF NOT EXISTS customer_tier text' "Canonical customer_tier metadata field"
has "$S" 'ADD COLUMN IF NOT EXISTS intent text' "Canonical intent metadata field"
has "$S" 'ADD COLUMN IF NOT EXISTS language text' "Canonical language metadata field"
has "$S" 'metadata_source jsonb' "Metadata provenance field"
has "$S" 'Never inferred by Conversation Evaluation' "Metadata non-inference contract"

has "$F" 'resolveConversationMetadata' "Server resolves upstream metadata"
has "$F" '"conversations.customer_tier"' "Tier provenance retained"
has "$F" '"conversations.intent"' "Intent provenance retained"
has "$F" '"conversations.language"' "Language provenance retained"
has "$F" 'customer_tier: metadata.customer_tier.value' "List/detail exposes tier"
has "$F" 'intent: metadata.intent.value' "List/detail exposes intent"
has "$F" 'language: metadata.language.value' "List/detail exposes language"
has "$F" 'metadata_sources' "Metadata provenance exposed"

has "$S" 'CREATE TABLE IF NOT EXISTS public.ce_legacy_qa_metric' "Legacy QA compatibility table"
has "$S" 'empathy_score * 0.20' "Legacy Empathy 20%"
has "$S" 'policy_accuracy_score * 0.25' "Legacy Policy 25%"
has "$S" 'vip_awareness_score * 0.25' "Legacy VIP Awareness 25%"
has "$S" 'resolution_speed_score * 0.15' "Legacy Resolution 15%"
has "$S" 'context_score * 0.15' "Legacy Context 15%"
has "$F" 'legacyQaMetric' "Legacy QA returned separately from canonical evaluation"

python3 - "$F" "$C" <<'PY' || { bad "Legacy QA separation from canonical CE"; }
import sys
f=open(sys.argv[1],encoding="utf-8").read()
c=open(sys.argv[2],encoding="utf-8").read()
start=f.find("function suCoachReviewTrigger(args: {")
end=f.find("\nfunction addFinding(",start)
if start<0 or end<0: raise SystemExit(1)
review=f[start:end].lower()
if "legacy" in review or "empathy" in review or "vip_awareness" in review:
    raise SystemExit(1)
for marker in ["accuracy: 0.25","policy: 0.2","tone: 0.2","sales: 0.15","context: 0.1","hallucination_risk: 0.1"]:
    if marker not in c: raise SystemExit(marker)
print("PASS legacy QA is separate; six-evaluator contract frozen")
PY

has "$S" 'CE_LEGACY_QA_COMPANY_MISMATCH' "Legacy QA tenant lineage guard"
has "$R" 'PR24_ROLLBACK_BLOCKED_METADATA_EXISTS' "Rollback protects real metadata"
not_has "$S" 'UPDATE public.conversations' "No metadata values invented/backfilled by migration"
not_has "$S" 'INSERT INTO public.ce_legacy_qa_metric' "No fake legacy QA rows created"

if [ "$fail" -ne 0 ]; then
  echo "PR24 TASK3 METADATA / LEGACY QA STATUS: FAIL"
  exit 1
fi
echo "PR24 TASK3 METADATA / LEGACY QA STATUS: PASS"
