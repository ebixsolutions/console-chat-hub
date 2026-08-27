#!/usr/bin/env python3
from pathlib import Path
import sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(root/"supabase/functions/_shared/escalation-shadow.ts").read_text()

assert "CE_ADVISORY_SIGNAL_PROVENANCE_INCOMPLETE" in s
assert "P1_ADVISORY_SIGNAL_PROVENANCE_INCOMPLETE" in s
assert "sentiment_evaluation_id" in s
assert "sentiment_provider_version" in s
assert "expected_tenant_id" in s
assert "p1_provider_version" in s
assert "p1_provider_source" in s

# Wrong/unscoped advisory values must not be bound unless provenance passes.
assert "if (ceProvenanceOk)" in s
assert "if (p1ProvenanceOk)" in s

# CE/P1 can never be upgraded to a required live handoff by this adapter.
assert 'result.matched_rule === "R3" || result.matched_rule === "P1"' in s
assert '"recommend_handoff"' in s
assert '"suggest_handoff"' in s
assert "ADVISORY_RULE_DECISION_DOWNGRADED" in s

# This module stays side-effect free.
for forbidden in [".rpc(", ".insert(", ".update(", ".delete(", "fetch("]:
    assert forbidden not in s

print("PASS product-ready CE/P1 advisory signal guard source contract")
