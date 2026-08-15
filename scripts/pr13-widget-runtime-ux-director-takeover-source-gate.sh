#!/bin/bash
set -Eeuo pipefail
P="src/routes/_authenticated/console.widget-preview.tsx"
C="public/widget/chat.js"
K="supabase/functions/kb-search-proxy/index.ts"
fail=0
pass(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$P" "$C" "$K"; do [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }; done

has "$P" 'fixed bottom-[max(24px,env(safe-area-inset-bottom))] right-6' "Preview launcher fixed to viewport bottom-right"
has "$P" 'Widget 1 Assistant sidecar preview' "Widget 1 uses dedicated right-side sidecar"
has "$P" 'translate-x-full pointer-events-none' "Widget 1 closed state lives off-canvas right"
has "$P" 'translate-x-0' "Widget 1 slides into view"
has "$P" 'lg:pr-[420px]' "Preview content yields desktop space to sidecar"
not_has "$P" 'Host website preview area' "fake Host Website preview removed"
has "$P" 'real AI / KB / handoff accuracy must be tested with the production Widget' "Preview truthfully separates UI simulation from real AI accuracy"
has "$P" '+ Request Human Support' "handoff UI test remains available"
not_has "$P" 'kb-search-proxy' "Widget Preview never calls KB proxy"
not_has "$P" 'supabase.functions.invoke' "Widget Preview makes no Edge Function calls"

has "$C" 'transform:translateX(100%)' "production Widget 1 starts off-canvas right"
has "$C" '.nx-theme-modern .nx-panel.nx-open{transform:translateX(0)' "production Widget 1 slides in"
has "$C" 'bottom:max(20px,env(safe-area-inset-bottom))' "production launcher remains viewport/safe-area anchored"
has "$C" 'applyHostSplit(open)' "production Widget 1 preserves sidecar host split behavior"

# Runtime error screenshot came from an old deployed KB proxy. Current source already
# supports standalone authenticated Admin/Supervisor scope when conversation_id is absent.
has "$K" 'resolveStandaloneScope' "current KB proxy source supports standalone company-scoped Knowledge Helper"
has "$K" 'if (rawConversationId !== undefined && rawConversationId !== null)' "conversation_id is optional in current source"
not_has "$K" 'valid conversation_id required' "obsolete deployed KB error string absent from source"

node --check "$C" >/dev/null 2>&1 && pass "production chat.js parser" || bad "production chat.js parser"

if [ "$fail" -ne 0 ]; then
  echo "PR13 DIRECTOR TAKEOVER WIDGET RUNTIME UX STATUS: FAIL"
  exit 1
fi
echo "PR13 DIRECTOR TAKEOVER WIDGET RUNTIME UX STATUS: PASS"
