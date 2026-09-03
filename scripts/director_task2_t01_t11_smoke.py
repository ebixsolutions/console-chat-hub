import json
import os
import time
import urllib.request
import uuid

BASE = os.environ["VITE_SUPABASE_FUNCTIONS_URL"].rstrip("/")
ORIGIN = os.environ.get("PROD_ORIGIN", "https://console-chat-hub.lovable.app")
CHANNEL_ID = os.environ.get("CHANNEL_ID", "b0000000-0000-0000-0000-000000000001")
TURNS = [
    "什么是四電一腦？",
    "請用繁體中文簡單解釋。",
    "Explain that in English.",
    "用繁體中文再講一次，不要增加新資料。",
    "用一句話總結。",
    "只說冷氣機相關部分。",
    "那回收安排的重點是什麼？",
    "簡單一點。",
    "我現在問的是哪個地區和哪個項目？",
    "Answer the same question in English.",
    "回到繁體中文，不要增加新資料。",
]


def post(path: str, payload: dict, extra_headers: dict | None = None) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode()
    headers = {"Content-Type": "application/json", "Origin": ORIGIN}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(f"{BASE}/{path}", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


created = post("create-visitor-session", {"channel_id": CHANNEL_ID, "visitor_metadata": {"task2_director_t01_t11": True, "exclude_training": True}})
assert created.get("success") is True, created
session = created["data"]
cid, token = session["conversation_id"], session["session_token"]
print(f"TASK2_T01_T11_CONVERSATION_ID={cid}")


def poll() -> dict:
    return post("widget-poll-messages", {"conversation_id": cid, "session_token": token})


def assistants(data: dict) -> list[dict]:
    return [m for m in data["data"].get("messages", []) if m.get("role") == "assistant"]


def send(text: str) -> None:
    result = post("receive-widget-message", {"conversation_id": cid, "session_token": token, "content": text}, {"idempotency-key": str(uuid.uuid4())})
    assert result.get("success") is True, result


def wait_reply(before: int, turn: int) -> dict:
    for _ in range(30):
        time.sleep(2)
        data = poll()
        msgs = assistants(data)
        if len(msgs) <= before:
            continue
        status = data["data"].get("conversation_status")
        assert status == "open", f"T{turn:02d} unexpected status={status} latest={msgs[-1]}"
        return msgs[-1]
    raise AssertionError(f"T{turn:02d} assistant timeout")


outputs = []
for n, text in enumerate(TURNS, start=1):
    before = len(assistants(poll()))
    send(text)
    latest = wait_reply(before, n)
    meta = latest.get("metadata") or {}
    outputs.append((latest.get("content") or "", meta))
    print("TURN=" + json.dumps({"n": n, "route": meta.get("response_route"), "content": latest.get("content")}, ensure_ascii=False))

# Production-blocking semantic assertions, not mere reply existence.
t8, m8 = outputs[7]
assert m8.get("response_route") == "prior_grounded_transform", (t8, m8)
assert (m8.get("transform_lineage") or {}).get("authority") == "PRIOR_GROUNDED_ANSWER", m8

t9, m9 = outputs[8]
assert m9.get("response_route") == "conversation_memory", m9
assert "香港" in t9 and "冷氣機" in t9, t9

t10, m10 = outputs[9]
assert m10.get("response_route") == "conversation_memory", m10
assert "Hong Kong" in t10 and "air conditioner" in t10.lower(), t10

t11, m11 = outputs[10]
assert m11.get("response_route") == "conversation_memory", m11
assert "香港" in t11 and "冷氣機" in t11, t11

print("DIRECTOR_TASK2_T01_T11_PROD_REGRESSION=PASS")
