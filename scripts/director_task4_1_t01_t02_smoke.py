import json
import os
import sys
import time
import urllib.request
import uuid

BASE = os.environ["VITE_SUPABASE_FUNCTIONS_URL"].rstrip("/")
ORIGIN = os.environ.get("PROD_ORIGIN", "https://console-chat-hub.lovable.app")
CHANNEL_ID = os.environ.get("CHANNEL_ID", "b0000000-0000-0000-0000-000000000001")


def post(path: str, payload: dict, extra_headers: dict | None = None) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json", "Origin": ORIGIN}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(f"{BASE}/{path}", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


created = post(
    "create-visitor-session",
    {
        "channel_id": CHANNEL_ID,
        "visitor_metadata": {
            "task4_1_director_restore_smoke": True,
            "exclude_training": True,
        },
    },
)
assert created.get("success") is True, created
session = created["data"]
cid = session["conversation_id"]
token = session["session_token"]
print(f"DIRECTOR_RESTORE_CONVERSATION_ID={cid}")


def poll() -> dict:
    return post("widget-poll-messages", {"conversation_id": cid, "session_token": token})


def assistants(data: dict) -> list[dict]:
    return [m for m in data["data"].get("messages", []) if m.get("role") == "assistant"]


def send(text: str) -> None:
    result = post(
        "receive-widget-message",
        {"conversation_id": cid, "session_token": token, "content": text},
        {"idempotency-key": str(uuid.uuid4())},
    )
    assert result.get("success") is True, result


def wait_reply(before: int, expected_route: str | None = None) -> dict:
    for _ in range(30):
        time.sleep(2)
        data = poll()
        msgs = assistants(data)
        if len(msgs) <= before:
            continue
        status = data["data"].get("conversation_status")
        if status != "open":
            raise AssertionError(f"unexpected status {status}")
        latest = msgs[-1]
        route = (latest.get("metadata") or {}).get("response_route")
        if expected_route and route != expected_route:
            raise AssertionError(f"expected route {expected_route}, got {route}; metadata={latest.get('metadata')}")
        return latest
    raise AssertionError("assistant reply timeout")


before = len(assistants(poll()))
send("什么是四電一腦？")
t1 = wait_reply(before)
print("T01=" + json.dumps({"route": (t1.get("metadata") or {}).get("response_route"), "content": t1.get("content")}, ensure_ascii=False))

before = len(assistants(poll()))
send("請用繁體中文簡單解釋。")
t2 = wait_reply(before, "prior_grounded_transform")
meta = t2.get("metadata") or {}
lineage = meta.get("transform_lineage") or {}
assert lineage.get("authority") == "PRIOR_GROUNDED_ANSWER", meta
print("T02=" + json.dumps({"route": meta.get("response_route"), "authority": lineage.get("authority"), "content": t2.get("content")}, ensure_ascii=False))
print("DIRECTOR_TASK4_1_T01_T02_PROD_REGRESSION=PASS")
