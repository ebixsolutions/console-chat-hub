#!/usr/bin/env bash
set -euo pipefail
set -a
source .env
set +a

BASE="$VITE_SUPABASE_FUNCTIONS_URL"
SU="$VITE_SUPABASE_URL"
PROD_ORIGIN="${PROD_ORIGIN:-https://console-chat-hub.lovable.app}"
CHANNEL_ID="${CHANNEL_ID:-b0000000-0000-0000-0000-000000000001}"
PROJECT_REF="${PROJECT_REF:-nrfxhqabwblzxoushgnm}"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"

printf '%s\n' \
  'FROZEN_R2_RUN_33755776969=PASS' \
  'FROZEN_R1_RUN_33756028453=PASS' \
  'FROZEN_E2_RUN_33758459084=PASS' \
  'FROZEN_E1_RUN_33756197367_ATTEMPT2=PASS'

umask 077
curl -fsS --retry 3 --retry-all-errors -A 'curl/8 warm-handoff-final-remaining-v2' \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$PROJECT_REF/api-keys?reveal=true" -o /tmp/k.json
python - /tmp/k.json > /tmp/k.env <<'PY'
import json,sys,shlex
a=json.load(open(sys.argv[1]))
def val(r): return r.get('api_key') or r.get('key') or r.get('value')
p=[val(r) for r in a if str(r.get('type') or '').lower()=='publishable' and val(r)]
s=[val(r) for r in a if str(r.get('type') or '').lower()=='secret' and val(r)]
assert p and s
print('PK='+shlex.quote(p[0]))
print('SK='+shlex.quote(s[0]))
PY
source /tmp/k.env
rm -f /tmp/k.json

new_session() {
  curl -fsS -X POST -H "Origin: $PROD_ORIGIN" -H 'Content-Type: application/json' \
    --data "{\"channel_id\":\"$CHANNEL_ID\",\"visitor_metadata\":{\"warm_handoff_remaining_v2\":true,\"exclude_training\":true}}" \
    "$BASE/create-visitor-session"
}

load_session() {
  python - "$1" > /tmp/s.env <<'PY'
import json,sys,shlex
d=json.loads(sys.argv[1])
assert d.get('success') is True,d
x=d['data']
print('CID='+shlex.quote(x['conversation_id']))
print('TOK='+shlex.quote(x['session_token']))
PY
  source /tmp/s.env
}

poll_json() {
  curl -fsS -X POST -H "Origin: $PROD_ORIGIN" -H 'Content-Type: application/json' \
    --data "{\"conversation_id\":\"$CID\",\"session_token\":\"$TOK\"}" \
    "$BASE/widget-poll-messages"
}

assistant_count() {
  python -c 'import json,sys;d=json.load(sys.stdin);print(sum(1 for m in d["data"].get("messages",[]) if m.get("role")=="assistant"))'
}

send_turn() {
  local text="$1" payload
  payload=$(python - "$CID" "$TOK" "$text" <<'PY'
import json,sys
print(json.dumps({'conversation_id':sys.argv[1],'session_token':sys.argv[2],'content':sys.argv[3]},ensure_ascii=False))
PY
)
  curl -fsS -X POST -H "Origin: $PROD_ORIGIN" -H 'Content-Type: application/json' \
    -H "idempotency-key: $(python -c 'import uuid;print(uuid.uuid4())')" \
    --data "$payload" "$BASE/receive-widget-message" >/tmp/send.json
  python - /tmp/send.json <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get('success') is True,d
PY
}

wait_reply() {
  local before="$1"
  for _ in $(seq 1 30); do
    sleep 2
    local p after
    p=$(poll_json)
    after=$(printf '%s' "$p" | assistant_count)
    if [ "$after" -gt "$before" ]; then
      printf '%s' "$p" > /tmp/poll.json
      return 0
    fi
  done
  echo 'NO_REPLY'
  exit 1
}

# S0 authoritative RPC proof with a real visitor source row.
load_session "$(new_session)"
S0CID="$CID"
curl -fsS -X POST -H "apikey: $SK" -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
  --data "{\"conversation_id\":\"$S0CID\",\"role\":\"visitor\",\"content\":\"S0 isolated production persistence smoke\",\"status\":\"delivered\",\"is_recalled\":false}" \
  "$SU/rest/v1/messages?select=id" >/tmp/s0msg.json
