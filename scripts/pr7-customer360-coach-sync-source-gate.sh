#!/bin/bash
set -Eeuo pipefail
SYNC="supabase/functions/customer360-coach-sync/index.ts"
C360="supabase/functions/customer360-adapter/index.ts"
SQL="sql/pr7/pr7_customer360_coach_sync_state.sql"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

for f in "$SYNC" "$C360" "$SQL"; do
  [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }
done

must_have "$C360" 'churn_risk?: number;' "Customer360 churn risk numeric contract"
must_have "$C360" 'value >= 1 && value <= 5' "predicted CSAT bounded 1..5"
must_have "$C360" 'value >= 0 && value <= 1' "risk/escalation score bounded 0..1"

must_have "$SQL" 'customer_ref_sha256 text NOT NULL' "sync state stores customer hash only"
must_not_have "$SQL" 'customer_ref text' "sync state stores no raw customer ref"
must_have "$SQL" 'UNIQUE INDEX IF NOT EXISTS uq_customer360_coach_sync_company_customer' "one sync row per company/customer"
must_have "$SQL" 'ENABLE ROW LEVEL SECURITY' "sync state RLS enabled"
must_have "$SQL" 'REVOKE ALL' "sync state not exposed to browser roles"

must_have "$SYNC" 'C360_COACH_SYNC_INTERNAL_TOKEN' "sync endpoint internal auth"
must_have "$SYNC" '/functions/v1/customer360-adapter' "sync reads canonical Customer360 adapter"
must_have "$SYNC" 'operation: "sync_customer_coaching_context"' "Coach sync operation explicit"
must_have "$SYNC" 'idempotency_key: outboundHash' "Coach receives deterministic idempotency key"
must_have "$SYNC" 'existing.outbound_payload_sha256 === outboundHash' "exact replay no-op"
must_have "$SYNC" 'coach_sync_company_mismatch' "Coach company mismatch fails closed"
must_have "$SYNC" 'coach_sync_customer_mismatch' "Coach customer mismatch fails closed"
must_have "$SYNC" 'sanitizeCoachSignals' "Coach return allowlisted"
must_have "$SYNC" 'FORBIDDEN_KEYS' "raw PII forbidden recursively"
must_have "$SYNC" '.upsert(row' "sync state update is deterministic"
must_not_have "$SYNC" '.from("visitor_session").update' "sync does not mutate visitor identity"
must_not_have "$SYNC" '.from("conversations").update' "sync does not mutate conversation"

if [ "$fail" -ne 0 ]; then
  echo "TASK 5.3 C360↔COACH SYNC SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 5.3 C360↔COACH SYNC SOURCE STATUS: PASS"
