#!/bin/bash
set -Eeuo pipefail
CFG="src/lib/api/config.service.ts"
CONSOLE="src/routes/_authenticated/console.tsx"
fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

[ -s "$CFG" ] || { echo "FAIL missing $CFG"; exit 1; }
[ -s "$CONSOLE" ] || { echo "FAIL missing $CONSOLE"; exit 1; }

must_have "$CFG" 'async function resolvePreviewAcceptanceRole()' "Preview acceptance bridge exists"
must_have "$CFG" 'host.startsWith("id-preview--") && host.endsWith(".lovable.app")' "bridge restricted to Lovable id-preview host"
must_have "$CFG" 'host === "localhost" || host === "127.0.0.1"' "localhost acceptance supported"
must_have "$CFG" 'PREVIEW_ADMIN_EMAILS.has(email) ? "admin" : null' "bridge restricted to approved UAT admin emails"
must_have "$CFG" 'const roles = await getCurrentCompanyRoles();' "canonical membership checked first"
must_have "$CFG" 'return await resolvePreviewAcceptanceRole();' "preview role used only after canonical role unresolved"
must_have "$CFG" 'getCurrentUserRoles' "multi-role path covered"
must_have "$CONSOLE" 'const sidebarRole: string | null = import.meta.env.DEV ? demoRole : (role ?? null);' "Console continues to consume auth role outside DEV"
must_have "$CONSOLE" 'path: "/console/customer360"' "Customer 360 sidebar source present"
must_have "$CONSOLE" 'path: "/console/kb-gaps"' "Knowledge Helper sidebar source present"
must_have "$CONSOLE" 'path: "/console/visitor-analytics"' "Visitor Analytics sidebar source present"
must_have "$CONSOLE" 'path: "/console/settings/llm-runtime"' "LLM Runtime sidebar source present"

# Security guardrails: no production host bridge and no legacy role authority.
must_not_have "$CFG" 'console-chat-hub.lovable.app' "production Lovable host is not bridged"
must_not_have "$CFG" 'agent_profile.role' "legacy agent_profile role authority absent"
must_not_have "$CFG" '.from("agent_profile").select("role")' "no legacy profile-role query"

# The bridge must remain client-display only. Assert the authoritative server
# write/read ownership paths individually instead of using a brittle occurrence count.
must_have "$CFG" 'async function resolveCompanyScope(context:' "canonical company scope resolver exists"
must_have "$CFG" 'const scope = requireRole(' "server write paths retain canonical role enforcement"
must_have "$CFG" 'await resolveCompanyScope({' "server handlers call canonical company scope"
must_have "$CFG" '.eq("company_id", scope.data.companyId)' "channel operations remain company-scoped"
must_have "$CFG" 'async function resolveOwnedWidget(' "widget ownership resolver exists"
must_have "$CFG" 'let scope = await resolveCompanyScope(context);' "widget ownership uses canonical company scope"
must_have "$CFG" 'if (requireAdmin) scope = requireRole(scope, ["admin"]);' "widget admin write keeps canonical admin enforcement"
must_have "$CFG" 'const company = await resolveSingleActiveCompany({' "feedback read uses canonical active company"
must_have "$CFG" 'const scope = requireRole(' "feedback write keeps canonical role enforcement"

if [ "$fail" -ne 0 ]; then
  echo "PREVIEW ROLE ACCEPTANCE BRIDGE STATUS: FAIL"
  exit 1
fi
echo "PREVIEW ROLE ACCEPTANCE BRIDGE STATUS: PASS"
