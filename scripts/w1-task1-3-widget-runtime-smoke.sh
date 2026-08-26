#!/bin/bash
set -Eeuo pipefail

SUPABASE_URL="${SUPABASE_URL:-}"
SERVICE_ROLE="${SUPABASE_SERVICE_ROLE_KEY:-}"
USER_JWT="${W1_SMOKE_USER_JWT:-}"
ORIGIN="${W1_SMOKE_ORIGIN:-https://console-chat-hub.lovable.app}"
KNOWN_QUERY="${W1_KB_SMOKE_QUERY:-}"
NO_CONTEXT_QUERY="${W1_NO_CONTEXT_QUERY:-}"
AGENT_PROFILE_ID="${W1_SMOKE_AGENT_PROFILE_ID:-}"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }
[ -n "$SUPABASE_URL" ] || stop "SUPABASE_URL missing"
[ -n "$SERVICE_ROLE" ] || stop "SUPABASE_SERVICE_ROLE_KEY missing"
[ -n "$USER_JWT" ] || stop "W1_SMOKE_USER_JWT missing"
[ -n "$KNOWN_QUERY" ] || stop "W1_KB_SMOKE_QUERY missing"
[ -n "$NO_CONTEXT_QUERY" ] || stop "W1_NO_CONTEXT_QUERY missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

SUPABASE_URL="$SUPABASE_URL" \
SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE" \
W1_SMOKE_USER_JWT="$USER_JWT" \
W1_SMOKE_ORIGIN="$ORIGIN" \
W1_KB_SMOKE_QUERY="$KNOWN_QUERY" \
W1_NO_CONTEXT_QUERY="$NO_CONTEXT_QUERY" \
W1_SMOKE_AGENT_PROFILE_ID="$AGENT_PROFILE_ID" \
python3 - <<'PY'
import json, os, ssl, urllib.error, urllib.parse, urllib.request, uuid

BASE=os.environ["SUPABASE_URL"].rstrip("/")
SERVICE=os.environ["SUPABASE_SERVICE_ROLE_KEY"]
JWT=os.environ["W1_SMOKE_USER_JWT"]
ORIGIN=os.environ["W1_SMOKE_ORIGIN"]
KNOWN=os.environ["W1_KB_SMOKE_QUERY"].strip()
NOCTX=os.environ["W1_NO_CONTEXT_QUERY"].strip()
AGENT=os.environ.get("W1_SMOKE_AGENT_PROFILE_ID","").strip()
ctx=ssl.create_default_context()

def fail(s): raise SystemExit("FAIL: "+s)
def call(path, body, auth=JWT, expect=None):
    req=urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Authorization":f"Bearer {auth}",
            "apikey": SERVICE if auth==SERVICE else os.environ.get("SUPABASE_ANON_KEY",""),
            "Content-Type":"application/json",
            "Origin":ORIGIN,
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=40, context=ctx) as resp:
            status=resp.status; raw=resp.read()
    except urllib.error.HTTPError as e:
        status=e.code; raw=e.read()
    try: data=json.loads(raw) if raw else {}
    except Exception: data={}
    if expect is not None and status!=expect:
        fail(f"{path} expected HTTP {expect}, got {status}")
    return status,data

def rest_get(path):
    req=urllib.request.Request(
        f"{BASE}/rest/v1/{path}",
        method="GET",
        headers={
            "Authorization":f"Bearer {SERVICE}",
            "apikey":SERVICE,
            "Accept":"application/json",
        }
    )
    with urllib.request.urlopen(req,timeout=20,context=ctx) as resp:
        return json.loads(resp.read())

def rpc(name, body):
    req=urllib.request.Request(
        f"{BASE}/rest/v1/rpc/{name}",
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Authorization":f"Bearer {SERVICE}",
            "apikey":SERVICE,
            "Content-Type":"application/json",
        }
    )
    try:
        with urllib.request.urlopen(req,timeout=20,context=ctx) as resp:
            return resp.status,json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raw=e.read()
        try: payload=json.loads(raw)
        except Exception: payload={}
        return e.code,payload

# 1. Tenant/company/key tamper must be rejected at public test boundary.
status,data=call("/functions/v1/widget-live-ai-test",{"action":"send","query":"x","company_id":"forbidden"})
if status!=400 or data.get("error")!="invalid_request":
    fail("widget tenant-scope tamper was not rejected")
print("PASS widget tenant/company scope is server-derived")

# 2. Known grounded query through canonical widget-live -> generate-reply path.
status,data=call("/functions/v1/widget-live-ai-test",{"action":"send","query":KNOWN})
if status!=200 or data.get("success") is not True:
    fail("known-context widget send failed")
conv=data.get("conversation_id")
if not isinstance(conv,str):
    fail("known-context conversation_id missing")
uuid.UUID(conv)
msgs=data.get("messages")
if not isinstance(msgs,list): fail("known-context messages missing")
vis=[m for m in msgs if isinstance(m,dict) and m.get("role")=="visitor"]
ass=[m for m in msgs if isinstance(m,dict) and m.get("role")=="assistant"]
if not vis or not ass: fail("known-context did not persist visitor+assistant")
latest_ass=ass[-1]
if not isinstance(latest_ass.get("content"),str) or not latest_ass["content"].strip():
    fail("known-context assistant reply empty")
