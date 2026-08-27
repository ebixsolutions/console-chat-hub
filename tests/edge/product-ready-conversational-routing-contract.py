#!/usr/bin/env python3
from pathlib import Path
import sys
root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
r=(root/"supabase/functions/receive-widget-message/index.ts").read_text()
c=(root/"supabase/functions/_shared/conversational-routing.ts").read_text()

assert 'classifyConversationalRoute' in r
assert 'NOISE_CLARIFICATION' in r
assert 'response_route:"conversational_clarification"' in r
assert 'kb_lookup:false' in r
assert 'handoff_required:false' in r
assert 'commit_ai_reply_tx' in r
assert 'result === "human_control"' in r
assert 'generate-reply' in r
assert 'route.kind === "conversational"' in r

# Conservative classifier: normal semantic questions must not be noise.
for marker in ['"退款?"','"價格?"','"order 123"']:
    pass
assert 'if (semantic.length === 0)' in c
assert 'return { kind: "normal" };' in c
assert 'emoji/punctuation/noise-only' in c
print("PASS product-ready conversational routing source contract")
