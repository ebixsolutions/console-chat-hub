#!/bin/bash
set -Eeuo pipefail

FWD="sql/pr7/pr7_widget_theme_contract.sql"
RB="sql/pr7/pr7_widget_theme_contract.rollback.sql"
PUB="supabase/functions/get-public-widget-config/index.ts"
CHAT="public/widget/chat.js"
LEGACY="public/widget/chat-v2.js"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

for f in "$FWD" "$RB" "$PUB" "$CHAT" "$LEGACY"; do
  [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }
done

must_have "$FWD" "appearance_theme text" "theme column exists"
must_have "$FWD" "SET appearance_theme='classic'" "existing widgets migrate to classic"
must_have "$FWD" "SET DEFAULT 'classic'" "classic is default"
must_have "$FWD" "SET NOT NULL" "theme cannot be null"
must_have "$FWD" "appearance_theme IN ('classic','modern')" "theme enum-like constraint"
must_have "$FWD" "Presentation-only widget theme" "theme contract is presentation-only"
must_have "$RB" "modern/non-default theme is in use" "rollback blocks lossy theme removal"

# Public config already selects widget_config(*) through a company-bound channel,
# so the new column becomes available without weakening the tenant boundary.
must_have "$PUB" 'widget_config:widget_config_id(*)' "public config returns bound widget config"
must_have "$PUB" '.from("company")' "public config validates canonical company table"
must_have "$PUB" '.eq("id", data.company_id)' "public config validates canonical company id"
must_have "$PUB" 'company.is_active !== true' "public config rejects inactive company"
must_have "$PUB" 'validateWidgetOrigin(req, data.allowed_origins)' "origin guard preserved"

# Authoritative runtime remains chat.js. Task 6.1 deliberately does not alter
# either runtime file; Task 6.2 will add presentation switching to chat.js only.
must_have "$CHAT" "[NexusAI widget]" "authoritative chat.js runtime preserved"
must_have "$CHAT" 'window.__nexusChatLoaded' "single-load authoritative widget guard preserved"
must_have "$CHAT" 'data-channel-id' "authoritative widget channel contract preserved"
must_have "$CHAT" 'data-api-base' "authoritative widget API-base contract preserved"
must_have "$LEGACY" "fallback-" "legacy chat-v2 still identifiable as non-authoritative"
must_not_have "$CHAT" 'chat-v2.js' "authoritative chat.js does not depend on legacy v2"
must_not_have "$FWD" "channel_config" "theme migration does not alter channel ownership"

if [ "$fail" -ne 0 ]; then
  echo "TASK 6.1 WIDGET THEME CONTRACT STATUS: FAIL"
  exit 1
fi

echo "TASK 6.1 WIDGET THEME CONTRACT STATUS: PASS"