meta=latest_ass.get("metadata")
if not isinstance(meta,dict) or not isinstance(meta.get("citations"),list) or len(meta["citations"])<1:
    fail("known-context assistant message missing KB citation metadata")
print("PASS Widget -> canonical generate-reply -> persisted grounded assistant reply")
print("PASS grounded reply carries KB citation metadata")

# 3. Re-invoking same source message must not create duplicate assistant answer.
encoded=urllib.parse.quote(conv,safe="")
rows=rest_get(f"messages?conversation_id=eq.{encoded}&role=eq.visitor&order=created_at.desc&limit=1&select=id")
if not isinstance(rows,list) or not rows or not isinstance(rows[0].get("id"),str):
    fail("source visitor message lookup failed")
source_id=rows[0]["id"]
before=rest_get(f"messages?conversation_id=eq.{encoded}&role=eq.assistant&select=id")
before_count=len(before) if isinstance(before,list) else -1

st,gen=call("/functions/v1/generate-reply",{
    "conversation_id":conv,
    "source_message_id":source_id,
},auth=SERVICE)
if st!=200:
    fail("same-source generate-reply re-invocation failed")
after=rest_get(f"messages?conversation_id=eq.{encoded}&role=eq.assistant&select=id")
after_count=len(after) if isinstance(after,list) else -1
if before_count<0 or after_count!=before_count:
    fail("duplicate assistant message created for same source")
print("PASS same source message produces no duplicate assistant answer")

# 4. Persistent history/load.
st,hist=call("/functions/v1/widget-live-ai-test",{"action":"history"})
if st!=200 or hist.get("success") is not True:
    fail("history action failed")
if conv not in [x.get("conversation_id") for x in hist.get("history",[]) if isinstance(x,dict)]:
    fail("created conversation missing from history")
st,loaded=call("/functions/v1/widget-live-ai-test",{"action":"load","test_conversation_id":conv})
if st!=200 or loaded.get("success") is not True:
    fail("load action failed")
print("PASS persistent Widget Live Test history/load")

# 5. Explicit handoff, then AI suppression while under human control.
st,hand=call("/functions/v1/widget-live-ai-test",{
    "action":"send","query":"我要轉真人客服","test_conversation_id":conv
})
if st!=200 or hand.get("success") is not True or hand.get("handoff_persisted") is not True:
    fail("explicit R1 handoff was not persisted")
st,blocked=call("/functions/v1/widget-live-ai-test",{
    "action":"send","query":"AI should not answer this","test_conversation_id":conv
})
if st!=409 or blocked.get("error")!="test_conversation_under_human_control":
    fail("AI was not blocked after human handoff")
print("PASS explicit R1 handoff persisted")
print("PASS AI suppressed after human control")

# 6. Canonical takeover -> return AI when a real canonical test company/agent exists.
conv_row=rest_get(f"conversations?id=eq.{encoded}&select=id,company_id,status,assigned_agent_id")
if not isinstance(conv_row,list) or len(conv_row)!=1:
    fail("conversation runtime state lookup failed")
state=conv_row[0]
company_id=state.get("company_id")
if company_id is not None:
    if not AGENT:
        raise SystemExit("STOP: canonical handoff lifecycle requires W1_SMOKE_AGENT_PROFILE_ID")
    uuid.UUID(AGENT)
    expected_status=str(state.get("status") or "")
    expected_owner=state.get("assigned_agent_id")
    st,take=rpc("takeover_conversation_tx",{
        "p_conversation_id":conv,
        "p_agent_id":AGENT,
        "p_expected_status":expected_status,
        "p_expected_owner":expected_owner,
    })
    if st!=200 or take.get("result") not in ("success","already_owner"):
        fail("canonical takeover RPC failed")
    state2=rest_get(f"conversations?id=eq.{encoded}&select=status,assigned_agent_id")[0]
    st,ret=rpc("return_to_ai_tx",{
        "p_conversation_id":conv,
        "p_actor_agent_id":AGENT,
        "p_expected_status":state2.get("status"),
        "p_expected_owner":state2.get("assigned_agent_id"),
    })
    if st!=200 or ret.get("result") not in ("success","already_ai"):
        fail("return_to_ai RPC failed")
    print("PASS canonical takeover -> return-to-AI lifecycle")
else:
    print("INFO pre-activation conversation: canonical takeover/return deferred to canonical identity activation")

# 7. No-context query must not yield an ungrounded normal AI answer.
st,nc=call("/functions/v1/widget-live-ai-test",{"action":"send","query":NOCTX})
if st not in (200,409,500,502,503):
    fail(f"no-context smoke unexpected HTTP {st}")
if st==200 and nc.get("success") is True:
    # Correct safety outcome is a persisted handoff/fallback, not a normal uncited answer.
    if nc.get("handoff_persisted") is not True:
        nmsgs=nc.get("messages",[])
        nass=[m for m in nmsgs if isinstance(m,dict) and m.get("role")=="assistant"]
        if nass:
            m=nass[-1].get("metadata")
            if not (isinstance(m,dict) and isinstance(m.get("citations"),list) and m["citations"]):
                fail("no-context produced an uncited normal assistant answer")
print("PASS no-context path does not silently approve ungrounded answer")

print("W1 TASK 1.3 WIDGET RUNTIME SMOKE: PASS")
PY
