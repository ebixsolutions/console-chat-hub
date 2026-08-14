#!/bin/bash
set -Eeuo pipefail
CFG="src/lib/api/config.service.ts"
PREVIEW="src/routes/_authenticated/console.widget-preview.tsx"
CHAT="public/widget/chat.js"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

for f in "$CFG" "$PREVIEW" "$CHAT"; do [ -s "$f" ] || { bad "missing $f"; }; done

must_have "$CFG" 'appearance_theme: "modern" | "classic"' "theme typed"
must_have "$CFG" 'appearance_theme: z.enum(["modern", "classic"]).optional()' "theme input validated"
must_have "$CFG" '"appearance_theme",' "theme patch field"
must_have "$CFG" 'widget_shared_or_unbound' "widget ownership fail closed"
must_have "$CFG" '["admin"]' "widget write admin-only"

must_have "$PREVIEW" 'useState<WidgetTheme>("modern")' "modern default UI"
must_have "$PREVIEW" 'badge="Default"' "modern marked default"
must_have "$PREVIEW" 'title={c.classic}' "classic secondary option"
must_have "$PREVIEW" 'appearance_theme: theme' "theme saved"
must_have "$PREVIEW" 'role !== "admin"' "supervisor read-only"
must_have "$PREVIEW" 'getWidgetConfig(selectedId)' "live widget config read"
must_have "$PREVIEW" 'min 340px' "modern min width described"
must_have "$PREVIEW" 'desktop resizable' "modern resizable described"
must_have "$PREVIEW" '/widget/chat.js' "single authoritative embed"
must_have "$PREVIEW" 'Do not use chat-v2.js' "legacy runtime rejected"
must_not_have "$PREVIEW" '/widget/chat-v2.js' "legacy runtime not embedded"
must_not_have "$PREVIEW" 'data-theme=' "no theme bypass"
must_not_have "$PREVIEW" 'MonitorRight' "unsupported icon absent"
must_not_have "$PREVIEW" 'MessageSquareMore' "optional icon absent"
must_not_have "$PREVIEW" '<Save ' "optional save icon absent"

must_have "$CHAT" 'return value === "classic" ? "classic" : "modern";' "runtime reads saved theme"
must_have "$CHAT" 'MODERN_MIN_WIDTH = 340' "runtime modern width contract"
must_have "$CHAT" 'document.body.style.marginRight' "runtime split layout"

if [ "$fail" -ne 0 ]; then
  echo "DIRECTOR TAKEOVER TASK 6.3 SOURCE STATUS: FAIL"
  exit 1
fi
echo "DIRECTOR TAKEOVER TASK 6.3 SOURCE STATUS: PASS"
