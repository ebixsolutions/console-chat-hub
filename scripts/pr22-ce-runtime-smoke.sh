#!/bin/bash
set -Eeuo pipefail

PROJECT_REF="${PR22_PROJECT_REF:-hvmtoqiwdqvgnjepxwrc}"
DB="${SUPABASE_DB_URL:-}"
TOKEN="${PR22_CE_SMOKE_ACCESS_TOKEN:-}"
CID="${PR22_CE_SMOKE_CONVERSATION_ID:-}"
ORIGIN="${PR22_CE_SMOKE_ORIGIN:-https://console-chat-hub.lovable.app}"
EXPECTED_VERSION="ce-conversation-first-1.0.0"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }
pass(){ echo "PASS $1"; }

[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
[ -n "$TOKEN" ] || stop "PR22_CE_SMOKE_ACCESS_TOKEN missing"
[[ "$CID" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "PR22_CE_SMOKE_CONVERSATION_ID invalid"
command -v curl >/dev/null 2>&1 || stop "curl missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

URL="https://${PROJECT_REF}.supabase.co/functions/v1/conversation-evaluate"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

HTTP="$(
  curl -sS -o "$TMP" -w '%{http_code}' \
    -X POST "$URL" \
    -H "Origin: $ORIGIN" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"action\":\"evaluate\",\"conversation_id\":\"$CID\"}"
)" || fail "Edge request failed"

[ "$HTTP" = "200" ] || {
  cat "$TMP"
  fail "conversation-evaluate HTTP $HTTP"
}

python3 - "$TMP" "$EXPECTED_VERSION" <<'PY' || exit 1
import json,sys
p=json.load(open(sys.argv[1]))
expected=sys.argv[2]
if p.get("runtime_version") != expected:
    print(p)
    raise SystemExit("runtime version mismatch")
if p.get("status") not in ("completed","already_evaluated"):
    print(p)
    raise SystemExit("evaluation status not completed")
print("PASS deployed Edge runtime version:", expected)
print("PASS evaluation status:", p.get("status"))
PY

# Machine assertions on the persisted scoring result.
psql "$DB" -v ON_ERROR_STOP=1 -v cid="$CID" -At <<'SQL' > /tmp/pr22_ce_smoke.txt
WITH e AS (
  SELECT *
  FROM public.ce_local_evaluation
  WHERE conversation_id=:'cid'::uuid
  ORDER BY created_at DESC
  LIMIT 1
), checks AS (
  SELECT
    e.id,
    (
      SELECT count(*) FROM public.ce_local_evaluation_detail d
      WHERE d.evaluation_id=e.id
    ) AS detail_count,
    (
      SELECT count(*) FROM public.ce_local_bundle_snapshot s
      WHERE s.attempt_id=e.attempt_id
    ) AS snapshot_count,
    round(
      e.accuracy_score*0.25
      + e.policy_score*0.20
      + e.tone_score*0.20
      + e.sales_score*0.15
      + e.context_score*0.10
      + (100-e.hallucination_risk_score)*0.10,
      2
    ) AS recomputed,
    e.overall_score,
    e.severity,
    CASE
      WHEN e.overall_score<60 THEN 'critical'
      WHEN e.overall_score<70 THEN 'high'
      WHEN e.overall_score<80 THEN 'medium'
      ELSE 'low'
    END AS expected_severity
  FROM e
)
SELECT
  CASE WHEN id IS NOT NULL THEN 'evaluation_pass' ELSE 'evaluation_fail' END || '|' ||
  CASE WHEN detail_count=6 THEN 'details_pass' ELSE 'details_fail:'||detail_count END || '|' ||
  CASE WHEN snapshot_count=1 THEN 'snapshot_pass' ELSE 'snapshot_fail:'||snapshot_count END || '|' ||
  CASE WHEN recomputed=overall_score THEN 'formula_pass' ELSE 'formula_fail' END || '|' ||
  CASE WHEN severity=expected_severity THEN 'severity_pass' ELSE 'severity_fail' END
FROM checks;
SQL

cat /tmp/pr22_ce_smoke.txt
grep -Fxq 'evaluation_pass|details_pass|snapshot_pass|formula_pass|severity_pass' \
  /tmp/pr22_ce_smoke.txt || fail "persisted CE assertions failed"

# Attempt must be succeeded.
psql "$DB" -v ON_ERROR_STOP=1 -v cid="$CID" -At <<'SQL' | grep -Fxq 'attempt_pass' \
  || fail "attempt status not succeeded"
SELECT CASE WHEN EXISTS(
  SELECT 1 FROM public.ce_local_evaluation_attempt
  WHERE conversation_id=:'cid'::uuid AND status='succeeded'
) THEN 'attempt_pass' ELSE 'attempt_fail' END;
SQL

pass "real conversation evaluated"
pass "six dimension rows persisted"
pass "overall formula exact"
pass "severity exact"
pass "immutable replay snapshot persisted"
echo "PR22 TASK1 CE RUNTIME SMOKE STATUS: PASS"
