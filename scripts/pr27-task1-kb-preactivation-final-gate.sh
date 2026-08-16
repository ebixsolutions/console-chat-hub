#!/bin/bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail(){ echo "FAIL: $1"; exit 1; }
PASS=0
need(){ grep -Fq "$2" "$1" || fail "$1 missing marker: $2"; PASS=$((PASS+1)); }

need supabase/functions/_shared/kb-client.ts 'KB_PREACTIVATION_ENABLED'
need supabase/functions/_shared/kb-client.ts 'KB_PREACTIVATION_TENANT_ID'
need supabase/functions/_shared/kb-client.ts 'KB_PREACTIVATION_MEMBERSHIP_PRESENT'
need supabase/functions/_shared/kb-client.ts 'PREACTIVATION_ROLES = new Set(["admin", "supervisor"])'
need supabase/functions/_shared/kb-client.ts 'mode: "pre_activation", aiCompanyId: null'
need supabase/functions/_shared/kb-client.ts 'Canonical ALWAYS wins'
need supabase/functions/kb-search-proxy/index.ts 'allowPreActivation:true'
need supabase/functions/kb-search-proxy/index.ts 'scope.mode==="canonical"'
need supabase/functions/kb-search-proxy/index.ts 'tenant/company/industry/language/workspace scope must not be provided by client'
need supabase/functions/agent-assist/index.ts 'allowPreActivation:true'
need supabase/functions/agent-assist/index.ts 'tenant.scope.mode === "pre_activation"'
need supabase/functions/agent-assist/index.ts 'full-content policy evidence'

! grep -R -nE 'KB_DEMO_(TENANT_ID|MODE)' supabase/functions/kb-search-proxy/index.ts supabase/functions/agent-assist/index.ts >/dev/null || fail "pre-activation caller depends on KB_DEMO_*"
! grep -R -nE '(api[_-]?key|service[_-]?role[_-]?key|jwt[_-]?secret)[[:space:]]*[:=][[:space:]]*["'"'][^"'"']+["'"']' supabase/functions/_shared/kb-client.ts supabase/functions/kb-search-proxy/index.ts supabase/functions/agent-assist/index.ts >/dev/null || fail "possible hard-coded secret"

echo "PR27 TASK1 SOURCE GATE: PASS ($PASS assertions)"
