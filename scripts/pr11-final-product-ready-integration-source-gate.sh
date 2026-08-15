#!/bin/bash
set -Eeuo pipefail
P="scripts/pr11-final-product-ready-integration-preflight.sh"
R="scripts/pr11-final-product-ready-integration-runner.sh"
A="scripts/pr11-canonical-role-acceptance.sh"
DEPLOY="scripts/pr7-production-deploy.sh"
BOOT="scripts/pr7-canonical-company-bootstrap.sh"
MEM="scripts/pr7-company-membership-bootstrap.sh"
CFG="src/lib/api/config.service.ts"
FINAL="scripts/pr11-whole-product-final-gate.sh"
LOCK="scripts/pr11-final-integration-source-lock.sh"
fail=0
pass(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$P" "$R" "$A" "$DEPLOY" "$BOOT" "$MEM" "$CFG" "$FINAL" "$LOCK"; do
  [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }
done

has "$P" 'PR7_CANONICAL_COMPANY_UUID' "preflight requires real canonical UUID"
has "$P" 'PR7_CANONICAL_PLATFORM_COMPANY_ID' "preflight requires real canonical integer company id"
has "$P" 'No defaults, derivation or generation.' "canonical identity explicitly non-derived"
not_has "$P" 'uuid.uuid4' "preflight never generates canonical UUID"
not_has "$P" 'external_tenant_id as' "preflight never aliases external tenant to canonical company"
not_has "$P" 'external_workspace_id as' "preflight never aliases workspace to canonical company"

has "$BOOT" 'existing company identity differs from supplied SU Platform UUID/integer mapping' "company bootstrap rejects identity mismatch"
has "$MEM" 'at least one active canonical admin is required' "membership bootstrap requires canonical admin"
has "$MEM" 'active cross-company membership conflict' "membership bootstrap rejects cross-company ambiguity"

has "$CFG" 'const roles = await getCurrentCompanyRoles();' "frontend role checks canonical membership first"
has "$CFG" 'if (roles.includes(candidate)) return candidate;' "canonical role wins before preview bridge"
has "$CFG" 'return await resolvePreviewAcceptanceRole();' "preview bridge remains fallback only"
has "$CFG" 'host.startsWith("id-preview--")' "preview bridge limited to isolated Preview"

has "$A" '[ "$MEMBERSHIP_COUNT" = "1" ]' "canonical acceptance requires exactly one membership"
has "$A" 'canonical role resolves without Preview fallback' "canonical acceptance explicitly closes No Assigned Role"

has "$R" 'bash scripts/pr11-final-integration-source-lock.sh' "integration runner requires authorized source lock"
has "$R" 'bash scripts/pr7-production-deploy.sh' "integration runner delegates writes to frozen atomic deploy"
not_has "$R" 'psql ' "integration runner contains no direct SQL writes"
not_has "$R" 'supabase functions deploy' "integration runner contains no direct Edge deploy"
has "$R" 'bash scripts/pr11-whole-product-final-gate.sh' "integration runner ends with whole-product final gate"

has "$DEPLOY" 'scripts/pr7-canonical-company-bootstrap.sh' "atomic deploy owns canonical company bootstrap"
has "$DEPLOY" 'scripts/pr7-company-membership-bootstrap.sh' "atomic deploy owns canonical membership bootstrap"
has "$DEPLOY" 'scripts/pr7-channel-ownership-bootstrap.sh' "atomic deploy owns channel ownership binding"
has "$DEPLOY" 'scripts/pr7-conversation-lineage-bootstrap.sh' "atomic deploy owns conversation lineage binding"
has "$DEPLOY" 'scripts/pr7-production-final-gate.sh' "atomic deploy owns production final acceptance"
has "scripts/pr7-production-runtime-config-gate.sh" 'two-tenant Singapore mappings missing or not distinct' "final integration runtime config supports two-tenant Singapore mappings"
has "scripts/pr12-product-ready-activation-loader.py" 'PR7_TEST_USER_A","PR10_TENANT_A_USER_UUID' "activation contract unifies legacy/final two-tenant fixtures"
has "scripts/pr12-product-ready-activate.command" 'pr12-product-ready-activation-loader.py' "one-command activation wrapper present"


if [ "$fail" -ne 0 ]; then
  echo "TASK 11.2 FINAL PRODUCT-READY INTEGRATION SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 11.2 FINAL PRODUCT-READY INTEGRATION SOURCE STATUS: PASS"
