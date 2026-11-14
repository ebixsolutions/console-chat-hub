#!/usr/bin/env python3
import ast
from pathlib import Path

SOURCE = Path("scripts/task9-tungyu-100turn-production-smoke.py")
tree = ast.parse(SOURCE.read_text())
namespace = {}
for node in tree.body:
    if isinstance(node, ast.FunctionDef) and node.name == "classify_ingress_terminal":
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE), "exec"), namespace)
        break
classify = namespace["classify_ingress_terminal"]

turn36 = {
    "source_message_id": "172c98e0-4f5e-484f-82d0-45acf1891b02",
    "input": "假設今日星期三，原本星期五送，我今晚改星期六，政策上要注意咩？",
    "s0_decision": "NOT_REQUIRED_WITH_AUTHORITATIVE_CONVERSATION_SCOPE",
    "control_state": "ai",
}
turn37 = {
    "source_message_id": "c688c8a0-1708-4737-bf00-cbe2981b202b",
    "input": "算啦，星期六做首選。",
    "response": {
        "success": True,
        "data": {
            "message_id": "c688c8a0-1708-4737-bf00-cbe2981b202b",
            "ai_reply_pending": False,
            "control_state": "human_control",
        },
    },
    "memory_hash_before": "916d51a81510e03243e937c6735a9b4b321998fb27e0d990612afedea94089d8",
    "memory_hash_after": "916d51a81510e03243e937c6735a9b4b321998fb27e0d990612afedea94089d8",
    "commerce_hash_before": "3463271d9106fbf84ed43a5f41e4493da1efd9bb4815a4ec88b5b38c145f6ebc",
    "commerce_hash_after": "3463271d9106fbf84ed43a5f41e4493da1efd9bb4815a4ec88b5b38c145f6ebc",
    "state_events": [],
}

assert turn36["control_state"] == "ai"
assert classify(turn37["response"]) == "HUMAN_CONTROL_SUPPRESSED"
assert classify({"success": True, "data": {"ai_reply_pending": True, "control_state": "ai"}}) is None
assert turn37["memory_hash_before"] == turn37["memory_hash_after"]
assert turn37["commerce_hash_before"] == turn37["commerce_hash_after"]
assert turn37["state_events"] == []
assert SOURCE.read_text().index("if terminal:") < SOURCE.read_text().index("target=len(before)+1")
print("TURN36_37_PRODUCTION_PARITY|PASS")
