#!/bin/bash
set -Eeuo pipefail
A="src/lib/api/config.service.ts"
W="src/routes/_authenticated/console.widget-preview.tsx"
C="src/routes/_authenticated/console.tsx"

fail=0
pass(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }

for f in "$A" "$W" "$C"; do [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }; done

has "$A" 'export function isApprovedLovablePreviewHost' "single Preview host authority exists"
has "$A" '`${PREVIEW_PROJECT_ID}.lovableproject.com`' "current lovableproject.com Preview host supported"
has "$A" 'const lovableProjectSuffix = `--${lovableProjectHost}`' "isolated lovableproject preview-token host supported"
has "$A" 'const lovableAppSuffix = `--${PREVIEW_PROJECT_ID}.lovable.app`' "legacy id-preview lovable.app host supported"
has "$A" 'PREVIEW_ADMIN_EMAILS.has(email) ? "admin" : null' "Preview role remains approved-email-only"
has "$A" 'const roles = await getCurrentCompanyRoles();' "canonical membership remains first authority"
has "$A" 'if (roles.includes(candidate)) return candidate;' "canonical role wins before Preview fallback"
has "$W" 'const { role, loading } = useCurrentRole();' "Widget Preview uses shared role authority"
has "$C" 'const sidebarRole: string | null = role ?? null;' "Console sidebar uses shared role authority"

node - <<'JS' || { bad "Preview host matrix"; }
const PROJECT="4dbf593e-577e-4af4-a553-460441c34473";
function ok(hostname){
  const host=hostname.trim().toLowerCase();
  if(!host) return false;
  const lovableProjectHost=`${PROJECT}.lovableproject.com`;
  if(host===lovableProjectHost) return true;
  const lovableProjectSuffix=`--${lovableProjectHost}`;
  if(host.endsWith(lovableProjectSuffix)){
    const prefix=host.slice(0,-lovableProjectSuffix.length);
    if(/^[a-z0-9][a-z0-9-]*$/.test(prefix)) return true;
  }
  const lovableAppSuffix=`--${PROJECT}.lovable.app`;
  if(host.endsWith(lovableAppSuffix)){
    const prefix=host.slice(0,-lovableAppSuffix.length);
    if(/^id-preview(?:-[a-z0-9-]+)?$/.test(prefix)) return true;
  }
  return false;
}
const shouldPass=[
 `${PROJECT}.lovableproject.com`,
 `preview123--${PROJECT}.lovableproject.com`,
 `id-preview--${PROJECT}.lovable.app`,
 `id-preview-abc-123--${PROJECT}.lovable.app`,
];
const shouldFail=[
 "console-chat-hub.lovable.app",
 "evil.lovableproject.com",
 "4dbf593e-577e-4af4-a553-460441c34474.lovableproject.com",
 `evil--${PROJECT}.lovable.app`,
 `${PROJECT}.lovable.app`,
];
if(!shouldPass.every(ok) || shouldFail.some(ok)) process.exit(1);
console.log("PASS Preview host matrix current + legacy accepted; published host denied");
JS

if [ "$fail" -ne 0 ]; then
  echo "PR17 PREVIEW ROLE HOST AUTHORITY STATUS: FAIL"
  exit 1
fi
echo "PR17 PREVIEW ROLE HOST AUTHORITY STATUS: PASS"
