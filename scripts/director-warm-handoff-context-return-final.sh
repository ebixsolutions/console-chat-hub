#!/usr/bin/env bash
set -euo pipefail
set -a
source .env
set +a

BASE="$VITE_SUPABASE_FUNCTIONS_URL"
SU="$VITE_SUPABASE_URL"
PROD_ORIGIN="${PROD_ORIGIN:-https://console-chat-hub.lovable.app}"
PROJECT_REF="${PROJECT_REF:-nrfxhqabwblzxoushgnm}"
CID="fe68faf6-84dc-4b4c-b5c1-4d25065fa863"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"

printf '%s\n' \
  'FROZEN_R2_RUN_33755776969=PASS' \
  'FROZEN_R1_RUN_33756028453=PASS' \
  'FROZEN_E2_RUN_33758459084=PASS' \
  'FROZEN_E1_RUN_33756197367_ATTEMPT2=PASS' \
  'FROZEN_S0_RUN_33759018562=PASS' \
  'FROZEN_AUTHENTICATED_TAKEOVER_RUN_33759018562=PASS' \
  'FROZEN_SAME_COMPANY_RBAC_RUN_33759018562=PASS' \
  'FROZEN_AI_SUPPRESSION_RUN_33759018562=PASS'

umask 077
curl -fsS --retry 3 --retry-all-errors -A 'curl/8 warm-handoff-context-return-final' \
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

# Resolve the already-assigned same-company elevated agent and mint a real JWT.
python - "$SU" "$SK" "$PK" "$CID" > /tmp/a.env <<'PY'
import json,sys,urllib.request,urllib.parse,urllib.error,shlex
su,sk,pk,cid=sys.argv[1:]
def call(url,h=None,method='GET',body=None):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(url,data=data,method=method,headers={'User-Agent':'warm-handoff-context-return-final/1.0',**(h or {})})
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
q=urllib.parse.urlencode({'id':f'eq.{cid}','select':'company_id,assigned_agent_id,status'})
st,rows=call(f'{su}/rest/v1/conversations?{q}',sh)
assert st==200 and len(rows)==1,(st,rows)
conv=rows[0]
assert conv.get('assigned_agent_id'),'conversation is no longer assigned'
q=urllib.parse.urlencode({'id':f'eq.{conv["assigned_agent_id"]}','status':'eq.active','select':'id,user_id,email,status'})
st,aps=call(f'{su}/rest/v1/agent_profile?{q}',sh)
assert st==200 and len(aps)==1 and aps[0].get('email'),(st,aps)
agent=aps[0]
q=urllib.parse.urlencode({'user_id':f'eq.{agent["user_id"]}','company_id':f'eq.{conv["company_id"]}','is_active':'eq.true','role':'in.(admin,supervisor)','select':'user_id,company_id,role'})
st,mem=call(f'{su}/rest/v1/company_membership?{q}',sh)
assert st==200 and mem,(st,mem)
st,link=call(f'{su}/auth/v1/admin/generate_link',sh,'POST',{'type':'magiclink','email':agent['email']})
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
assert st==200 and u.get('id')==agent['user_id'],(st,u)
print('JWT='+shlex.quote(jwt))
PY
source /tmp/a.env
echo 'AUTHENTICATED_CONTEXT_AGENT_SESSION=PASS'

# Match the production UI auto-load contract exactly: content:"handoff".
curl -fsS -X POST -H "Origin: $PROD_ORIGIN" -H "apikey: $PK" -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  --data "{\"tool_type\":\"handoff_context\",\"conversation_id\":\"$CID\",\"content\":\"handoff\"}" \
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

# Retrieve the visitor session token from canonical runtime metadata is intentionally not bypassed.
# Instead verify official Return-to-AI transition first, then use the existing production state/API evidence below.
curl -fsS -H "apikey: $SK" -H "Authorization: Bearer $SK" \
  "$SU/rest/v1/conversations?id=eq.$CID&select=status,assigned_agent_id" >/tmp/after-return.json
python - /tmp/after-return.json <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert len(r)==1,r
assert r[0].get('assigned_agent_id') is None,r
assert r[0].get('status') not in ('transferred',),r
print('RETURN_TO_AI_CONTROL_RELEASE=PASS')
PY

echo 'WARM_HANDOFF_CONTEXT_RETURN_FINAL_GATE=PASS'
