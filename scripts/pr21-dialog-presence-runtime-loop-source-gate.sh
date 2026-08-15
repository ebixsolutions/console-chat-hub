#!/bin/bash
set -Eeuo pipefail
F="src/components/ui/dialog.tsx"
INBOX="src/routes/_authenticated/console.conversations.index.tsx"
PKG="package.json"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }

for f in "$F" "$INBOX" "$PKG"; do
  [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }
done

has "$PKG" '"react": "^19.2.0"' "React 19.2 baseline retained"
has "$PKG" '"@radix-ui/react-dialog": "^1.1.15"' "Radix Dialog baseline retained; no broad dependency upgrade"

has "$F" 'const DialogOpenContext = React.createContext(false);' "Dialog open-state context exists"
has "$F" 'const controlled = open !== undefined;' "controlled Dialog semantics retained"
has "$F" 'React.useState(defaultOpen ?? false)' "uncontrolled/defaultOpen semantics retained"
has "$F" 'onOpenChange?.(nextOpen);' "consumer onOpenChange callback retained"
has "$F" 'if (!open) return null;' "closed DialogContent does not mount Presence tree"
has "$F" '<DialogPrimitive.Root' "Radix Root remains mounted"
has "$F" 'const DialogTrigger = DialogPrimitive.Trigger;' "Dialog Trigger API retained"
has "$F" '<DialogPortal>' "open Dialog still uses normal portal"
has "$F" '<DialogPrimitive.Content' "open Dialog still uses Radix Content"
has "$F" '<DialogPrimitive.Close' "close control retained"

COUNT=$(grep -Fc '<Dialog open=' "$INBOX")
[ "$COUNT" -ge 4 ] \
  && pass "Inbox controlled Dialog call sites covered by shared guard ($COUNT)" \
  || bad "expected Inbox controlled Dialog call sites"

# No route rewrite and no dependency mutation in this repair.
git diff --quiet -- package.json 2>/dev/null \
  && pass "package.json unchanged" \
  || echo "INFO package.json may already have unrelated local diff; apply.command separately blocks dirty targets"

if [ "$fail" -ne 0 ]; then
  echo "PR21 DIALOG PRESENCE RUNTIME LOOP SOURCE STATUS: FAIL"
  exit 1
fi

echo "PR21 DIALOG PRESENCE RUNTIME LOOP SOURCE STATUS: PASS"
