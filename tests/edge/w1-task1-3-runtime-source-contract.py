#!/usr/bin/env python3
from pathlib import Path
import sys
root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
def rd(p): return (root/p).read_text(encoding="utf-8")

pr7=rd("scripts/pr7-singapore-kb-runtime-smoke.sh")
pr9=rd("scripts/pr9-singapore-kb-authenticated-runtime-smoke.sh")
w=rd("scripts/w1-task1-3-widget-runtime-smoke.sh")
live=rd("supabase/functions/widget-live-ai-test/index.ts")
gen=rd("supabase/functions/generate-reply/index.ts")
client=rd("supabase/functions/_shared/kb-client.ts")
routing=rd("supabase/functions/_shared/conversational-routing.ts")
rules=rd("supabase/functions/_shared/escalation-rules.ts")

for s in (pr7,pr9):
    assert '"x-api-key"' in s or '"x-api-key":' in s
    assert '"company_id"' in s
    assert '"max_summary_chunks"' in s
    assert '"max_full_content_chunks"' in s
    assert '"context_found"' in s
    assert '"selected_documents"' in s
    assert '"has_context"' not in s
    assert '"max_summary"' not in s
    assert '"max_full_chunks"' not in s

assert 'status: "delivered"' in live
assert '/functions/v1/generate-reply' in live
assert 'test_conversation_under_human_control' in live
assert 'exclude_training: true' in live
assert 'commit_ai_reply_tx' in gen
assert 'explicit_handoff_tx' in gen
assert 'resolveTenantScope' in gen
assert 'full_content_evidence' in gen
assert 'company_id: companyId' in client
assert '?? "x-api-key"' in client

# Product-ready conversational source invariants.
assert 'classifyConversationalRoute' in routing
assert 'emoji/punctuation/noise-only' in routing
assert '"clarification_new_intent_no_kb_match"' in rules
assert '"repeated_after_clarification"' in rules

# Runtime smoke must prove actual product behavior, not the obsolete
# "no KB => immediate human" behavior.
assert 'greeting receives natural AI reply without handoff' in w
assert 'first normal KB no-match clarifies without human handoff' in w
assert 'different new KB no-match intent does not inherit previous clarification cap' in w
assert 'repeated unresolved intent after clarification persists R2 handoff' in w
assert 'W1_NO_CONTEXT_QUERY_ALT' in w
assert 'no-context path does not silently approve ungrounded answer' not in w

assert 'same source message produces no duplicate assistant answer' in w
assert 'takeover_conversation_tx' in w
assert 'return_to_ai_tx' in w
assert 'company_id":"forbidden"' in w

print("PASS W1 Task 1.3 Product-ready conversational runtime coverage assertions")
