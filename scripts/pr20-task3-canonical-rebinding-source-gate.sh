#!/bin/bash
set -Eeuo pipefail

F="src/lib/api/ce.functions.ts"
S="sql/pr20/pr20_ce_canonical_rebinding.sql"
R="sql/pr20/pr20_ce_canonical_rebinding.rollback.sql"
M="scripts/pr20-ce-local-to-canonical-migrate.sh"
D="scripts/pr7-production-deploy.sh"
P="scripts/pr7-production-final-gate.sh"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$F" "$S" "$R" "$M" "$D" "$P"; do
  [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }
done

has "$F" 'canonical_evaluation_id' "UI adapter recognizes local→canonical mapping"
has "$F" 'ce_local_canonical_map' "Canonical detail reads mapped historical local QA/Root Cause"
has "$F" 'remote_sync_state: r.remote_sync_state ?? "canonical_mapped"' "Mapped Root Cause provenance preserved"

has "$S" 'public.rebind_local_evaluations_v1' "Parameterized rebind function exists"
has "$S" 'public.initiate_evaluation_v2' "Migration reuses canonical initiation path"
has "$S" 'public.complete_evaluation_v2' "Migration reuses canonical completion path without LLM rerun"
has "$S" 'canonical_evaluation_id uuid' "Local→canonical link column exists"
has "$S" 'CREATE TABLE IF NOT EXISTS public.ce_local_canonical_map' "Local→canonical mapping table exists"
has "$S" 'company_membership' "Historical local data RLS is membership-scoped"
has "$S" 'REVOKE EXECUTE ON FUNCTION public.review_local_evaluation_v1' "Historical local review becomes read-only after activation"
has "$S" 'conversation_company_mismatch' "Rebind refuses wrong-company conversation lineage"
has "$S" 'PR20_CANONICAL_COMPLETE_FAILED' "Canonical completion failure aborts transaction"

has "$M" 'SET CONSTRAINTS ALL IMMEDIATE' "Canonical outbox trigger forced before migration commit"
has "$M" 'evaluation_training_outbox' "Exactly-one canonical training outbox asserted"
has "$M" 'delivery_idempotency_key IS DISTINCT FROM o.evaluation_id::text' "Training handoff idempotency asserted"
has "$M" 'cross-tenant local CE leak' "Runtime cross-tenant local CE denial asserted"
has "$M" 'without LLM recomputation' "Migration explicitly reuses stored evaluation"

has "$R" 'PR20_ROLLBACK_BLOCKED_CANONICAL_REBIND_EXISTS' "Schema rollback refuses destructive post-rebind removal"

# Production ordering: full runtime gate first, then the one atomic rebind
# transaction, and no fallible operation after successful rebind.
python3 - "$D" "$P" <<'PY' || { bad "production ordering / deferred READY contract"; }
import sys
d=open(sys.argv[1],encoding="utf-8").read()
p=open(sys.argv[2],encoding="utf-8").read()
pre=d.find('export PR20_DEFER_FINAL_READY="YES"')
final=d.find('bash scripts/pr7-production-final-gate.sh',pre)
migrate=d.find('bash scripts/pr20-ce-local-to-canonical-migrate.sh',final)
ready=d.rfind('FINAL STATUS: READY')
if min(pre,final,migrate,ready)<0 or not (pre < final < migrate < ready):
    raise SystemExit(1)
if 'PR20_DEFER_FINAL_READY' not in p or 'PRE-REBIND GATES PASS' not in p:
    raise SystemExit(1)
print("PASS full production gates precede atomic rebind and final READY")
PY

not_has "$D" '"sql/pr13/pr13_widget_launcher_icon.sql"\n' "literal backslash-n SQL inventory corruption removed"

if [ "$fail" -ne 0 ]; then
  echo "PR20 TASK3 CANONICAL REBINDING SOURCE STATUS: FAIL"
  exit 1
fi
echo "PR20 TASK3 CANONICAL REBINDING SOURCE STATUS: PASS"
