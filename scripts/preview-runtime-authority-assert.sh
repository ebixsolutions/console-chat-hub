#!/bin/bash
# Deterministic Preview/frontend Supabase runtime-authority assertion.
# Asserts the active Preview/frontend runtime binds ONLY to the authoritative
# user-owned Supabase project and retains no mixed/conflicting project ref.
set -Eeuo pipefail

TARGET="nrfxhqabwblzxoushgnm"
LEGACY="hvmtoqiwdqvgnjepxwrc"
fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }

# 1. Authoritative constant in runtime-authority module.
grep -Fq "AUTHORITATIVE_SUPABASE_PROJECT_ID = '${TARGET}'" \
  src/integrations/supabase/runtime-authority.mjs \
  && pass "runtime-authority authoritative project id" \
  || bad "runtime-authority authoritative project id"

# 2. Active env bindings (client + SSR fallbacks + functions base).
for k in SUPABASE_PROJECT_ID VITE_SUPABASE_PROJECT_ID; do
  grep -Eq "^${k}=\"?${TARGET}\"?$" .env && pass "$k" || bad "$k"
done
for k in SUPABASE_URL VITE_SUPABASE_URL; do
  grep -Eq "^${k}=\"?https://${TARGET}\.supabase\.co\"?$" .env && pass "$k" || bad "$k"
done
grep -Eq "^VITE_SUPABASE_FUNCTIONS_URL=\"?https://${TARGET}\.supabase\.co/functions/v1\"?$" .env \
  && pass "VITE_SUPABASE_FUNCTIONS_URL" || bad "VITE_SUPABASE_FUNCTIONS_URL"

# 3. Publishable keys must belong to the authoritative project (no legacy JWT ref).
for k in SUPABASE_PUBLISHABLE_KEY VITE_SUPABASE_PUBLISHABLE_KEY; do
  line=$(grep -E "^${k}=" .env || true)
  if [ -z "$line" ]; then bad "$k present"; continue; fi
  case "$line" in
    *"$LEGACY"*) bad "$k not bound to legacy project";;
    *) pass "$k not bound to legacy project";;
  esac
done

# 4. No mixed active authority in Preview/frontend runtime surfaces.
ACTIVE_FILES=(
  .env
  .lovable/mcp/manifest.json
  src/integrations/supabase/client.ts
  src/integrations/supabase/client.server.ts
  src/integrations/supabase/auth-middleware.ts
  src/integrations/supabase/auth-attacher.ts
  src/integrations/supabase/previewAuthStorage.ts
  src/integrations/supabase/runtime-authority.mjs
  src/lib/mcp/index.ts
)
for f in "${ACTIVE_FILES[@]}"; do
  if [ -f "$f" ] && grep -Fq "$LEGACY" "$f"; then
    bad "no legacy Supabase ref in $f"
  else
    pass "no legacy Supabase ref in $f"
  fi
done

# 5. Whole active src/ tree must be free of the legacy ref.
if grep -RFq --exclude-dir=node_modules "$LEGACY" src 2>/dev/null; then
  bad "src/ free of legacy Supabase ref"
else
  pass "src/ free of legacy Supabase ref"
fi

if [ "$fail" -ne 0 ]; then
  echo "PREVIEW RUNTIME AUTHORITY: FAIL"
  exit 1
fi
echo "PREVIEW RUNTIME AUTHORITY: PASS (${TARGET})"
