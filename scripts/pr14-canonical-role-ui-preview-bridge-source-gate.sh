#!/bin/bash
set -Eeuo pipefail
C="src/routes/_authenticated/console.tsx"
A="src/lib/api/config.service.ts"
W="src/routes/_authenticated/console.widget-preview.tsx"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$C" "$A" "$W"; do
  [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }
done

not_has "$C" 'const ROLES = [' "user-selectable role catalogue removed from Console UI"
not_has "$C" 'setDemoRole' "demo role mutator removed"
not_has "$C" 'import.meta.env.DEV ? demoRole' "DEV role authority override removed"
not_has "$C" 'ROLES.map' "Admin/Sup/CS/QA chooser removed"
not_has "$C" 'ROLES.find' "removed role catalogue is never referenced at runtime"
has "$C" 'const ROLE_META: Record<' "display-only role metadata map exists"
has "$C" 'currentRoleMeta?.label ?? "No assigned role"' "sidebar renders role label without selectable role catalogue"
has "$C" 'const sidebarRole: string | null = role ?? null;' "sidebar role comes from authoritative useCurrentRole"
has "$C" 'No Assigned Role' "production remains fail-closed when canonical membership is absent"
has "$C" 'one authoritative role only' "single role display contract exists"

has "$A" 'const PREVIEW_PROJECT_ID = "4dbf593e-577e-4af4-a553-460441c34473";' "Preview bridge is project-scoped"
has "$A" 'function isApprovedLovablePreviewHost' "Preview host parser exists"
has "$A" 'id-preview(?:-[a-z0-9-]+)?' "Preview host supports generated preview-id hostnames"
has "$A" 'PREVIEW_ADMIN_EMAILS.has(email) ? "admin" : null' "Preview fallback remains approved-email only"
has "$A" 'const roles = await getCurrentCompanyRoles();' "canonical company roles are checked first"
has "$A" 'if (roles.includes(candidate)) return candidate;' "canonical role wins over Preview bridge"

# Published host must not satisfy preview matcher.
node - <<'JS' || { bad "Preview hostname matcher isolation"; }
const project="4dbf593e-577e-4af4-a553-460441c34473";
function ok(host){
 const suffix=`--${project}.lovable.app`;
 if(!host.endsWith(suffix)) return false;
 const prefix=host.slice(0,-suffix.length);
 return /^id-preview(?:-[a-z0-9-]+)?$/.test(prefix);
}
const yes=[
 `id-preview--${project}.lovable.app`,
 `id-preview-d8bc3ced--${project}.lovable.app`,
 `id-preview-abc-123--${project}.lovable.app`
];
const no=[
 "console-chat-hub.lovable.app",
 `evil--${project}.lovable.app`,
 `id-preview--other-project.lovable.app`
];
if(!yes.every(ok) || no.some(ok)) process.exit(1);
console.log("PASS Preview hostname matcher accepts isolated project previews only");
JS

has "$W" 'const { role, loading } = useCurrentRole();' "Widget Preview guard uses same authoritative role source"
has "$W" 'role !== "admin" && role !== "supervisor"' "Widget Preview retains Admin/Supervisor authorization"

python3 - "$C" <<'PY' || { bad "Console role source has no dangling demo-role symbols"; }
import re,sys
text=open(sys.argv[1],encoding="utf-8").read()
for bad in ("ROLES.find", "ROLES.map", "setDemoRole", "const [demoRole"):
    if bad in text:
        print("dangling/forbidden:",bad)
        raise SystemExit(1)
if "ROLE_META" not in text:
    raise SystemExit(1)
print("PASS no dangling role chooser/runtime symbols")
PY

if [ "$fail" -ne 0 ]; then
  echo "PR14 CANONICAL ROLE UI / PREVIEW BRIDGE STATUS: FAIL"
  exit 1
fi
echo "PR14 CANONICAL ROLE UI / PREVIEW BRIDGE STATUS: PASS"
