#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_REF='nrfxhqabwblzxoushgnm'
LEGACY_REF='hvmtoqiwdqvgnjepxwrc'
TARGET_ORIGIN="https://${TARGET_REF}.supabase.co"

fail(){ echo "FAIL: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }

for f in \
  .env \
  .lovable/mcp/manifest.json \
  src/integrations/supabase/runtime-authority.mjs \
  src/integrations/supabase/client.ts \
  src/integrations/supabase/client.server.ts; do
  [[ -s "$f" ]] || fail "missing/empty $f"
done

# Exact authoritative repo bindings.
grep -q "SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" .env || fail 'server project ref is not authoritative'
grep -q "VITE_SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" .env || fail 'client project ref is not authoritative'
grep -q "SUPABASE_URL=\"${TARGET_ORIGIN}\"" .env || fail 'server URL is not authoritative'
grep -q "VITE_SUPABASE_URL=\"${TARGET_ORIGIN}\"" .env || fail 'client URL is not authoritative'
grep -q "${TARGET_ORIGIN}/auth/v1" .lovable/mcp/manifest.json || fail 'Lovable MCP auth issuer is not authoritative'
pass 'authoritative target bindings'

# Active runtime surfaces must contain no legacy project ref. Historical backup,
# archived evidence and docs are intentionally excluded from this runtime gate.
if grep -R -n -F "$LEGACY_REF" .env .lovable src public supabase/functions \
  --exclude-dir=.git --exclude='*.map' >/tmp/task31-legacy-active.txt 2>/dev/null; then
  cat /tmp/task31-legacy-active.txt >&2
  fail 'legacy Supabase ref remains in active runtime source'
fi
pass 'active runtime legacy-ref scan = 0'

# Execute the actual fail-closed runtime authority guard, not a static source check.
node --input-type=module <<'NODE'
import { strict as assert } from 'node:assert';
import {
  AUTHORITATIVE_SUPABASE_PROJECT_ID,
  AUTHORITATIVE_SUPABASE_ORIGIN,
  assertAuthoritativeSupabaseRuntime,
} from './src/integrations/supabase/runtime-authority.mjs';

assert.equal(AUTHORITATIVE_SUPABASE_PROJECT_ID, 'nrfxhqabwblzxoushgnm');
assert.equal(AUTHORITATIVE_SUPABASE_ORIGIN, 'https://nrfxhqabwblzxoushgnm.supabase.co');
assert.equal(assertAuthoritativeSupabaseRuntime(AUTHORITATIVE_SUPABASE_ORIGIN, AUTHORITATIVE_SUPABASE_PROJECT_ID), true);
assert.throws(() => assertAuthoritativeSupabaseRuntime('https://hvmtoqiwdqvgnjepxwrc.supabase.co', AUTHORITATIVE_SUPABASE_PROJECT_ID), /Refusing non-authoritative/);
assert.throws(() => assertAuthoritativeSupabaseRuntime('https://another-project.supabase.co', AUTHORITATIVE_SUPABASE_PROJECT_ID), /Refusing non-authoritative/);
assert.throws(() => assertAuthoritativeSupabaseRuntime(AUTHORITATIVE_SUPABASE_ORIGIN, 'wrong-project'), /Refusing non-authoritative/);
assert.throws(() => assertAuthoritativeSupabaseRuntime('not-a-url', AUTHORITATIVE_SUPABASE_PROJECT_ID), /Invalid Supabase runtime URL/);
console.log('PASS: runtime authority positive/negative matrix');
NODE

# Both browser and server clients must call the same guard.
grep -q 'assertAuthoritativeSupabaseRuntime(SUPABASE_URL, SUPABASE_PROJECT_ID)' src/integrations/supabase/client.ts || fail 'browser client guard missing'
grep -q 'assertAuthoritativeSupabaseRuntime(SUPABASE_URL, SUPABASE_PROJECT_ID)' src/integrations/supabase/client.server.ts || fail 'server client guard missing'
pass 'browser/server runtime guard wiring'

npm run build
pass 'production client/SSR/Nitro build'

# Built runtime/public assets are the deployable truth for frontend/server routing.
if grep -R -n -F "$LEGACY_REF" .output >/tmp/task31-legacy-build.txt 2>/dev/null; then
  cat /tmp/task31-legacy-build.txt >&2
  fail 'legacy Supabase ref present in built runtime bundle'
fi
grep -R -q -F "$TARGET_REF" .output || fail 'authoritative target ref absent from built runtime bundle'
pass 'built runtime legacy-ref=0 and target-ref>0'

echo 'TASK 3.1 FINAL GATE: PASS'
