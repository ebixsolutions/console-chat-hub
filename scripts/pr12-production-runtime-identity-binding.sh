#!/bin/bash
set -Eeuo pipefail

DB="${SUPABASE_DB_URL:-}"
CID="${PR7_CANONICAL_COMPANY_UUID:-}"
AC="${PR10_TENANT_A_COMPANY_UUID:-}"
BC="${PR10_TENANT_B_COMPANY_UUID:-}"
AU="${PR10_TENANT_A_USER_UUID:-}"
BU="${PR10_TENANT_B_USER_UUID:-}"
AT="${PR10_TENANT_A_BEARER_TOKEN:-}"
BT="${PR10_TENANT_B_BEARER_TOKEN:-}"
CECID="${PR8_CE_SMOKE_CONVERSATION_ID:-}"
CET="${PR8_CE_SMOKE_BEARER_TOKEN:-}"
HEID="${PR8_CE_HANDOFF_EVALUATION_ID:-}"
HCID="${PR8_CE_HANDOFF_CONVERSATION_ID:-}"
HET="${PR8_CE_HANDOFF_BEARER_TOKEN:-}"
PRIMARY="${PR11_PRIMARY_ACCEPTANCE_USER_UUID:-}"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }
pass(){ echo "PASS $1"; }

[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

for pair in \
  "PR7_CANONICAL_COMPANY_UUID:$CID" \
  "PR10_TENANT_A_COMPANY_UUID:$AC" \
  "PR10_TENANT_B_COMPANY_UUID:$BC" \
  "PR10_TENANT_A_USER_UUID:$AU" \
  "PR10_TENANT_B_USER_UUID:$BU" \
  "PR8_CE_SMOKE_CONVERSATION_ID:$CECID" \
  "PR8_CE_HANDOFF_EVALUATION_ID:$HEID" \
  "PR8_CE_HANDOFF_CONVERSATION_ID:$HCID" \
  "PR11_PRIMARY_ACCEPTANCE_USER_UUID:$PRIMARY"
do
  name="${pair%%:*}"; value="${pair#*:}"
  [[ "$value" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "$name missing/invalid"
done

[ "$AC" != "$BC" ] || fail "Tenant A/B companies must differ"
[ "$AU" != "$BU" ] || fail "Tenant A/B users must differ"
[ -n "$AT" ] && [ -n "$BT" ] && [ -n "$CET" ] && [ -n "$HET" ] || stop "bearer fixture missing"

decode_sub(){
  local token="$1"
  TOKEN="$token" python3 - <<'PY'
import base64,json,os,sys,uuid
t=os.environ["TOKEN"]
parts=t.split(".")
if len(parts)<2:
    raise SystemExit(2)
p=parts[1] + "="*((4-len(parts[1])%4)%4)
try:
    d=json.loads(base64.urlsafe_b64decode(p.encode()))
    s=str(uuid.UUID(str(d.get("sub",""))))
except Exception:
    raise SystemExit(2)
print(s)
PY
}

A_SUB="$(decode_sub "$AT")" || stop "Tenant A bearer JWT sub invalid"
B_SUB="$(decode_sub "$BT")" || stop "Tenant B bearer JWT sub invalid"
CE_SUB="$(decode_sub "$CET")" || stop "CE smoke bearer JWT sub invalid"
HE_SUB="$(decode_sub "$HET")" || stop "CE handoff bearer JWT sub invalid"

[ "$A_SUB" = "$AU" ] || fail "Tenant A bearer subject != declared Tenant A user"
[ "$B_SUB" = "$BU" ] || fail "Tenant B bearer subject != declared Tenant B user"
pass "PR10 bearer subjects exactly match declared tenant users"

[ "${PR7_TEST_USER_A:-}" = "$AU" ] || fail "PR7_TEST_USER_A != PR10 Tenant A user"
[ "${PR7_TEST_COMPANY_A:-}" = "$AC" ] || fail "PR7_TEST_COMPANY_A != PR10 Tenant A company"
[ "${PR7_TEST_USER_B:-}" = "$BU" ] || fail "PR7_TEST_USER_B != PR10 Tenant B user"
[ "${PR7_TEST_COMPANY_B:-}" = "$BC" ] || fail "PR7_TEST_COMPANY_B != PR10 Tenant B company"
pass "legacy PR7 RLS fixtures equal PR10 tenant fixtures"

ROW="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' \
  -v cid="$CID" -v ac="$AC" -v bc="$BC" -v au="$AU" -v bu="$BU" \
  -v cecid="$CECID" -v cesub="$CE_SUB" -v heid="$HEID" -v hcid="$HCID" -v hesub="$HE_SUB" \
  -v primary="$PRIMARY" <<'SQL'
SELECT
  EXISTS(SELECT 1 FROM public.company WHERE id=:'cid'::uuid AND is_active),
  EXISTS(SELECT 1 FROM public.company_membership WHERE company_id=:'ac'::uuid AND user_id=:'au'::uuid AND is_active),
  EXISTS(SELECT 1 FROM public.company_membership WHERE company_id=:'bc'::uuid AND user_id=:'bu'::uuid AND is_active),

  EXISTS(
    SELECT 1
    FROM public.conversations c
    JOIN public.company_membership cm
      ON cm.company_id=c.company_id
     AND cm.user_id=:'cesub'::uuid
     AND cm.is_active
    WHERE c.id=:'cecid'::uuid
      AND c.company_id IS NOT NULL
  ),

  EXISTS(
    SELECT 1
    FROM public.conversation_evaluation e
    JOIN public.conversations c ON c.id=e.conversation_id
    JOIN public.company_membership cm
      ON cm.company_id=e.company_id
     AND cm.user_id=:'hesub'::uuid
     AND cm.is_active
    WHERE e.id=:'heid'::uuid
      AND e.conversation_id=:'hcid'::uuid
      AND c.id=:'hcid'::uuid
      AND c.company_id=e.company_id
  ),

  (SELECT count(*) FROM public.company_membership
   WHERE company_id=:'cid'::uuid AND user_id=:'primary'::uuid AND is_active),

  EXISTS(SELECT 1 FROM public.company_membership
         WHERE company_id=:'cid'::uuid AND user_id=:'primary'::uuid
           AND role='admin'::public.app_role AND is_active);
SQL
)"
IFS='|' read -r CANONICAL_OK A_MEMBER B_MEMBER CE_MEMBER HE_MEMBER PRIMARY_COUNT PRIMARY_ADMIN <<<"$ROW"

[ "$CANONICAL_OK" = "t" ] || stop "canonical production company inactive/missing"
[ "$A_MEMBER" = "t" ] || fail "Tenant A bearer user is not active member of declared Tenant A company"
[ "$B_MEMBER" = "t" ] || fail "Tenant B bearer user is not active member of declared Tenant B company"
[ "$CE_MEMBER" = "t" ] || fail "CE smoke bearer subject is not an active member of CE conversation company"
[ "$HE_MEMBER" = "t" ] || fail "CE handoff bearer subject/evaluation/conversation/company binding invalid"
[ "$PRIMARY_COUNT" = "1" ] || fail "primary acceptance user must have exactly one canonical membership"
[ "$PRIMARY_ADMIN" = "t" ] || fail "primary acceptance user must be canonical admin"

pass "PR10 bearer users are active members of their declared companies"
pass "CE smoke bearer is bound to CE conversation company"
pass "CE handoff bearer/evaluation/conversation/company binding"
pass "primary acceptance user exactly-one canonical admin membership"

# Do not print token values, JWT payloads, company IDs, user IDs or fixture IDs.
echo "TASK 12.3 PRODUCTION RUNTIME IDENTITY BINDING STATUS: PASS"
