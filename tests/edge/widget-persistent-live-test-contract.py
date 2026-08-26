#!/usr/bin/env python3
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
ui = (root/"src/routes/_authenticated/console.widget-preview.tsx").read_text()
edge = (root/"supabase/functions/widget-live-ai-test/index.ts").read_text()

ui_required = [
    'window.localStorage.getItem("widget_live_test_conversation_id")',
    'action: "history"',
    'action: "load"',
    'action: "send"',
    'test_conversation_id',
    'applyServerMessages',
    'loadLiveHistory',
    'appears in the AI Chatbot Inbox as test data',
]
for token in ui_required:
    assert token in ui, token

edge_required = [
    'mode: "persistent_live_ai_test"',
    'widget_live_test: true',
    'owner_user_id: userId',
    'exclude_training: true',
    'tags: ["widget_live_test", "exclude_training"]',
    'action === "history"',
    'action === "load"',
    'action !== "send"',
    'createTestConversation',
    'loadOwnedTestConversation',
    'naturalNoEvidenceReply',
    '.from("visitor_session")',
    '.from("conversations")',
    '.from("messages")',
    'Do NOT invent product facts',
    'Do not mention technical terms such as full_content',
]
for token in edge_required:
    assert token in edge, token

# Live AI invoke body must never send tenant/company/key/channel scope.
live_invoke_start = ui.index('supabase.functions.invoke(\n        "widget-live-ai-test"')
live_invoke_end = ui.index(');', live_invoke_start)
live_invoke = ui[live_invoke_start:live_invoke_end]
for token in ['company_id:', 'tenant_id:', 'api_key:', 'channel_id:']:
    assert token not in live_invoke, token

# Existing factual grounding remains full_content-only.
assert 'full_content_evidence' in edge
assert 'Use ONLY the Full Content Evidence below for factual claims.' in edge

# Cross-user access is denied by metadata owner validation.
assert 'm.owner_user_id === userId' in edge
assert 'test_conversation_not_found' in edge

# No production session RPC or public widget channel bypass.
for token in ['create_widget_session_tx', 'receive_widget_message_tx']:
    assert token not in edge, token

print("WIDGET PERSISTENT LIVE TEST CONTRACT: PASS")
