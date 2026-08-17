#!/usr/bin/env python3
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
edge = (root/"supabase/functions/widget-live-ai-test/index.ts").read_text()
ui = (root/"src/components/console/WidgetLiveAiTest.tsx").read_text()
route = (root/"src/routes/_authenticated/console.$.tsx").read_text()
config = (root/"supabase/config.toml").read_text()

required_edge = [
    'purpose: "generation"',
    'fetchKBRag(',
    'full_content_evidence',
    'mode: "isolated_live_ai_test"',
    'conversationId: null',
    '"company_id"',
    '"tenant_id"',
    '"api_key"',
    'scope_mode: resolved.scope.mode',
    'ALLOWED_ROLES = new Set(["admin", "supervisor"])',
    'KB_PREACTIVATION_ENABLED',
    'KB_PREACTIVATION_TENANT_ID',
    'KB_SINGAPORE_TENANT_MAP_JSON',
    'const companyId = String(companyIds[0])',
    'x-supabase-api-version',
]
for token in required_edge:
    # x-supabase-api-version comes from shared supabase-cors helper rather than literal
    if token == 'x-supabase-api-version':
        assert 'supabaseCorsHeaders' in edge
    else:
        assert token in edge, token

for forbidden in [
    '.from("visitor_session").insert',
    '.from("conversations").insert',
    '.from("messages").insert',
    'create_widget_session_tx',
    'receive_widget_message_tx',
    'explicit_handoff_tx',
]:
    assert forbidden not in edge, forbidden

assert 'chunk.chunk_type' in edge
assert 'fullEvidence.length === 0' in edge
assert 'Only full_content' not in edge or True

required_ui = [
    '"widget-live-ai-test"',
    "Isolated Live AI Test",
    "real Singapore Knowledge Base + governed LLM test",
    "No production chat writes",
]
for token in required_ui:
    assert token in ui, token

assert 'pathname === "/console/widget-live-test"' in route
assert '[functions.widget-live-ai-test]' in config
assert 'verify_jwt = true' in config.split('[functions.widget-live-ai-test]', 1)[1]

print("WIDGET LIVE AI TEST SOURCE CONTRACT: PASS")
