#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

DOC="$ROOT/docs/AI_CHATBOT_PRODUCT_READY_WORKFLOW.md"
CFG="$ROOT/config/ai-chatbot-product-ready-workflows.json"

[ -s "$DOC" ] || { echo "FAIL: workflow doc missing/empty" >&2; exit 1; }
[ -s "$CFG" ] || { echo "FAIL: workflow config missing/empty" >&2; exit 1; }

python3 - "$CFG" <<'PY'
import json, sys
p=sys.argv[1]
d=json.load(open(p))
assert d["branch"]=="main"
assert d["package_marker"]["package"]=="@lovable.dev/vite-tanstack-config"
assert d["package_marker"]["version"]=="2.13.1"
assert d["lovable_chat_policy"]["source_changes"]=="PROHIBITED"
assert d["lovable_chat_policy"]["debugging"]=="PROHIBITED"
assert d["lovable_chat_policy"]["replacement_packages"]=="PROHIBITED"
assert len(d["workflows"])==3
for w in d["workflows"]:
    assert 1 <= len(w["tasks"]) <= 3, (w["id"], len(w["tasks"]))
ids=[t["id"] for w in d["workflows"] for t in w["tasks"]]
assert len(ids)==len(set(ids))
assert len(d["singapore_server_required_inputs"])>=5
print("PASS: 3 workflows; max 3 tasks/workflow; Lovable Chat policy locked")
PY

grep -q 'Base44 Knowledge Base App: `6a12c8b68d8278b4c735e9eb`' "$DOC"
grep -q 'Lovable Chat is prohibited for source implementation' "$DOC"
grep -q 'Workflow 1 — Runtime & Knowledge Closure' "$DOC"
grep -q 'Workflow 2 — Canonical Tenant, CE & SU CoachAI Activation' "$DOC"
grep -q 'Workflow 3 — Whole-product Product-ready Closure' "$DOC"

echo "AI CHATBOT PRODUCT READY WORKFLOW GATE: PASS"
