from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
widget = (ROOT / "supabase/functions/widget-live-ai-test/index.ts").read_text()
kb = (ROOT / "supabase/functions/_shared/kb-client.ts").read_text()
crm = (ROOT / "src/components/console/CRMPanel.tsx").read_text()

assert "fetchKBRag(" not in widget
assert "callModel(" not in widget
assert "/functions/v1/generate-reply" in widget
assert "source_message_id" in widget
assert "test_conversation_under_human_control" in widget
assert "owner_user_id" in widget and "exclude_training" in widget

assert "trustedWidgetLiveTestActor" in kb
assert '.select("company_id, channel_config_id, metadata_source")' in kb
assert "resolvePreActivationScope(sb, trustedActor)" in kb
assert "KB_PREACTIVATION_MEMBERSHIP_PRESENT" in kb

assert "normalizeKBResults" in crm
assert "normalizePolicyResult" in crm
assert "const results = data.results as KBResult[]" not in crm
assert "setPolResult(data.result as PolicyResult)" not in crm

print("PASS widget routes through canonical generate-reply")
print("PASS trusted preactivation scope is DB-metadata-bound and independently authorized")
print("PASS CRM KB/Policy runtime normalization")
