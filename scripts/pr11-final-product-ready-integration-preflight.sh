#!/bin/bash
set -u
set -o pipefail
stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }
pass(){ echo "PASS $1"; }

EXPECTED_PROJECT_REF="hvmtoqiwdqvgnjepxwrc"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
PLATFORM_ID="${PR7_CANONICAL_PLATFORM_COMPANY_ID:-}"
COMPANY_SLUG="${PR7_CANONICAL_COMPANY_SLUG:-}"
COMPANY_NAME="${PR7_CANONICAL_COMPANY_NAME:-}"
EXT_WORKSPACE="${PR7_CANONICAL_EXTERNAL_WORKSPACE_ID:-}"
EXT_TENANT="${PR7_CANONICAL_EXTERNAL_TENANT_ID:-}"
PROJECT_REF="${PR7_PROJECT_REF:-}"
DB_URL="${SUPABASE_DB_URL:-}"
ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
ROLLBACK_COMMIT="${PR7_ROLLBACK_COMMIT:-}"
DEPLOY_AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
FINAL_AUTH="${PR11_FINAL_PRODUCT_READY_INTEGRATION_AUTHORIZED:-}"
BOOTSTRAP_RUN="${PR7_BOOTSTRAP_RUN_ID:-}"
MEMBERSHIP_RUN="${PR7_MEMBERSHIP_BOOTSTRAP_RUN_ID:-}"
CHANNEL_RUN="${PR7_CHANNEL_OWNERSHIP_RUN_ID:-}"
LINEAGE_RUN="${PR7_CONVERSATION_LINEAGE_RUN_ID:-}"
KB_MAP="${KB_SINGAPORE_TENANT_MAP_JSON:-}"
KB_SECRET="${KB_SINGAPORE_JWT_SECRET:-}"
LEGACY_SINGLE="${PR7_LEGACY_DATA_IS_SINGLE_COMPANY:-}"
ORPHAN_CONFIRM="${PR7_LEGACY_ORPHAN_CONVERSATIONS_BELONG_TO_CANONICAL_COMPANY:-}"

# No defaults, derivation or generation.
[ "$FINAL_AUTH" = "YES" ] || stop "PR11 final Product-ready integration authorization missing"
[ "$DEPLOY_AUTH" = "YES" ] || stop "production deploy authorization missing"
[ "$PROJECT_REF" = "$EXPECTED_PROJECT_REF" ] || stop "Supabase project ref mismatch"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$ACCESS_TOKEN" ] || stop "SUPABASE_ACCESS_TOKEN missing"
[ -n "$ROLLBACK_COMMIT" ] || stop "PR7_ROLLBACK_COMMIT missing"
[ -n "$COMPANY_UUID" ] || stop "real canonical SU Platform company UUID not supplied"
[ -n "$PLATFORM_ID" ] || stop "real canonical SU Platform integer company id not supplied"
[ -n "$COMPANY_SLUG" ] || stop "canonical company slug not supplied"
[ -n "$COMPANY_NAME" ] || stop "canonical company name not supplied"
[ -n "$EXT_WORKSPACE" ] || stop "canonical external workspace id not supplied"
[ -n "$EXT_TENANT" ] || stop "canonical external tenant id not supplied"

