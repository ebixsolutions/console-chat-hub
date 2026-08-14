#!/bin/bash
set -Eeuo pipefail
FILE="supabase/functions/_shared/kb-client.ts"
fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

[ -s "$FILE" ] || { echo "FAIL kb-client missing"; exit 1; }

must_have "$FILE" 'parseStringMapEnv("KB_SINGAPORE_TENANT_MAP_JSON")' "explicit Singapore tenant map is authoritative"
must_have "$FILE" 'const singaporeTenantId = tenantMap[String(company.id)]?.trim();' "mapping indexed by canonical AI company UUID"
must_have "$FILE" 'reason: "KB_TENANT_MAPPING_CONFIG_INVALID"' "invalid mapping fails closed"
must_have "$FILE" 'reason: "KB_TENANT_MAPPING_UNRESOLVED"' "missing mapping fails closed"
must_have "$FILE" 'reason: "KB_TENANT_IDENTITY_CONFLICT"' "conversation/channel company conflict fails closed"
must_have "$FILE" 'tenant_id: scope.singaporeTenantId' "Singapore JWT carries mapped tenant"
must_have "$FILE" 'company_id is intentionally omitted' "JWT never fabricates numeric Singapore company id"
must_have "$FILE" 'Never reinterpret external_tenant_id/external_workspace_id' "legacy external identifiers cannot become Singapore tenant"
must_not_have "$FILE" 'tenant_id: resolvedCompanyId' "AI company UUID never sent as Singapore tenant"
must_not_have "$FILE" 'singaporeTenantId: resolvedCompanyId' "AI company UUID never used as mapped tenant"

if [ "$fail" -ne 0 ]; then
  echo "TASK 4.1 KB MAPPING SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 4.1 KB MAPPING SOURCE STATUS: PASS"
