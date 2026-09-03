import json
import os
import time
import urllib.request
import uuid

PROJECT_REF = os.environ.get("PROJECT_REF", "nrfxhqabwblzxoushgnm")
BASE = os.environ.get(
    "VITE_SUPABASE_FUNCTIONS_URL",
    f"https://{PROJECT_REF}.supabase.co/functions/v1",
).rstrip("/")
ORIGIN = os.environ.get("PROD_ORIGIN", "https://console-chat-hub.lovable.app")
CHANNEL_ID = os.environ.get("CHANNEL_ID", "b0000000-0000-0000-0000-000000000001")


def post(path: str, payload: dict, extra_headers: dict | None = None) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json", "Origin": ORIGIN}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(f"{BASE}/{path}", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


created = post(
    "create-visitor-session",
    {
        "channel_id": CHANNEL_ID,
        "visitor_metadata": {
            "director_task1_postdeploy_smoke": True,
            "exclude_training": True,
        },
    },
)
assert created.get("success") is True, created
session = created["data"]
conversation_id = session["conversation_id"]
session_token = session["session_token"]
print(f"TASK1_SMOKE_CONVERSATION_ID={conversation_id}")


def poll() -> dict:
    return post(
        "widget-poll-messages",
        {"conversation_id": conversation_id, "session_token": session_token},
    )


def assistant_messages(data: dict) -> list[dict]:
    return [
        message
        for message in data["data"].get("messages", [])
        if message.get("role") == "assistant"
    ]


before = len(assistant_messages(poll()))
sent = post(
    "receive-widget-message",
    {
        "conversation_id": conversation_id,
        "session_token": session_token,
        "content": "什么是四電一腦？",
    },
    {"idempotency-key": str(uuid.uuid4())},
)
assert sent.get("success") is True, sent

latest = None
latest_poll = None
for _ in range(40):
    time.sleep(2)
    latest_poll = poll()
    messages = assistant_messages(latest_poll)
    if len(messages) > before:
        latest = messages[-1]
        break

assert latest is not None, "assistant reply timeout"
status = latest_poll["data"].get("conversation_status")
assert status == "open", f"unexpected conversation status: {status}"
content = str(latest.get("content") or "").strip()
assert content, "empty assistant reply"
metadata = latest.get("metadata") or {}
lineage = metadata.get("citation_lineage")
assert isinstance(lineage, dict), f"citation_lineage missing: {metadata}"
selected_document_id = str(lineage.get("selected_document_id") or "").strip()
assert selected_document_id, f"selected_document_id missing: {metadata}"
evidence_count = lineage.get("evidence_count")
assert isinstance(evidence_count, int) and evidence_count >= 1, f"invalid evidence_count: {metadata}"
citations = metadata.get("citations")
assert isinstance(citations, list) and len(citations) >= 1, f"citations missing: {metadata}"
assert all(
    str(citation.get("document_id") or "") == selected_document_id
    for citation in citations
), f"cross-document citation lineage: {metadata}"

print(
    "TASK1_T01="
    + json.dumps(
        {
            "conversation_status": status,
            "selected_document_id": selected_document_id,
            "evidence_count": evidence_count,
            "citation_count": len(citations),
            "content": content,
        },
        ensure_ascii=False,
    )
)
print("DIRECTOR_TASK1_POSTDEPLOY_T01=PASS")
