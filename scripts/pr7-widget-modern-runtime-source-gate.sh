#!/bin/bash
set -Eeuo pipefail

CHAT="public/widget/chat.js"
FWD="sql/pr7/pr7_widget_theme_default_modern.sql"
RB="sql/pr7/pr7_widget_theme_default_modern.rollback.sql"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

for f in "$CHAT" "$FWD" "$RB"; do
  [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }
done

# Theme/default contract.
must_have "$CHAT" 'return value === "classic" ? "classic" : "modern";' "modern runtime fallback is default"
must_have "$FWD" "SET DEFAULT 'modern'" "DB default promoted to modern"
must_have "$FWD" "SET appearance_theme='modern'" "initial classic defaults promoted to modern"
must_have "$FWD" "pr7_widget_theme_default_modern_provenance" "theme promotion provenance exists"
must_have "$RB" "ROLLBACK_BLOCKED: user/runtime theme state changed after promotion" "rollback drift guard"
must_have "$RB" "SET DEFAULT 'classic'" "rollback restores previous default"

# Modern assistant pane: right-side dock, split host layout, resizable, persistence.
must_have "$CHAT" '.nx-theme-modern .nx-panel{position:fixed;top:0;right:0;bottom:0;height:100vh' "modern panel docked full-height at right"
must_have "$CHAT" 'MODERN_MIN_WIDTH = 340' "modern minimum width defined"
must_have "$CHAT" 'MODERN_MAX_WIDTH = 720' "modern maximum width defined"
must_have "$CHAT" 'window.innerWidth * 0.55' "modern width capped to viewport"
must_have "$CHAT" 'SK_MODERN_WIDTH' "modern width persisted per channel"
must_have "$CHAT" 'nx-modern-divider' "modern draggable divider exists"
must_have "$CHAT" 'document.body.style.marginRight' "host layout is split, not overlay-only"
must_have "$CHAT" 'restoreHostSplit' "host layout restored on close"
must_have "$CHAT" '@media(max-width:640px)' "mobile responsive fallback"
must_have "$CHAT" 'width:100vw!important' "mobile modern panel is full width"

# Classic remains supported.
must_have "$CHAT" '.nx-theme-classic .nx-panel{position:fixed;right:20px;bottom:88px' "classic popup retained"
must_have "$CHAT" 'initClassicDrag' "classic drag retained"
must_have "$CHAT" 'initClassicResize' "classic resize retained"

# Frozen behavioral invariants: one shared runtime, no second send/poll implementation.
must_have "$CHAT" 'POLL_STEPS = [2500, 5000, 10000, 20000, 30000]' "adaptive polling cadence preserved"
must_have "$CHAT" 'generation: pollGeneration' "poll generation guard preserved"
must_have "$CHAT" 'catchUpPending' "poll catch-up guard preserved"
must_have "$CHAT" 'api("/widget-poll-messages"' "widget poll endpoint preserved"
must_have "$CHAT" 'method: "POST"' "POST widget protocol preserved"
must_have "$CHAT" 'api("/receive-widget-message"' "send endpoint preserved"
must_have "$CHAT" 'api("/create-visitor-session"' "session endpoint preserved"
must_have "$CHAT" 'after_message_id: lastMessageId || null' "lossless poll anchor preserved"
must_have "$CHAT" 'applyHumanSupportState(data.human_support)' "human handoff state preserved"
must_have "$CHAT" 'message.metadata.citations' "citation rendering preserved"
must_have "$CHAT" 'message.metadata.feedback_request === true' "feedback CTA preserved"
must_have "$CHAT" 'aiGenerating && state.handoffRequested' "AI/human race guard preserved"
must_not_have "$CHAT" 'Your message was received. AI reply not available yet.' "fabricated fallback not reintroduced"
must_not_have "$CHAT" 'chat-v2.js' "authoritative runtime does not depend on legacy v2"

if [ "$fail" -ne 0 ]; then
  echo "TASK 6.2 WIDGET MODERN RUNTIME STATUS: FAIL"
  exit 1
fi
echo "TASK 6.2 WIDGET MODERN RUNTIME STATUS: PASS"
