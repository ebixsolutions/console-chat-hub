#!/usr/bin/env python3
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
src = (root / "src/routes/_authenticated/console.widget-preview.tsx").read_text()

required = [
    'type PreviewMode = "simulation" | "live"',
    'useState<PreviewMode>("live")',
    'supabase.functions.invoke(',
    '"widget-live-ai-test"',
    'body: { query: text }',
    'previewMode === "live"',
    'Live AI Test · Real KB + Vertex',
    'full_content_evidence_count',
    'scope_mode',
    'setPreviewMode("simulation")',
    'setPreviewMode("live")',
    'mode === "live"',
    'mode === "simulation"',
]
for token in required:
    assert token in src, token

# The old regression must not remain as the unconditional send path.
assert 'setTimeout(() => {' in src, "simulation timer should remain for UI mode"
assert 'void runLiveAi(text)' in src, "live send path missing"

# The frontend must not attempt to create production channel/session/data.
for forbidden in [
    'create-visitor-session',
    'receive-widget-message',
    'widget-poll-messages',
    '.from("messages").insert',
    '.from("conversations").insert',
    '.from("visitor_session").insert',
    'company_id:',
    'tenant_id:',
    'api_key:',
]:
    assert forbidden not in src, forbidden

# Live handoff remains explicitly non-writing.
assert 'does not create production handoff state' in src
assert 'No production write' in src

print("WIDGET PREVIEW LIVE AI WIRING CONTRACT: PASS")