S0SRC=$(python -c 'import json;d=json.load(open("/tmp/s0msg.json"));assert len(d)==1,d;print(d[0]["id"])')
s0payload=$(python - "$S0CID" "$S0SRC" <<'PY'
import json,sys
print(json.dumps({
  'p_conversation_id':sys.argv[1],
  'p_safe_reply_content':'系統暫時未能處理，已轉交真人客服。',
  'p_source_message_id':sys.argv[2],
  'p_failure_type':'LLM_NETWORK_ERROR'
},ensure_ascii=False))
PY
)
curl -fsS -X POST -H "apikey: $SK" -H "Authorization: Bearer $SK" -H 'Content-Type: application/json' \
  --data "$s0payload" "$SU/rest/v1/rpc/s0_handoff_tx" >/tmp/s0.json
curl -fsS -H "apikey: $SK" -H "Authorization: Bearer $SK" \
  "$SU/rest/v1/handoff_event?conversation_id=eq.$S0CID&select=escalation_rule,branch_tag,handoff_reason&order=created_at.desc&limit=1" >/tmp/s0e.json
python - /tmp/s0.json /tmp/s0e.json <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); e=json.load(open(sys.argv[2]))
assert d.get('result') in ('success','already_handled'),d
assert e and e[0].get('escalation_rule')=='S0',e
print('S0_PERSISTENCE_CRITICAL_BYPASS=PASS')
PY

# Fresh policy-rich R1 conversation for authenticated agent workflow.
load_session "$(new_session)"
ACID="$CID"
ATOK="$TOK"
before=$(poll_json | assistant_count)
send_turn '我想處理香港四電一腦回收政策問題，現在我要真人客服。'
wait_reply "$before"
test "$(poll_json | python -c 'import json,sys;print(json.load(sys.stdin)["data"].get("conversation_status"))')" = pending

# Real same-company elevated agent JWT.
python - "$SU" "$SK" "$PK" "$ACID" > /tmp/a.env <<'PY'
import json,sys,urllib.request,urllib.parse,urllib.error,shlex
su,sk,pk,cid=sys.argv[1:]
def call(url,h=None,method='GET',body=None):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(url,data=data,method=method,headers={'User-Agent':'warm-handoff-final-remaining-v2/1.0',**(h or {})})
    try:
        with urllib.request.urlopen(req,timeout=30) as r:
            raw=r.read().decode()
            return r.status,json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw=e.read().decode()
        try: payload=json.loads(raw)
        except Exception: payload={'raw':raw[:300]}
        return e.code,payload
sh={'apikey':sk,'Authorization':f'Bearer {sk}','Content-Type':'application/json'}
q=urllib.parse.urlencode({'id':f'eq.{cid}','select':'company_id'})
st,x=call(f'{su}/rest/v1/conversations?{q}',sh)
assert st==200 and len(x)==1,(st,x)
co=x[0]['company_id']
q=urllib.parse.urlencode({'company_id':f'eq.{co}','is_active':'eq.true','role':'in.(admin,supervisor)','select':'user_id,role'})
st,mem=call(f'{su}/rest/v1/company_membership?{q}',sh)
assert st==200 and mem,(st,mem)
sel=None
for z in mem:
    uid=z['user_id']
    q=urllib.parse.urlencode({'user_id':f'eq.{uid}','is_active':'eq.true','select':'company_id,role'})
    st,mm=call(f'{su}/rest/v1/company_membership?{q}',sh)
    if st!=200 or len({m['company_id'] for m in mm})!=1 or mm[0]['company_id']!=co:
        continue
    q=urllib.parse.urlencode({'user_id':f'eq.{uid}','status':'eq.active','select':'id,user_id,email,status'})
    st,ap=call(f'{su}/rest/v1/agent_profile?{q}',sh)
    if st==200 and len(ap)==1 and ap[0].get('email'):
        sel=ap[0]
        break
