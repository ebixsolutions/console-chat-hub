#!/bin/bash
set -Eeuo pipefail

PROJECT_REF="${PR7_PROJECT_REF:-}"
EXPECTED_PROJECT_REF="hvmtoqiwdqvgnjepxwrc"
DB="${SUPABASE_DB_URL:-}"
A_TOKEN="${PR10_TENANT_A_BEARER_TOKEN:-}"
B_TOKEN="${PR10_TENANT_B_BEARER_TOKEN:-}"
A_USER="${PR10_TENANT_A_USER_UUID:-}"
B_USER="${PR10_TENANT_B_USER_UUID:-}"
A_COMPANY="${PR10_TENANT_A_COMPANY_UUID:-}"
B_COMPANY="${PR10_TENANT_B_COMPANY_UUID:-}"
A_CONV="${PR10_TENANT_A_CONVERSATION_UUID:-}"
B_CONV="${PR10_TENANT_B_CONVERSATION_UUID:-}"
A_AGENT="${PR10_TENANT_A_AGENT_PROFILE_UUID:-}"
B_AGENT="${PR10_TENANT_B_AGENT_PROFILE_UUID:-}"
APPROVED="${PR10_MUTATION_FIXTURES_APPROVED:-}"

stop(){ echo "STOP: $1"; exit 2; }
pass(){ echo "PASS $1"; }

[ "$PROJECT_REF" = "$EXPECTED_PROJECT_REF" ] || stop "project ref mismatch"
[ "$APPROVED" = "YES" ] || stop "mutation fixture approval missing"
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"

