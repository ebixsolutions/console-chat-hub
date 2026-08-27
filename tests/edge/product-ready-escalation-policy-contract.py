#!/usr/bin/env python3
from pathlib import Path
import sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(root/"supabase/functions/_shared/escalation-rules.ts").read_text()

assert "first normal KB gap gets one clarification" in s
assert '"clarification_required_before_r2"' in s
assert '"repeated_after_clarification"' in s
assert '"repeated_unanswered_query"' in s
assert 'return decision("R3", "recommend_handoff"' in s
assert 'return decision("P2", "recommend_handoff"' in s
assert 'return decision("R4", "recommend_handoff"' in s
assert 'return decision("P1", "suggest_handoff"' in s
assert 'return decision("R1", "handoff"' in s
assert 'decision("E2", "handoff"' in s
assert 'decision("E1", "handoff"' in s

old='if (!repeated || noAnswerCount === null || !ragGap) return null;'
assert old not in s
assert "A new/different intent is allowed to" in s
print("PASS product-ready escalation policy contract")
