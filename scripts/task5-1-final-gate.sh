#!/usr/bin/env bash
set -euo pipefail

PROD_ORIGIN="${PROD_ORIGIN:-https://console-chat-hub.lovable.app}"
CHANNEL_ID="${CHANNEL_ID:-b0000000-0000-0000-0000-000000000001}"
PROJECT_REF="${PROJECT_REF:-nrfxhqabwblzxoushgnm}"

for f in \
  public/widget/chat.js \
  supabase/functions/widget-poll-messages/index.ts \
  supabase/functions/attachment-gc/index.ts \
  supabase/migrations/20260830163000_task5_1_human_queue_runtime.sql \
  supabase/migrations/20260830170000_task5_1_attachment_gc_outbox.sql \
  supabase/migrations/20260830171000_task5_1_attachment_gc_cron.sql \
  supabase/migrations/20260830173000_task5_1_widget_attachment_privacy.sql; do
  test -s "$f" || { echo "FAIL missing/empty $f"; exit 1; }
done

test "$(wc -c < public/widget/chat.js)" -gt 50000
node --check public/widget/chat.js
grep -q 'Queue position: #' public/widget/chat.js
grep -q 'Customers ahead:' public/widget/chat.js
grep -q 'Estimated wait time is not available yet.' public/widget/chat.js
grep -q 'function uploadAttachment(file)' public/widget/chat.js
grep -q 'function insertEmoji(emoji)' public/widget/chat.js
grep -q 'content_type' supabase/functions/widget-poll-messages/index.ts
grep -q 'get_human_support_queue_snapshot' supabase/functions/widget-poll-messages/index.ts
grep -q 'enable row level security' supabase/migrations/20260830163000_task5_1_human_queue_runtime.sql
grep -q 'revoke all on public.human_support_queue from public, anon, authenticated' supabase/migrations/20260830163000_task5_1_human_queue_runtime.sql
grep -q 'attachment_delete_outbox' supabase/migrations/20260830170000_task5_1_attachment_gc_outbox.sql
grep -q 'trg_enqueue_attachment_delete' supabase/migrations/20260830170000_task5_1_attachment_gc_outbox.sql
grep -q 'task5_1_attachment_gc' supabase/migrations/20260830171000_task5_1_attachment_gc_cron.sql
grep -q "metadata - 'storage_bucket' - 'storage_path'" supabase/migrations/20260830173000_task5_1_widget_attachment_privacy.sql
if grep -R -n 'hvmtoqiwdqvgnjepxwrc' public/widget/chat.js supabase/functions/widget-poll-messages supabase/functions/attachment-gc; then
  echo 'FAIL legacy runtime ref in Task5.1 scope'; exit 1
fi
echo 'PASS source/security contracts'

npm ci
npm audit --omit=dev --audit-level=high
npm run build
echo 'PASS production build'

set -a; source .env; set +a
BASE="${VITE_SUPABASE_FUNCTIONS_URL}"

CREATE=$(curl -fsS -X POST -H "Origin: ${PROD_ORIGIN}" -H 'Content-Type: application/json' \
  --data "{\"channel_id\":\"${CHANNEL_ID}\",\"visitor_metadata\":{\"task51_final_gate\":true,\"exclude_training\":true}}" \
  "${BASE}/create-visitor-session")
python - <<'PY' "$CREATE" >/tmp/task51-final.env
import json,sys,shlex
d=json.loads(sys.argv[1]); assert d.get('success') is True,d
x=d['data']; print('CONVERSATION_ID='+shlex.quote(x['conversation_id'])); print('SESSION_TOKEN='+shlex.quote(x['session_token']))
PY
source /tmp/task51-final.env
echo "TASK51_FINAL_CONVERSATION_ID=${CONVERSATION_ID}"

EMOJI=$(curl -fsS -X POST -H "Origin: ${PROD_ORIGIN}" -H 'Content-Type: application/json' \
  --data "{\"conversation_id\":\"${CONVERSATION_ID}\",\"session_token\":\"${SESSION_TOKEN}\",\"content\":\"😊 中文 English 👍\"}" \
  "${BASE}/receive-widget-message")
