#!/bin/bash
set -Eeuo pipefail

SUPABASE_URL="${SUPABASE_URL:-}"
USER_JWT="${W1_SMOKE_USER_JWT:-}"
ORIGIN="${W1_SMOKE_ORIGIN:-https://console-chat-hub.lovable.app}"
KNOWN_QUERY="${W1_KB_SMOKE_QUERY:-}"
NO_CONTEXT_QUERY="${W1_NO_CONTEXT_QUERY:-}"
NO_CONTEXT_QUERY_ALT="${W1_NO_CONTEXT_QUERY_ALT:-}"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }

[ -n "$SUPABASE_URL" ] || stop "SUPABASE_URL missing"
[ -n "$USER_JWT" ] || stop "W1_SMOKE_USER_JWT missing"
[ -n "$KNOWN_QUERY" ] || stop "W1_KB_SMOKE_QUERY missing"
[ -n "$NO_CONTEXT_QUERY" ] || stop "W1_NO_CONTEXT_QUERY missing"
[ -n "$NO_CONTEXT_QUERY_ALT" ] || stop "W1_NO_CONTEXT_QUERY_ALT missing"
[ "$NO_CONTEXT_QUERY" != "$NO_CONTEXT_QUERY_ALT" ] || stop "W1_NO_CONTEXT_QUERY_ALT must be a genuinely different intent"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

# The publishable key is public client configuration, not a service-role secret.
# Prefer runtime env; otherwise read the project's checked-in .env.
PUBLISHABLE_KEY="${SUPABASE_PUBLISHABLE_KEY:-${VITE_SUPABASE_PUBLISHABLE_KEY:-}}"
if [ -z "$PUBLISHABLE_KEY" ] && [ -s ".env" ]; then
  PUBLISHABLE_KEY="$(python3 - <<'PY'
from pathlib import Path
for raw in Path(".env").read_text().splitlines():
    line=raw.strip()
    if line.startswith("SUPABASE_PUBLISHABLE_KEY="):
        print(line.split("=",1)[1].strip().strip('"').strip("'"))
        break
PY
)"
fi
[ -n "$PUBLISHABLE_KEY" ] || stop "Supabase publishable key missing"

SUPABASE_URL="$SUPABASE_URL" \
SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" \
W1_SMOKE_USER_JWT="$USER_JWT" \
W1_SMOKE_ORIGIN="$ORIGIN" \
W1_KB_SMOKE_QUERY="$KNOWN_QUERY" \
W1_NO_CONTEXT_QUERY="$NO_CONTEXT_QUERY" \
W1_NO_CONTEXT_QUERY_ALT="$NO_CONTEXT_QUERY_ALT" \
python3 - <<'PY'
import json, os, ssl, urllib.error, urllib.request, uuid

BASE=os.environ["SUPABASE_URL"].rstrip("/")
ANON=os.environ["SUPABASE_PUBLISHABLE_KEY"]
JWT=os.environ["W1_SMOKE_USER_JWT"]
ORIGIN=os.environ["W1_SMOKE_ORIGIN"]
KNOWN=os.environ["W1_KB_SMOKE_QUERY"].strip()
NOCTX=os.environ["W1_NO_CONTEXT_QUERY"].strip()
NOCTX_ALT=os.environ["W1_NO_CONTEXT_QUERY_ALT"].strip()
ctx=ssl.create_default_context()

def fail(s): raise SystemExit("FAIL: "+s)

def call(path, body, expect=None):
    req=urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Authorization":f"Bearer {JWT}",
            "apikey":ANON,
            "Content-Type":"application/json",
            "Origin":ORIGIN,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
            status=resp.status
            raw=resp.read()
    except urllib.error.HTTPError as e:
        status=e.code
        raw=e.read()
    try:
        data=json.loads(raw) if raw else {}
    except Exception:
        data={}
    if expect is not None and status != expect:
        fail(f"{path} expected HTTP {expect}, got {status}")
    return status,data

def assistant_messages(data):
    msgs=data.get("messages")
    if not isinstance(msgs,list): return []
    return [m for m in msgs if isinstance(m,dict) and m.get("role")=="assistant"]

def visitor_messages(data):
    msgs=data.get("messages")
    if not isinstance(msgs,list): return []
    return [m for m in msgs if isinstance(m,dict) and m.get("role")=="visitor"]

def assert_ai_reply_without_handoff(data, label, allow_citations=True):
    if data.get("success") is not True:
        fail(f"{label}: success=false")
    if data.get("handoff_persisted") is True:
        fail(f"{label}: unnecessary human handoff")
    ass=assistant_messages(data)
    if not ass:
        fail(f"{label}: no assistant reply persisted")
    latest=ass[-1]
    if not isinstance(latest.get("content"),str) or not latest["content"].strip():
        fail(f"{label}: assistant reply empty")
    if not allow_citations:
        meta=latest.get("metadata")
        if isinstance(meta,dict) and isinstance(meta.get("citations"),list) and meta["citations"]:
            fail(f"{label}: conversational clarification unexpectedly carries KB citations")
    return latest

# 1. Tenant/company/key tamper must be rejected at public test boundary.
status,data=call("/functions/v1/widget-live-ai-test",{"action":"send","query":"x","company_id":"forbidden"})
if status!=400 or data.get("error")!="invalid_request":
    fail("widget tenant-scope tamper was not rejected")
print("PASS widget tenant/company scope is server-derived")

# 2. Greeting must be handled naturally by AI, without KB/handoff.
status,greet=call("/functions/v1/widget-live-ai-test",{"action":"send","query":"你好"})
if status!=200: fail(f"greeting expected HTTP 200, got {status}")
assert_ai_reply_without_handoff(greet,"greeting",allow_citations=False)
if greet.get("escalation_rule") not in (None,""):
    fail("greeting unexpectedly matched escalation rule")
