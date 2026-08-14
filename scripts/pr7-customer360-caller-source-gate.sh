#!/bin/bash
set -Eeuo pipefail
GEN="supabase/functions/generate-reply/index.ts"
ADAPTER="supabase/functions/customer360-adapter/index.ts"
fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

[ -s "$GEN" ] || { echo "FAIL generate-reply missing"; exit 1; }
[ -s "$ADAPTER" ] || { echo "FAIL customer360-adapter missing"; exit 1; }

must_have "$GEN" 'async function callCustomer360Adapter(conversation_id: string)' "real Customer360 caller exists"
must_have "$GEN" '/functions/v1/customer360-adapter' "caller targets internal adapter"
must_have "$GEN" '"X-Internal-Service-Token": internalToken' "caller authenticates with internal token"
must_have "$GEN" 'conversation_id,' "caller passes conversation only"
must_have "$GEN" '"masked_summary"' "caller requests masked summary"
must_have "$GEN" '"p1_provider_version"' "caller requests prediction provenance"
must_have "$GEN" 'C360_CALLER_TIMEOUT' "caller timeout fail-closed"
must_have "$GEN" 'C360_CALLER_INVALID_SCHEMA' "caller response schema fail-closed"
must_have "$GEN" 'const safeContext:' "caller re-allowlists adapter output"
must_have "$GEN" 'pseudonymizeRef(opaqueCustomerRef)' "opaque ref is pseudonymized before prompt"
must_not_have "$GEN" 'Current C360 Gate A is fail-closed' "old Customer360 stub removed"
must_not_have "$GEN" 'body: JSON.stringify({ customer_ref' "caller never sends customer_ref"

must_have "$ADAPTER" '"customer_ref",' "adapter forbids caller customer_ref scope"
must_have "$ADAPTER" 'metadata.customer_ref' "adapter resolves customer identity server-side"
must_have "$ADAPTER" 'sanitizeCustomerContext' "adapter sanitizes upstream response"

if [ "$fail" -ne 0 ]; then
  echo "TASK 5.2 CUSTOMER360 CALLER STATUS: FAIL"
  exit 1
fi
echo "TASK 5.2 CUSTOMER360 CALLER STATUS: PASS"