[[ "$COMPANY_UUID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || fail "canonical company UUID invalid"
[[ "$PLATFORM_ID" =~ ^[0-9]+$ ]] || fail "canonical platform company id must be integer"
[ "$PLATFORM_ID" -gt 0 ] || fail "canonical platform company id must be > 0"

for pair in \
  "PR7_BOOTSTRAP_RUN_ID:$BOOTSTRAP_RUN" \
  "PR7_MEMBERSHIP_BOOTSTRAP_RUN_ID:$MEMBERSHIP_RUN" \
  "PR7_CHANNEL_OWNERSHIP_RUN_ID:$CHANNEL_RUN" \
  "PR7_CONVERSATION_LINEAGE_RUN_ID:$LINEAGE_RUN"
do
  name="${pair%%:*}"; value="${pair#*:}"
  [[ "$value" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || fail "$name missing/invalid UUID"
done

[ "$LEGACY_SINGLE" = "YES" ] || stop "legacy single-company ownership confirmation missing"
[ "$ORPHAN_CONFIRM" = "YES" ] || stop "orphan-conversation ownership confirmation missing"
[ -n "$KB_MAP" ] || stop "Singapore KB tenant mapping missing"
[ ${#KB_SECRET} -ge 32 ] || stop "Singapore KB JWT secret missing/too short"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

PR11_COMPANY_UUID="$COMPANY_UUID" PR11_KB_MAP="$KB_MAP" python3 - <<'PY' || exit 1
import json,os,uuid
company=str(uuid.UUID(os.environ["PR11_COMPANY_UUID"]))
try: m=json.loads(os.environ["PR11_KB_MAP"])
except Exception: raise SystemExit("FAIL: KB_SINGAPORE_TENANT_MAP_JSON invalid JSON")
if not isinstance(m,dict): raise SystemExit("FAIL: KB_SINGAPORE_TENANT_MAP_JSON must be object")
tenant=m.get(company)
if not isinstance(tenant,str) or not tenant.strip():
    raise SystemExit("FAIL: real canonical company has no explicit Singapore tenant mapping")
print("PASS canonical company has explicit Singapore tenant mapping")
PY

for name in \
  PR10_TENANT_A_COMPANY_UUID PR10_TENANT_B_COMPANY_UUID \
  PR10_TENANT_A_USER_UUID PR10_TENANT_B_USER_UUID \
  PR10_TENANT_A_AGENT_PROFILE_UUID PR10_TENANT_B_AGENT_PROFILE_UUID \
  PR10_TENANT_A_CONVERSATION_UUID PR10_TENANT_B_CONVERSATION_UUID \
  PR10_TENANT_A_VISITOR_SESSION_UUID PR10_TENANT_B_VISITOR_SESSION_UUID
do
  value="${!name:-}"
  [[ "$value" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || stop "$name missing/invalid"
done
[ "${PR10_TENANT_A_COMPANY_UUID}" != "${PR10_TENANT_B_COMPANY_UUID}" ] || fail "two-tenant company fixtures must differ"

for name in \
  PR10_TENANT_A_BEARER_TOKEN PR10_TENANT_B_BEARER_TOKEN \
  PR10_KB_TENANT_A_QUERY PR10_KB_TENANT_B_QUERY \
  PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID
do
  [ -n "${!name:-}" ] || stop "$name missing"
done

[ "${PR10_TWO_TENANT_FIXTURES_APPROVED:-}" = "YES" ] || stop "two-tenant runtime fixture approval missing"
[ "${PR10_EDGE_API_FIXTURES_APPROVED:-}" = "YES" ] || stop "Edge/API runtime fixture approval missing"
[ "${PR10_MUTATION_FIXTURES_APPROVED:-}" = "YES" ] || stop "mutation runtime fixture approval missing"

for name in \
  PR8_CE_SMOKE_CONVERSATION_ID PR8_CE_SMOKE_BEARER_TOKEN \
  PR8_CE_HANDOFF_EVALUATION_ID PR8_CE_HANDOFF_CONVERSATION_ID PR8_CE_HANDOFF_BEARER_TOKEN \
  PR9_KB_SMOKE_QUERY PR11_PRIMARY_ACCEPTANCE_USER_UUID
do
  [ -n "${!name:-}" ] || stop "$name missing"
done
[ "${PR8_CE_SMOKE_FIXTURE_APPROVED:-}" = "YES" ] || stop "CE smoke fixture approval missing"
[ "${PR8_CE_HANDOFF_FIXTURE_APPROVED:-}" = "YES" ] || stop "CE handoff fixture approval missing"

pass "final Product-ready integration inputs complete"
echo "PR11 FINAL PRODUCT-READY INTEGRATION PREFLIGHT STATUS: PASS"