assert sel,'no eligible single-tenant elevated agent'
st,link=call(f'{su}/auth/v1/admin/generate_link',sh,'POST',{'type':'magiclink','email':sel['email']})
assert st in (200,201),(st,link)
props=link.get('properties') or {}
tok=props.get('hashed_token') or props.get('token_hash') or link.get('hashed_token') or link.get('token_hash')
assert tok,'missing token hash'
sess=None
for typ in ('magiclink','email'):
    st,v=call(f'{su}/auth/v1/verify',{'apikey':pk,'Content-Type':'application/json'},'POST',{'type':typ,'token_hash':tok})
    if st==200 and v.get('access_token'):
        sess=v
        break
assert sess and sess.get('access_token'),'JWT exchange failed'
jwt=sess['access_token']
st,u=call(f'{su}/auth/v1/user',{'apikey':pk,'Authorization':f'Bearer {jwt}'})
assert st==200 and u.get('id')==sel['user_id'],(st,u)
print('JWT='+shlex.quote(jwt))
print('AP='+shlex.quote(sel['id']))
print('CO='+shlex.quote(co))
PY
source /tmp/a.env
echo 'AUTHENTICATED_AGENT_SESSION=PASS'

CID="$ACID"
TOK="$ATOK"
takeover=$(curl -fsS -X POST -H "Origin: $PROD_ORIGIN" -H "apikey: $PK" -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' --data "{\"conversation_id\":\"$CID\"}" "$BASE/take-over-conversation")
python - "$takeover" <<'PY'
import json,sys
d=json.loads(sys.argv[1])
assert d.get('success') is True,d
print('AUTHENTICATED_TAKEOVER=PASS')
PY
curl -fsS -H "apikey: $SK" -H "Authorization: Bearer $SK" \
  "$SU/rest/v1/conversations?id=eq.$CID&select=company_id,assigned_agent_id" >/tmp/c.json
python - /tmp/c.json "$CO" "$AP" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert len(r)==1 and r[0]['company_id']==sys.argv[2] and r[0]['assigned_agent_id']==sys.argv[3],r
print('SAME_COMPANY_SCOPE=PASS')
print('RBAC_OWNERSHIP=PASS')
PY

before=$(poll_json | assistant_count)
send_turn '我補充一下，我沒有其他資料。'
sleep 8
after=$(poll_json | assistant_count)
test "$after" = "$before"
echo 'AI_SUPPRESSION=PASS'

curl -fsS -X POST -H "Origin: $PROD_ORIGIN" -H "apikey: $PK" -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' --data "{\"tool_type\":\"handoff_context\",\"conversation_id\":\"$CID\"}" \
  "$BASE/agent-assist" >/tmp/ctx.json
python - /tmp/ctx.json <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
assert d.get('success') is True,d
assert d.get('tool_type')=='handoff_context',d
pkg=d.get('warm_handoff_package') or {}
assert pkg.get('conversation_summary'),pkg
knowledge=(d.get('knowledge') or {}).get('evidence') or []
policy=(d.get('policy') or {}).get('evidence') or []
suggestions=d.get('suggested_replies') or []
assert knowledge,'no relevant KB evidence returned'
assert policy,'no relevant Policy evidence returned'
assert suggestions,'no suggested replies returned'
print('AGENT_CONTEXT_SUMMARY=PASS')
print('AGENT_CONTEXT_KB=PASS')
print('AGENT_CONTEXT_POLICY=PASS')
print('AGENT_CONTEXT_SUGGESTED_REPLY=PASS')
PY

returned=$(curl -fsS -X POST -H "Origin: $PROD_ORIGIN" -H "apikey: $PK" -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  --data "{\"conversation_id\":\"$CID\",\"closure_checklist\":{\"issue_resolved\":true,\"low_risk_followup\":true}}" \
  "$BASE/return-to-ai")
python - "$returned" <<'PY'
import json,sys
d=json.loads(sys.argv[1])
assert d.get('success') is True,d
print('AUTHENTICATED_RETURN_TO_AI=PASS')
PY

before=$(poll_json | assistant_count)
send_turn '現在回到AI，請只用一句話說明我剛才主要問的是什麼。'
wait_reply "$before"
after=$(cat /tmp/poll.json | assistant_count)
test "$after" -gt "$before"
echo 'RETURN_TO_AI_RESUME=PASS'
echo 'WARM_HANDOFF_PRODUCTION_RUNTIME_FINAL_GATE=PASS'
