#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_REF="nrfxhqabwblzxoushgnm"
TARGET_ORIGIN="https://${TARGET_REF}.supabase.co"
TARGET_FUNCTIONS="${TARGET_ORIGIN}/functions/v1"
LEGACY_REF="hvmtoqiwdqvgnjepxwrc"

fail(){ echo "FAIL: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }

for f in \
  .env \
  src/integrations/supabase/runtime-authority.mjs \
  src/integrations/supabase/client.ts \
  src/integrations/supabase/client.server.ts \
  src/integrations/supabase/previewAuthStorage.ts \
  src/routes/login.tsx \
  src/routes/feedback.tsx \
  src/routes/_authenticated/console.conversations.index.tsx \
  src/routes/_authenticated/console.conversations.\$id.tsx \
  src/routes/_authenticated/console.widget-preview.tsx \
  src/routes/_authenticated/console.conversation-evaluation.index.tsx; do
  [[ -s "$f" ]] || fail "missing/empty $f"
done

for expected in \
  "SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" \
  "SUPABASE_URL=\"${TARGET_ORIGIN}\"" \
  "VITE_SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" \
  "VITE_SUPABASE_URL=\"${TARGET_ORIGIN}\"" \
  "VITE_SUPABASE_FUNCTIONS_URL=\"${TARGET_FUNCTIONS}\""; do
  grep -Fq "$expected" .env || fail "missing authoritative env binding: $expected"
done
PUBLISHABLE_KEY="$(sed -n 's/^SUPABASE_PUBLISHABLE_KEY="\([^"]*\)"$/\1/p' .env | head -n1)"
[[ -n "$PUBLISHABLE_KEY" ]] || fail "missing public Supabase publishable key"
[[ "$PUBLISHABLE_KEY" == sb_publishable_* ]] || fail "unexpected publishable key format"
pass "Lovable preview env bindings"

if grep -R --line-number --fixed-strings "$LEGACY_REF" src public .env \
  --exclude-dir='.chatgpt-backup' --exclude-dir='.replacement-backup' --exclude-dir='.t2-3-write-proof-chain-backup-*' >/tmp/task32_legacy_hits.txt; then
  cat /tmp/task32_legacy_hits.txt >&2
  fail "legacy Supabase ref remains in active frontend/runtime source"
fi
pass "active frontend/runtime legacy-ref scan = 0"

node --input-type=module <<'NODE'
import {
  AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN,
  assertAuthoritativeFunctionsRuntime,
  assertAuthoritativeSupabaseRuntime,
  authoritativeFunctionsBase,
} from './src/integrations/supabase/runtime-authority.mjs';
const target='https://nrfxhqabwblzxoushgnm.supabase.co';
const functions=target+'/functions/v1';
if (!assertAuthoritativeSupabaseRuntime(target,'nrfxhqabwblzxoushgnm')) process.exit(2);
if (!assertAuthoritativeFunctionsRuntime(functions)) process.exit(3);
if (AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN !== functions) process.exit(4);
if (authoritativeFunctionsBase(functions + '/') !== functions) process.exit(5);
for (const [kind,value] of [
  ['db','https://hvmtoqiwdqvgnjepxwrc.supabase.co'],
  ['fn','https://hvmtoqiwdqvgnjepxwrc.supabase.co/functions/v1'],
  ['fn','https://nrfxhqabwblzxoushgnm.supabase.co/functions/v1/other'],
]) {
  let blocked=false;
  try { kind==='db' ? assertAuthoritativeSupabaseRuntime(value) : assertAuthoritativeFunctionsRuntime(value); }
  catch { blocked=true; }
  if (!blocked) process.exit(10);
}
NODE
pass "DB/Auth/Edge authority positive-negative matrix"

grep -q 'supabase.auth.signInWithOAuth' src/routes/login.tsx || fail "Google OAuth is not direct Supabase Auth"
if grep -Eq '@/integrations/lovable|lovable\.auth|createLovableAuth' src/routes/login.tsx; then
  fail "login still depends on Lovable Cloud Auth"
fi
grep -q 'authoritativeFunctionsBase' src/routes/feedback.tsx || fail "feedback Edge binding not authoritative"
grep -q 'assertAuthoritativeFunctionsRuntime' src/integrations/supabase/client.ts || fail "preview client does not validate Edge Functions binding"
pass "login and public Edge calls rebound"

grep -Eq 'integrations/supabase/client|lib/api/' src/routes/_authenticated/console.conversations.index.tsx || fail "Inbox source not connected to guarded data layer"
grep -Eq 'integrations/supabase/client|lib/api/' src/routes/_authenticated/console.conversations.\$id.tsx || fail "conversation/Agent Assist source not connected to guarded data layer"
grep -Eq 'integrations/supabase/client|lib/api/' src/routes/_authenticated/console.widget-preview.tsx || fail "Widget preview source not connected to guarded data layer"
grep -Eq 'integrations/supabase/client|lib/api/' src/routes/_authenticated/console.conversation-evaluation.index.tsx || fail "Conversation Evaluation source not connected to guarded data layer"
pass "Inbox/Agent Assist/Widget/CE guarded source coverage"

npm run build
pass "production client/SSR/Nitro build"

if grep -R --binary-files=text --fixed-strings "$LEGACY_REF" .output >/tmp/task32_built_legacy.txt; then
  cat /tmp/task32_built_legacy.txt >&2
  fail "legacy Supabase ref found in deployable build"
fi
grep -R --binary-files=text --fixed-strings "$TARGET_REF" .output >/dev/null || fail "target Supabase ref absent from deployable build"
pass "deployable build target-only binding"

# Supabase Auth health is behind the API gateway and requires the public project key.
auth_code="$(curl --silent --show-error --max-time 15 -o /tmp/task32_auth_health.json -w '%{http_code}' \
  -H "apikey: ${PUBLISHABLE_KEY}" \
  "${TARGET_ORIGIN}/auth/v1/health")"
[[ "$auth_code" == "200" ]] || { cat /tmp/task32_auth_health.json >&2 || true; fail "target Supabase Auth health HTTP ${auth_code}"; }
python3 - <<'PY'
import json
p='/tmp/task32_auth_health.json'
try:
    data=json.load(open(p))
except Exception as e:
    raise SystemExit(f'FAIL: auth health non-JSON: {e}')
if not isinstance(data, dict):
    raise SystemExit('FAIL: auth health response is not object')
PY
pass "target Supabase Auth health (HTTP 200)"

# Public Feedback Edge route: invalid token is deliberately non-mutating. Include the
# public apikey so the gateway can route regardless of verify_jwt configuration; the
# application payload is still unauthenticated and must be rejected/handled by the function.
feedback_code="$(curl --silent --show-error --max-time 15 -o /tmp/task32_feedback.json -w '%{http_code}' \
  -H "apikey: ${PUBLISHABLE_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"token":"task3-2-invalid-token","rating":5}' \
  "${TARGET_FUNCTIONS}/submit-feedback-response")"
[[ "$feedback_code" =~ ^(200|400|401|403|404|422)$ ]] || { cat /tmp/task32_feedback.json >&2 || true; fail "target feedback Edge probe unexpected HTTP ${feedback_code}"; }
pass "target public Edge network route (HTTP ${feedback_code})"

echo "TASK 3.2 FINAL GATE: PASS"
