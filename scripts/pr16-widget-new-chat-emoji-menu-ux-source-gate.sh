#!/bin/bash
set -Eeuo pipefail
P="src/routes/_authenticated/console.widget-preview.tsx"
C="public/widget/chat.js"
fail=0
pass(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
for f in "$P" "$C"; do [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }; done
has "$P" 'New simulated conversation started. In the Live Widget this creates a new visitor session / conversation.' "Preview New Conversation effect visible"
has "$P" 'PREVIEW_EMOJIS' "Preview emoji catalogue"
has "$P" '<Smile className=' "Preview emoji control"
has "$P" 'document.addEventListener("pointerdown", closeOutside)' "Preview outside click close"
has "$P" 'document.addEventListener("contextmenu", closeOutside)' "Preview outside right-click close"
has "$P" 'event.key !== "Escape"' "Preview Escape close"
has "$C" 'New Conversation — starts a fresh chat session' "Production New Conversation purpose explicit"
has "$C" 'resetAndFresh();' "Production New Conversation real flow retained"
has "$C" 'nx-emoji-btn' "Production emoji control retained"
has "$C" 'toggleEmojiPanel' "Production emoji picker retained"
has "$C" 'document.addEventListener("contextmenu"' "Production outside right-click close"
has "$C" 'e.key !== "Escape"' "Production Escape close"
has "$C" 'Shared runtime v1.6.0 loaded' "Production runtime version"
node --check "$C" >/dev/null 2>&1 && pass "chat.js parser" || bad "chat.js parser"
if [ "$fail" -ne 0 ]; then
  echo "PR16 WIDGET NEW CHAT / EMOJI / MENU UX STATUS: FAIL"
  exit 1
fi
echo "PR16 WIDGET NEW CHAT / EMOJI / MENU UX STATUS: PASS"
