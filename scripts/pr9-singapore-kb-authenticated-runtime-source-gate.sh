#!/bin/bash
set -Eeuo pipefail

RUNTIME="scripts/pr7-production-runtime-config-gate.sh"
CLIENT="supabase/functions/_shared/kb-client.ts"
SMOKE="scripts/pr9-singapore-kb-authenticated-runtime-smoke.sh"
FINAL="scripts/pr7-production-final-gate.sh"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

for f in "$RUNTIME" "$CLIENT" "$SMOKE" "$FINAL"; do
  [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }
done

must_have "$CLIENT" 'Deno.env.get("KB_SINGAPORE_JWT_TTL_SEC")' "kb-client canonical JWT TTL env"
must_have "$SMOKE" 'KB_SINGAPORE_JWT_TTL_SEC' "runtime smoke canonical JWT TTL env"
must_have "$RUNTIME" 'KB_SINGAPORE_JWT_TTL_SEC' "production gate canonical JWT TTL env"
must_not_have "$RUNTIME" 'KB_SINGAPORE_JWT_TTL_SECONDS' "legacy mismatched TTL env removed"

must_have "$SMOKE" '/api/v1/rag/context-search' "authenticated context-search exercised"
must_have "$SMOKE" '/api/entities/KBDocument/' "selected document metadata exercised"
must_have "$SMOKE" 'max_documents' "one-document request contract"
must_have "$SMOKE" 'max_summary' "summary request limit"
must_have "$SMOKE" 'max_full_chunks' "full-content request limit"
must_have "$SMOKE" 'meta.get("status") != "published"' "published metadata asserted"
must_have "$SMOKE" 'meta.get("production_status") != "production"' "production metadata asserted"
must_have "$SMOKE" 'meta.get("available_to_live_console") is not True' "live-console metadata asserted"
must_have "$SMOKE" 'meta.get("is_outdated") is True' "outdated metadata rejected"

must_have "$CLIENT" 'KB_CROSS_DOCUMENT_MISMATCH' "client cross-document fail-closed retained"
must_have "$CLIENT" 'KB_DOCUMENT_NOT_LIVE' "client live-document fail-closed retained"
must_have "$CLIENT" 'KB_AUTH_TENANT_MISMATCH' "client token tenant mismatch fail-closed retained"
must_have "$CLIENT" 'KB_AUTH_TOKEN_EXPIRED' "client expired token fail-closed retained"
must_have "$FINAL" 'pr9-singapore-kb-authenticated-runtime-smoke.sh' "production final gate runs PR9 authenticated smoke"

if [ "$fail" -ne 0 ]; then
  echo "TASK 9.1 SINGAPORE KB AUTHENTICATED RUNTIME SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 9.1 SINGAPORE KB AUTHENTICATED RUNTIME SOURCE STATUS: PASS"
