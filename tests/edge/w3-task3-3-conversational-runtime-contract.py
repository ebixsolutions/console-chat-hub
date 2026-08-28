#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[2]
gen = (root / "supabase/functions/generate-reply/index.ts").read_text()
rules = (root / "supabase/functions/_shared/escalation-rules.ts").read_text()
shadow = (root / "supabase/functions/_shared/escalation-shadow.ts").read_text()
live = (root / "supabase/functions/widget-live-ai-test/index.ts").read_text()
preview = (root / "src/routes/_authenticated/console.widget-preview.tsx").read_text()
ci = (root / "supabase/functions/_shared/conversation-intelligence.ts").read_text()

for marker in [
    "classifyHandoffIntent",
    "classifyConversationTurn",
    "CUSTOMER_CONVERSATION_POLICY",
    "NATURAL_CLARIFICATION",
    "hasUsableFullContentEvidence",
    "isHumanControlState",
]:
    assert marker in gen, marker

assert "pure_handoff_negation = availableSignal" in gen
assert 'response_route: "conversational_clarification"' in gen
assert 'answerability: "missing_full_content_evidence"' in gen
assert "CUSTOMER_CONVERSATION_POLICY, buildMaskedContextBlock" in gen
assert 'status === "pending"' in rules
assert 'status === "human_control"' in rules
assert "classifyHandoffIntent" in shadow
assert "pure_handoff_negation = availableSignal" in shadow

for forbidden in [
    "If you cannot answer a question confidently, acknowledge it honestly and offer to connect",
]:
    assert forbidden not in gen, forbidden

for marker in ["assigned_agent_id", "human_control", "conversation_status"]:
    assert marker in live, marker
for marker in [
    "recovered?.humanControl",
    "真人客服處理中，AI 輸入已暫停",
    'humanState !== "none"',
]:
    assert marker in preview, marker

for marker in [
    '"explicit_now"',
    '"negated"',
    '"conditional"',
    '"future"',
    '"reference"',
    '"hypothetical"',
    "question_about_human_support",
    "semantic_intent_present_but_required_detail_missing",
]:
    assert marker in ci, marker

# Customer policy must explicitly prohibit internal diagnostic leakage.
for marker in ["Knowledge Base", "RAG", "confidence score", "routing", "provider"]:
    assert marker in ci, marker

print("PASS Task 3.3 conversational runtime source contract")
