#!/bin/bash
set -Eeuo pipefail
PREVIEW="src/routes/_authenticated/console.widget-preview.tsx"
SERVICE="src/lib/api/config.service.ts"
CHAT="public/widget/chat.js"
SQL="sql/pr13/pr13_widget_launcher_icon.sql"
RB="sql/pr13/pr13_widget_launcher_icon.rollback.sql"
DEPLOY="scripts/pr7-production-deploy.sh"
FINAL="scripts/pr7-production-final-gate.sh"
fail=0
pass(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }
for f in "$PREVIEW" "$SERVICE" "$CHAT" "$SQL" "$RB" "$DEPLOY" "$FINAL"; do [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }; done

# Preview cannot disappear just because canonical membership/channel is not active.
has "$PREVIEW" 'Preview must remain available even before canonical company activation.' "preview has canonical-company-independent fallback"
has "$PREVIEW" '<SimulatedWidget' "simulated widget remains rendered"
has "$PREVIEW" 'Preview-only mode' "preview-only state is explicit"
has "$PREVIEW" 'Live save requires canonical company activation' "live save remains fail-closed"
has "$PREVIEW" 'Widget 1 — Modern Assistant Panel' "Widget 1 option restored"
has "$PREVIEW" 'Widget 2 — Classic Popup' "Widget 2 option restored"
has "$PREVIEW" 'PRESET_COLORS' "primary-color controls restored"
has "$PREVIEW" 'LAUNCHER_ICONS' "bubble icon controls restored"
has "$PREVIEW" 'no visitor session, message, polling or production data writes' "preview isolation copy retained"
not_has "$PREVIEW" '<iframe' "preview does not mount unsafe live iframe"
not_has "$PREVIEW" 'create-visitor-session' "preview does not call production visitor-session API"
not_has "$PREVIEW" 'receive-widget-message' "preview does not call production message API"

# Service accepts schema both pre-activation and after migration.
has "$SERVICE" 'export type WidgetLauncherIcon' "safe launcher icon type exists"
has "$SERVICE" 'launcher_icon: WidgetLauncherIcon' "live widget model includes launcher icon"
has "$SERVICE" '.select("*")' "widget read tolerates pre-activation optional columns"
has "$SERVICE" 'normalizeWidgetRow' "widget read normalizes missing theme/icon defaults"
has "$SERVICE" 'launcher_icon: z.enum(["chat", "headset", "sparkles", "bot", "mail"])' "write accepts safe launcher enum only"

# Production runtime must use only the safe mapping; no raw config HTML injection.
has "$CHAT" 'function getLauncherIcon()' "production launcher icon resolver exists"
has "$CHAT" 'bubble.textContent = getLauncherIcon();' "production bubble uses safe textContent glyph"
not_has "$CHAT" 'bubble.innerHTML = "&#128172;"' "hardcoded production bubble removed"

# Persistence / rollback / deploy / final acceptance.
has "$SQL" "launcher_icon IN ('chat','headset','sparkles','bot','mail')" "DB launcher icon check constraint"
has "$SQL" 'Never stores raw HTML, SVG, JavaScript, or user markup.' "DB field has safe-content contract"
has "$RB" 'DROP COLUMN IF EXISTS launcher_icon' "launcher migration rollback exists"
has "$DEPLOY" 'sql/pr13/pr13_widget_launcher_icon.sql' "production deploy includes launcher migration"
has "$DEPLOY" 'sql/pr13/pr13_widget_launcher_icon.rollback.sql' "production rollback includes launcher rollback"
has "$FINAL" "launcher_icon NOT IN ('chat','headset','sparkles','bot','mail')" "production final gate validates launcher values"
has "$FINAL" "column_name='launcher_icon'" "production final gate requires launcher column"

node --check "$CHAT" >/dev/null 2>&1 && pass "production chat.js parser" || bad "production chat.js parser"

if [ "$fail" -ne 0 ]; then
  echo "PR13 WIDGET SETTINGS / BUBBLE DEBUG SOURCE STATUS: FAIL"
  exit 1
fi
echo "PR13 WIDGET SETTINGS / BUBBLE DEBUG SOURCE STATUS: PASS"
