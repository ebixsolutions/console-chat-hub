#!/bin/bash
set -Eeuo pipefail
FILE="supabase/functions/customer360-adapter/index.ts"
fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

[ -s "$FILE" ] || { echo "FAIL customer360-adapter missing"; exit 1; }

must_have "$FILE" 'req.headers.get("X-Internal-Service-Token")' "internal-only service auth"
must_not_have "$FILE" "Access-Control-Allow-Origin" "no browser CORS"
must_have "$FILE" '"customer_ref",' "caller customer_ref explicitly forbidden"
must_have "$FILE" '.from("conversations")' "conversation is canonical entry point"
must_have "$FILE" '.from("company")' "canonical active company checked"
must_have "$FILE" '.from("visitor_session")' "visitor session identity source"
must_have "$FILE" 'metadata.customer_ref' "opaque customer ref resolved server-side"
must_have "$FILE" 'isApprovedOpaqueCustomerRef' "opaque customer ref validation"
must_have "$FILE" 'ENABLE_CUSTOMER360_ADAPTER' "feature flag retained"
must_have "$FILE" 'CUSTOMER360_API_URL' "upstream URL remains runtime config"
must_have "$FILE" 'CUSTOMER360_API_TOKEN' "upstream token remains runtime secret"
must_have "$FILE" 'Authorization": `Bearer ${upstreamToken}`' "server-to-server bearer auth"
must_have "$FILE" '"X-AI-Company-ID": companyId' "canonical company bound to upstream call"
must_have "$FILE" 'C360_CUSTOMER_IDENTITY_MISMATCH' "upstream customer mismatch fails closed"
must_have "$FILE" 'C360_TENANT_IDENTITY_MISMATCH' "upstream company mismatch fails closed"
must_have "$FILE" 'sanitizeCustomerContext' "response allowlist sanitizer"
must_have "$FILE" 'NEVER_RETURN' "never-return PII/secret list"
must_have "$FILE" 'C360_RESPONSE_TOO_LARGE' "response size guard"
must_have "$FILE" 'C360_TIMEOUT' "timeout handling"
must_have "$FILE" 'operation: "read_customer_context"' "adapter is read-only contract"
must_not_have "$FILE" '.update(' "adapter performs no AI Chatbot business-data updates"
must_not_have "$FILE" '.delete(' "adapter performs no deletes"

if [ "$fail" -ne 0 ]; then
  echo "TASK 5.1 CUSTOMER360 ADAPTER SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 5.1 CUSTOMER360 ADAPTER SOURCE STATUS: PASS"