print("PASS greeting receives natural AI reply without handoff")

# 3. Known grounded query through canonical widget-live -> generate-reply path.
status,data=call("/functions/v1/widget-live-ai-test",{"action":"send","query":KNOWN})
if status!=200 or data.get("success") is not True:
    fail("known-context widget send failed")
conv=data.get("conversation_id")
if not isinstance(conv,str):
    fail("known-context conversation_id missing")
uuid.UUID(conv)
vis=visitor_messages(data)
ass=assistant_messages(data)
if not vis or not ass:
    fail("known-context did not persist visitor+assistant")
source_id=vis[-1].get("id")
if not isinstance(source_id,str):
    fail("known-context source visitor id missing")
uuid.UUID(source_id)
latest_ass=ass[-1]
if not isinstance(latest_ass.get("content"),str) or not latest_ass["content"].strip():
    fail("known-context assistant reply empty")
meta=latest_ass.get("metadata")
if not isinstance(meta,dict) or not isinstance(meta.get("citations"),list) or len(meta["citations"])<1:
    fail("known-context assistant message missing KB citation metadata")
print("PASS Widget -> canonical generate-reply -> persisted grounded assistant reply")
print("PASS grounded reply carries KB citation metadata")

# 4. Re-invoking the same source with the real user JWT must be idempotent.
st,loaded_before=call("/functions/v1/widget-live-ai-test",{
    "action":"load","test_conversation_id":conv
})
if st!=200 or loaded_before.get("success") is not True:
    fail("pre-idempotency load failed")
before_count=len(assistant_messages(loaded_before))

st,_=call("/functions/v1/generate-reply",{
    "conversation_id":conv,
    "source_message_id":source_id,
})
if st!=200:
    fail("same-source generate-reply re-invocation failed")

st,loaded_after=call("/functions/v1/widget-live-ai-test",{
    "action":"load","test_conversation_id":conv
})
if st!=200 or loaded_after.get("success") is not True:
    fail("post-idempotency load failed")
after_count=len(assistant_messages(loaded_after))
if after_count != before_count:
    fail("duplicate assistant message created for same source")
print("PASS same source message produces no duplicate assistant answer")

# 5. Persistent history/load.
st,hist=call("/functions/v1/widget-live-ai-test",{"action":"history"})
if st!=200 or hist.get("success") is not True:
    fail("history action failed")
if conv not in [x.get("conversation_id") for x in hist.get("history",[]) if isinstance(x,dict)]:
    fail("created conversation missing from history")
print("PASS persistent Widget Live Test history/load")

# 6. Explicit handoff, then AI suppression while under human control.
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

# 7. Canonical takeover -> return-to-AI through the real authenticated Edge APIs.
# This proves RBAC/tenant scope without requiring a service-role key in the user environment.
st,take=call("/functions/v1/take-over-conversation",{"conversation_id":conv})
if st!=200 or take.get("success") is not True:
    fail("authenticated take-over-conversation failed")
st,ret=call("/functions/v1/return-to-ai",{"conversation_id":conv})
if st!=200 or ret.get("success") is not True:
    fail("authenticated return-to-ai failed")
print("PASS canonical authenticated takeover -> return-to-AI lifecycle")

# 8. First normal KB no-match MUST clarify, not hand off.
st,nc1=call("/functions/v1/widget-live-ai-test",{"action":"send","query":NOCTX})
if st!=200: fail(f"first no-context expected HTTP 200, got {st}")
assert_ai_reply_without_handoff(nc1,"first no-context clarification",allow_citations=False)
if nc1.get("escalation_rule")!="R2":
    fail("first no-context did not route through R2 clarification")
nc_conv=nc1.get("conversation_id")
if not isinstance(nc_conv,str): fail("no-context conversation id missing")
print("PASS first normal KB no-match clarifies without human handoff")

# 9. A different new no-context intent in same conversation MUST NOT inherit old cap.
st,nc2=call("/functions/v1/widget-live-ai-test",{
    "action":"send","query":NOCTX_ALT,"test_conversation_id":nc_conv
})
if st!=200: fail(f"new-intent no-context expected HTTP 200, got {st}")
assert_ai_reply_without_handoff(nc2,"new-intent no-context clarification",allow_citations=False)
if nc2.get("escalation_rule")!="R2":
    fail("new-intent no-context did not remain in R2 clarification")
print("PASS different new KB no-match intent does not inherit previous clarification cap")

# 10. Same unresolved intent repeated after clarification may/should hand off via R2.
st,rep1=call("/functions/v1/widget-live-ai-test",{"action":"send","query":NOCTX})
if st!=200: fail(f"repeat fixture first turn expected HTTP 200, got {st}")
assert_ai_reply_without_handoff(rep1,"repeat fixture first clarification",allow_citations=False)
rep_conv=rep1.get("conversation_id")
if not isinstance(rep_conv,str): fail("repeat fixture conversation id missing")

st,rep2=call("/functions/v1/widget-live-ai-test",{
    "action":"send","query":NOCTX,"test_conversation_id":rep_conv
})
if st!=200 or rep2.get("success") is not True:
    fail("repeated unresolved no-context turn failed")
if rep2.get("escalation_rule")!="R2" or rep2.get("handoff_persisted") is not True:
    fail("same unresolved intent repeated after clarification did not persist R2 handoff")
print("PASS repeated unresolved intent after clarification persists R2 handoff")

print("W1 TASK 1.3 WIDGET RUNTIME SMOKE: PASS")
PY
