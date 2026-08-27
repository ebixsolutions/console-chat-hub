#!/usr/bin/env python3
from pathlib import Path
import sys
root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
rules=(root/"supabase/functions/_shared/escalation-rules.ts").read_text()
live=(root/"supabase/functions/_shared/escalation-live.ts").read_text()

assert '"clarification_new_intent_no_kb_match"' in rules
assert 'if (!repeated)' in rules
assert '"repeated_after_clarification"' in rules
assert '"repeated_unanswered_query"' in rules

assert '"max_clarifications_reached"' in live
assert '"commit_ai_reply_tx"' in live
assert 'response_route: "kb_no_match_recovery"' in live
assert 'handoff_required: false' in live
assert 'input.decision.reason_code === "clarification_new_intent_no_kb_match"' in live
assert '"human_control"' in live
assert '"resolved"' in live

# Old/new-intent behavior must not silently become human handoff.
new_intent=rules.index('if (!repeated)')
handoff=rules.index('"repeated_after_clarification"')
assert new_intent < handoff

print("PASS product-ready KB no-match recovery source contract")
