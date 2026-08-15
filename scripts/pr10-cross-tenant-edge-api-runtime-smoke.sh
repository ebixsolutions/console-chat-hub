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
A_VISITOR="${PR10_TENANT_A_VISITOR_SESSION_UUID:-}"
B_VISITOR="${PR10_TENANT_B_VISITOR_SESSION_UUID:-}"
APPROVED="${PR10_EDGE_API_FIXTURES_APPROVED:-}"

stop(){ echo "STOP: $1"; exit 2; }
pass(){ echo "PASS $1"; }

[ "$PROJECT_REF" = "$EXPECTED_PROJECT_REF" ] || stop "project ref mismatch"
[ "$APPROVED" = "YES" ] || stop "Edge/API fixture approval missing"
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
for value in "$A_USER" "$B_USER" "$A_COMPANY" "$B_COMPANY" "$A_CONV" "$B_CONV" "$A_VISITOR" "$B_VISITOR"; do
  [[ "$value" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "UUID fixture invalid"
done
[ "$A_USER" != "$B_USER" ] || stop "user fixtures must differ"
[ "$A_COMPANY" != "$B_COMPANY" ] || stop "company fixtures must differ"
[ "$A_CONV" != "$B_CONV" ] || stop "conversation fixtures must differ"
[ "$A_VISITOR" != "$B_VISITOR" ] || stop "visitor fixtures must differ"
[ ${#A_TOKEN} -ge 20 ] || stop "Tenant A bearer token missing/too short"
[ ${#B_TOKEN} -ge 20 ] || stop "Tenant B bearer token missing/too short"
command -v curl >/dev/null 2>&1 || stop "curl missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

# Read-only fixture qualification. Customer360 requires admin/supervisor in
# user_roles plus one active canonical company membership.
FIX="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' \
  -v au="$A_USER" -v bu="$B_USER" -v ac="$A_COMPANY" -v bc="$B_COMPANY" \
  -v av="$A_VISITOR" -v bv="$B_VISITOR" -v ax="$A_CONV" -v bx="$B_CONV" <<'SQL'
SELECT
 EXISTS(SELECT 1 FROM public.company_membership
        WHERE user_id=:'au'::uuid AND company_id=:'ac'::uuid AND is_active),
 EXISTS(SELECT 1 FROM public.company_membership
        WHERE user_id=:'bu'::uuid AND company_id=:'bc'::uuid AND is_active),
 EXISTS(SELECT 1 FROM public.user_roles
        WHERE user_id=:'au'::uuid AND role::text IN ('admin','supervisor')),
 EXISTS(SELECT 1 FROM public.user_roles
        WHERE user_id=:'bu'::uuid AND role::text IN ('admin','supervisor')),
 EXISTS(SELECT 1 FROM public.conversations
        WHERE id=:'ax'::uuid AND company_id=:'ac'::uuid AND visitor_session_id=:'av'::uuid),
 EXISTS(SELECT 1 FROM public.conversations
        WHERE id=:'bx'::uuid AND company_id=:'bc'::uuid AND visitor_session_id=:'bv'::uuid);
SQL
)"
[ "$FIX" = "t|t|t|t|t|t" ] || stop "Edge/API fixtures do not match approved tenant ownership/roles"
pass "real Edge/API tenant fixtures"

BASE="https://${PROJECT_REF}.supabase.co/functions/v1"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

call_api(){
  local token="$1"; local endpoint="$2"; local body="$3"; local outfile="$4"
  curl --silent --show-error \
    --max-time 60 \
    -o "$outfile" \
    -w '%{http_code}' \
    -X POST "${BASE}/${endpoint}" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data "$body"
}

assert_json(){
  local file="$1"; local expr="$2"; local label="$3"
  python3 - "$file" "$expr" "$label" <<'PY'
import json,sys
path,expr,label=sys.argv[1:4]
try:
    data=json.load(open(path,encoding="utf-8"))
except Exception:
    raise SystemExit("STOP: "+label+" response is not JSON")
safe={"data":data}
try:
    ok=bool(eval(expr,{"__builtins__":{}},safe))
except Exception:
    ok=False
if not ok:
    raise SystemExit("STOP: "+label+" assertion failed")
print("PASS "+label)
PY
}

# ---------------------------------------------------------------------------
# Customer 360 positive controls: proves both authenticated tokens and company
# scopes are functional, not merely returning blanket denials.
# ---------------------------------------------------------------------------
A_OWN="$TMPDIR/a-c360-own.json"
B_OWN="$TMPDIR/b-c360-own.json"
code="$(call_api "$A_TOKEN" customer360-local "{\"mode\":\"detail\",\"visitor_session_id\":\"$A_VISITOR\"}" "$A_OWN")"
[ "$code" = "200" ] || stop "Tenant A Customer360 own positive control HTTP $code"
assert_json "$A_OWN" \
  'data.get("success") is True and data.get("scope",{}).get("company_id") == "'"$A_COMPANY"'" and data.get("customer",{}).get("visitor_session_id") == "'"$A_VISITOR"'"' \
  "Tenant A Customer360 own positive control"

code="$(call_api "$B_TOKEN" customer360-local "{\"mode\":\"detail\",\"visitor_session_id\":\"$B_VISITOR\"}" "$B_OWN")"
[ "$code" = "200" ] || stop "Tenant B Customer360 own positive control HTTP $code"
assert_json "$B_OWN" \
  'data.get("success") is True and data.get("scope",{}).get("company_id") == "'"$B_COMPANY"'" and data.get("customer",{}).get("visitor_session_id") == "'"$B_VISITOR"'"' \
  "Tenant B Customer360 own positive control"

# Customer360 cross-tenant detail must deliberately look like not-found.
A_X="$TMPDIR/a-c360-cross.json"
B_X="$TMPDIR/b-c360-cross.json"
code="$(call_api "$A_TOKEN" customer360-local "{\"mode\":\"detail\",\"visitor_session_id\":\"$B_VISITOR\"}" "$A_X")"
[ "$code" = "404" ] || stop "Tenant A->B Customer360 expected 404, got $code"
assert_json "$A_X" 'data.get("error") == "not_found"' "Tenant A cannot enumerate Tenant B Customer360"
grep -Fq "$B_VISITOR" "$A_X" && stop "Tenant A Customer360 denial leaked foreign visitor id"
pass "Tenant A Customer360 denial leaks no foreign visitor id"

code="$(call_api "$B_TOKEN" customer360-local "{\"mode\":\"detail\",\"visitor_session_id\":\"$A_VISITOR\"}" "$B_X")"
[ "$code" = "404" ] || stop "Tenant B->A Customer360 expected 404, got $code"
assert_json "$B_X" 'data.get("error") == "not_found"' "Tenant B cannot enumerate Tenant A Customer360"
grep -Fq "$A_VISITOR" "$B_X" && stop "Tenant B Customer360 denial leaked foreign visitor id"
pass "Tenant B Customer360 denial leaks no foreign visitor id"

# ---------------------------------------------------------------------------
# Agent Assist cross-tenant calls. grammar is selected because conversation
# boundary validation occurs BEFORE provider execution; foreign conversations
# must return 404 conversation_not_found and never reach provider/KB logic.
# ---------------------------------------------------------------------------
A_AA="$TMPDIR/a-agent-assist-cross.json"
B_AA="$TMPDIR/b-agent-assist-cross.json"
code="$(call_api "$A_TOKEN" agent-assist "{\"tool_type\":\"grammar\",\"conversation_id\":\"$B_CONV\",\"content\":\"Security runtime probe.\"}" "$A_AA")"
[ "$code" = "404" ] || stop "Tenant A->B Agent Assist expected 404, got $code"
assert_json "$A_AA" 'data.get("error") == "conversation_not_found"' "Tenant A Agent Assist foreign conversation denial"
grep -Fq "$B_CONV" "$A_AA" && stop "Tenant A Agent Assist denial leaked foreign conversation id"
pass "Tenant A Agent Assist denial leaks no foreign conversation id"

code="$(call_api "$B_TOKEN" agent-assist "{\"tool_type\":\"grammar\",\"conversation_id\":\"$A_CONV\",\"content\":\"Security runtime probe.\"}" "$B_AA")"
[ "$code" = "404" ] || stop "Tenant B->A Agent Assist expected 404, got $code"
assert_json "$B_AA" 'data.get("error") == "conversation_not_found"' "Tenant B Agent Assist foreign conversation denial"
grep -Fq "$A_CONV" "$B_AA" && stop "Tenant B Agent Assist denial leaked foreign conversation id"
pass "Tenant B Agent Assist denial leaks no foreign conversation id"

# ---------------------------------------------------------------------------
# Conversation Evaluation cross-tenant calls. resolveTenant() must reject
# membership before grounding, LLM calls, attempt creation or any CE writes.
# ---------------------------------------------------------------------------
A_CE="$TMPDIR/a-ce-cross.json"
B_CE="$TMPDIR/b-ce-cross.json"
code="$(call_api "$A_TOKEN" conversation-evaluate "{\"action\":\"evaluate\",\"conversation_id\":\"$B_CONV\"}" "$A_CE")"
[ "$code" = "403" ] || stop "Tenant A->B CE expected 403, got $code"
assert_json "$A_CE" 'data.get("error") == "forbidden" and data.get("detail") == "not_a_member"' "Tenant A CE foreign conversation denial"
grep -Fq "$B_CONV" "$A_CE" && stop "Tenant A CE denial leaked foreign conversation id"
pass "Tenant A CE denial leaks no foreign conversation id"

code="$(call_api "$B_TOKEN" conversation-evaluate "{\"action\":\"evaluate\",\"conversation_id\":\"$A_CONV\"}" "$B_CE")"
[ "$code" = "403" ] || stop "Tenant B->A CE expected 403, got $code"
assert_json "$B_CE" 'data.get("error") == "forbidden" and data.get("detail") == "not_a_member"' "Tenant B CE foreign conversation denial"
grep -Fq "$A_CONV" "$B_CE" && stop "Tenant B CE denial leaked foreign conversation id"
pass "Tenant B CE denial leaks no foreign conversation id"

echo "TASK 10.2 CROSS-TENANT EDGE/API RUNTIME STATUS: PASS"