for v in "$A_USER" "$B_USER" "$A_COMPANY" "$B_COMPANY" "$A_CONV" "$B_CONV" "$A_AGENT" "$B_AGENT"; do
  [[ "$v" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "UUID fixture invalid"
done
[ "$A_COMPANY" != "$B_COMPANY" ] || stop "companies must differ"
[ "$A_CONV" != "$B_CONV" ] || stop "conversations must differ"
[ "$A_AGENT" != "$B_AGENT" ] || stop "agents must differ"
[ ${#A_TOKEN} -ge 20 ] || stop "Tenant A bearer token missing"
[ ${#B_TOKEN} -ge 20 ] || stop "Tenant B bearer token missing"

command -v curl >/dev/null 2>&1 || stop "curl missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

# Qualify real fixtures and elevated roles. This task intentionally performs
# ONLY denied writes; it never mutates an own-tenant conversation.
FIX="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' \
  -v au="$A_USER" -v bu="$B_USER" -v ac="$A_COMPANY" -v bc="$B_COMPANY" \
  -v ax="$A_CONV" -v bx="$B_CONV" -v aa="$A_AGENT" -v ba="$B_AGENT" <<'SQL'
SELECT
 EXISTS(SELECT 1 FROM public.company_membership WHERE user_id=:'au'::uuid AND company_id=:'ac'::uuid AND is_active AND role::text IN ('admin','supervisor')),
 EXISTS(SELECT 1 FROM public.company_membership WHERE user_id=:'bu'::uuid AND company_id=:'bc'::uuid AND is_active AND role::text IN ('admin','supervisor')),
 EXISTS(SELECT 1 FROM public.agent_profile WHERE id=:'aa'::uuid AND user_id=:'au'::uuid AND status='active'),
 EXISTS(SELECT 1 FROM public.agent_profile WHERE id=:'ba'::uuid AND user_id=:'bu'::uuid AND status='active'),
 EXISTS(SELECT 1 FROM public.conversations WHERE id=:'ax'::uuid AND company_id=:'ac'::uuid),
 EXISTS(SELECT 1 FROM public.conversations WHERE id=:'bx'::uuid AND company_id=:'bc'::uuid);
SQL
)"
[ "$FIX" = "t|t|t|t|t|t" ] || stop "mutation fixtures do not match real tenant ownership/elevated roles"
pass "real elevated mutation fixtures"

fingerprint(){
  local conv="$1"
  psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v cid="$conv" <<'SQL'
SELECT
  c.id::text,
  c.status::text,
  coalesce(c.assigned_agent_id::text,''),
  coalesce(c.updated_at::text,''),
  (SELECT count(*) FROM public.messages m WHERE m.conversation_id=c.id),
  (SELECT count(*) FROM public.conversation_assignment a WHERE a.conversation_id=c.id),
  (SELECT count(*) FROM public.conversation_assignment a WHERE a.conversation_id=c.id AND a.is_active=true),
  coalesce((SELECT string_agg(coalesce(a.agent_id::text,''),',' ORDER BY a.id::text)
            FROM public.conversation_assignment a WHERE a.conversation_id=c.id),'')
FROM public.conversations c
WHERE c.id=:'cid'::uuid;
SQL
}

A_BEFORE="$(fingerprint "$A_CONV")"
B_BEFORE="$(fingerprint "$B_CONV")"
[ -n "$A_BEFORE" ] && [ -n "$B_BEFORE" ] || stop "mutation fixture fingerprint failed"

BASE="https://${PROJECT_REF}.supabase.co/functions/v1"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

call(){
  local token="$1" endpoint="$2" body="$3" out="$4"
  curl --silent --show-error --max-time 60 \
    -o "$out" -w '%{http_code}' \
    -X POST "${BASE}/${endpoint}" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data "$body"
}

assert_error(){
  local file="$1" expected="$2" label="$3"
  python3 - "$file" "$expected" "$label" <<'PY'
import json,sys
f,expected,label=sys.argv[1:4]
try: d=json.load(open(f,encoding="utf-8"))
except Exception: raise SystemExit("STOP: "+label+" invalid JSON")
err=str(d.get("error",""))
if expected.lower() not in err.lower():
    raise SystemExit("STOP: "+label+" unexpected error")
print("PASS "+label)
PY
}

# ---------------------------------------------------------------------------
# 1. Foreign conversation writes: all must fail before service-role mutation RPC.
# ---------------------------------------------------------------------------
for spec in \
  "agent-send-reply|$A_TOKEN|$B_CONV|{\"conversation_id\":\"$B_CONV\",\"content\":\"PR10 denied cross-tenant write probe\"}|Conversation not found|A->B send reply" \
  "agent-send-reply|$B_TOKEN|$A_CONV|{\"conversation_id\":\"$A_CONV\",\"content\":\"PR10 denied cross-tenant write probe\"}|Conversation not found|B->A send reply" \
  "take-over-conversation|$A_TOKEN|$B_CONV|{\"conversation_id\":\"$B_CONV\"}|Conversation not found|A->B takeover" \
  "take-over-conversation|$B_TOKEN|$A_CONV|{\"conversation_id\":\"$A_CONV\"}|Conversation not found|B->A takeover" \
  "assign-conversation|$A_TOKEN|$B_CONV|{\"conversation_id\":\"$B_CONV\",\"target_agent_id\":\"$A_AGENT\"}|Conversation not found|A->B assignment" \
  "assign-conversation|$B_TOKEN|$A_CONV|{\"conversation_id\":\"$A_CONV\",\"target_agent_id\":\"$B_AGENT\"}|Conversation not found|B->A assignment" \
  "transfer-conversation|$A_TOKEN|$B_CONV|{\"conversation_id\":\"$B_CONV\",\"to_agent_id\":\"$A_AGENT\",\"reason\":\"PR10 denied cross-tenant probe\"}|Conversation not found|A->B transfer" \
  "transfer-conversation|$B_TOKEN|$A_CONV|{\"conversation_id\":\"$A_CONV\",\"to_agent_id\":\"$B_AGENT\",\"reason\":\"PR10 denied cross-tenant probe\"}|Conversation not found|B->A transfer"
do
  IFS='|' read -r endpoint token conv body expected label <<<"$spec"
  out="$TMP/$(echo "$label" | tr ' >' '__' | tr -cd '[:alnum:]_-').json"
  code="$(call "$token" "$endpoint" "$body" "$out")"
  [ "$code" = "404" ] || stop "$label expected HTTP 404, got $code"
  assert_error "$out" "$expected" "$label"
  grep -Fq "$conv" "$out" && stop "$label leaked foreign conversation id"
done
pass "all foreign-conversation write paths deny without identifier leakage"

# ---------------------------------------------------------------------------
# 2. Foreign target-agent writes on OWN conversations.
# Conversation scope passes, but target agent must still be non-enumerable 404.
# No assignment/transfer RPC may execute.
# ---------------------------------------------------------------------------
out="$TMP/a-assign-foreign-target.json"
code="$(call "$A_TOKEN" assign-conversation "{\"conversation_id\":\"$A_CONV\",\"target_agent_id\":\"$B_AGENT\"}" "$out")"
[ "$code" = "404" ] || stop "A assign foreign target expected 404, got $code"
assert_error "$out" "Target agent not found" "Tenant A cannot assign Tenant B agent"

out="$TMP/b-assign-foreign-target.json"
code="$(call "$B_TOKEN" assign-conversation "{\"conversation_id\":\"$B_CONV\",\"target_agent_id\":\"$A_AGENT\"}" "$out")"
[ "$code" = "404" ] || stop "B assign foreign target expected 404, got $code"
assert_error "$out" "Target agent not found" "Tenant B cannot assign Tenant A agent"

out="$TMP/a-transfer-foreign-target.json"
code="$(call "$A_TOKEN" transfer-conversation "{\"conversation_id\":\"$A_CONV\",\"to_agent_id\":\"$B_AGENT\",\"reason\":\"PR10 denied target-agent probe\"}" "$out")"
[ "$code" = "404" ] || stop "A transfer foreign target expected 404, got $code"
assert_error "$out" "Target agent not found" "Tenant A cannot transfer to Tenant B agent"

out="$TMP/b-transfer-foreign-target.json"
code="$(call "$B_TOKEN" transfer-conversation "{\"conversation_id\":\"$B_CONV\",\"to_agent_id\":\"$A_AGENT\",\"reason\":\"PR10 denied target-agent probe\"}" "$out")"
[ "$code" = "404" ] || stop "B transfer foreign target expected 404, got $code"
assert_error "$out" "Target agent not found" "Tenant B cannot transfer to Tenant A agent"

# ---------------------------------------------------------------------------
# 3. Hard no-write assertion.
# Conversation state, message count and assignment history must be byte-for-byte
# identical after every denied mutation attempt.
# ---------------------------------------------------------------------------
A_AFTER="$(fingerprint "$A_CONV")"
B_AFTER="$(fingerprint "$B_CONV")"
[ "$A_AFTER" = "$A_BEFORE" ] || stop "Tenant A state changed after denied cross-tenant mutation"
[ "$B_AFTER" = "$B_BEFORE" ] || stop "Tenant B state changed after denied cross-tenant mutation"

pass "denied mutation attempts produced zero conversation/message/assignment state change"
echo "TASK 10.3 CROSS-TENANT MUTATION/WRITE RUNTIME STATUS: PASS"