python - <<'PY' "$EMOJI"
import json,sys
d=json.loads(sys.argv[1]); assert d.get('success') is True,d
print('PASS emoji send')
PY

python - <<'PY'
import base64
open('/tmp/task51-final.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='))
open('/tmp/task51-final.txt','w').write('Task 5.1 final attachment lifecycle proof\n')
PY
PNG=$(curl -fsS -X POST -H "Origin: ${PROD_ORIGIN}" -F "conversation_id=${CONVERSATION_ID}" -F "session_token=${SESSION_TOKEN}" -F "file=@/tmp/task51-final.png;type=image/png" "${BASE}/receive-widget-message")
TXT=$(curl -fsS -X POST -H "Origin: ${PROD_ORIGIN}" -F "conversation_id=${CONVERSATION_ID}" -F "session_token=${SESSION_TOKEN}" -F "file=@/tmp/task51-final.txt;type=text/plain" "${BASE}/receive-widget-message")
python - <<'PY' "$PNG" "$TXT"
import json,sys
p=json.loads(sys.argv[1]); t=json.loads(sys.argv[2]); assert p.get('success') is True,p; assert t.get('success') is True,t
assert p['data'].get('content_type')=='image',p; assert t['data'].get('content_type')=='file',t
print('PASS PNG/TXT upload')
PY

HANDOFF=$(curl -fsS -X POST -H "Origin: ${PROD_ORIGIN}" -H 'Content-Type: application/json' \
  --data "{\"conversation_id\":\"${CONVERSATION_ID}\",\"session_token\":\"${SESSION_TOKEN}\",\"content\":\"I want a human agent now\"}" \
  "${BASE}/receive-widget-message")
python - <<'PY' "$HANDOFF"
import json,sys
d=json.loads(sys.argv[1]); assert d.get('success') is True,d
print('PASS explicit handoff')
PY
sleep 5

POLL=$(curl -fsS -X POST -H "Origin: ${PROD_ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${CONVERSATION_ID}\",\"session_token\":\"${SESSION_TOKEN}\"}" "${BASE}/widget-poll-messages")
python - <<'PY' "$POLL"
import json,sys
d=json.loads(sys.argv[1]); assert d.get('success') is True,d
x=d['data']; hs=x.get('human_support') or {}; msgs=x.get('messages') or []
assert x.get('conversation_status')=='pending',x
assert hs.get('state')=='waiting',hs
pos=hs.get('queue_position'); ahead=hs.get('customers_ahead'); eta=hs.get('estimated_wait_minutes')
assert isinstance(pos,int) and pos>=1,hs; assert isinstance(ahead,int) and ahead==pos-1,hs
assert eta is None or (isinstance(eta,int) and eta>=1),hs
assert any(m.get('content')=='😊 中文 English 👍' for m in msgs),msgs
for m in msgs:
    md=m.get('metadata') or {}
    assert 'storage_path' not in md and 'storage_bucket' not in md,(m,md)
assert any(m.get('content_type')=='image' and (m.get('metadata') or {}).get('original_name')=='task51-final.png' for m in msgs),msgs
assert any(m.get('content_type')=='file' and (m.get('metadata') or {}).get('original_name')=='task51-final.txt' for m in msgs),msgs
print(f'PASS queue position={pos} customers_ahead={ahead} eta={eta}')
print('PASS browser metadata contains no raw storage locator')
PY

POLL2=$(curl -fsS -X POST -H "Origin: ${PROD_ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${CONVERSATION_ID}\",\"session_token\":\"${SESSION_TOKEN}\"}" "${BASE}/widget-poll-messages")
python - <<'PY' "$POLL2"
import json,sys
d=json.loads(sys.argv[1]); assert d.get('success') is True,d
hs=d['data'].get('human_support') or {}; assert hs.get('state')=='waiting',hs; assert isinstance(hs.get('queue_position'),int),hs
print('PASS reconnect queue persistence')
PY

echo 'TASK 5.1 FINAL GATE: PASS'
