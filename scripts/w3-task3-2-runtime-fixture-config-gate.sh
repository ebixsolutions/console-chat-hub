#!/bin/bash
set -Eeuo pipefail
REPO="${W3_T3_3_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
CFG="$REPO/config/w3-task3-3-dev-identity.env"
stop(){ echo "STOP: $1" >&2; exit 2; }
[ -s "$CFG" ] || stop "DEV config missing"
# shellcheck disable=SC1090
source "$CFG"

for v in   PR10_TENANT_A_COMPANY_UUID PR10_TENANT_A_USER_UUID PR10_TENANT_A_AGENT_PROFILE_UUID   PR10_TENANT_A_VISITOR_SESSION_UUID PR10_TENANT_A_CONVERSATION_UUID   PR10_TENANT_B_COMPANY_UUID PR10_TENANT_B_USER_UUID PR10_TENANT_B_AGENT_PROFILE_UUID   PR10_TENANT_B_VISITOR_SESSION_UUID PR10_TENANT_B_CONVERSATION_UUID
do
  value="${!v:-}"
  [[ "$value" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "$v missing/invalid"
done

for v in PR10_TENANT_A_BEARER_TOKEN PR10_TENANT_B_BEARER_TOKEN          PR10_KB_TENANT_A_QUERY PR10_KB_TENANT_B_QUERY          PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID          KB_SINGAPORE_TENANT_MAP_JSON KB_SINGAPORE_TENANT_API_KEYS_JSON
do
  [ -n "${!v:-}" ] || stop "$v missing"
done

echo "PASS W3 Task 3.2 runtime fixture config complete"
