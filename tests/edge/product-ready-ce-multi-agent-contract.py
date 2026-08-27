#!/usr/bin/env python3
from pathlib import Path
import sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
legacy=(root/"src/lib/ce/evaluators.ts").read_text()
auto=(root/"supabase/functions/_shared/ce-automation-engine.ts").read_text()
ce=(root/"supabase/functions/conversation-evaluate/index.ts").read_text()
contract=(root/"supabase/functions/_shared/ce-contract.ts").read_text()

# Legacy heuristic path may exist only as explicit test/dev fixture.
assert "deterministicEvaluatorsForTests" in legacy
assert "deterministicEvaluators:" not in legacy
assert "evaluators: Record<CeEvaluatorId, CeEvaluator>," in legacy
assert "CE_EVALUATORS_REQUIRED" in legacy
assert "CE_EVALUATOR_SET_INCOMPLETE" in legacy

# Canonical runtime is true multi-agent evaluation: six independent dimensions.
for d in ["accuracy","policy","tone","sales","context","hallucination_risk"]:
    assert d in contract
assert "CE_DIMENSIONS.map" in auto
assert "Promise.all" in auto
assert "runEvaluator(" in auto
assert 'purpose: "evaluation"' in auto
assert "EVALUATOR_RESPONSE_SCHEMA" in auto
assert "validateEvaluatorOutput" in auto
assert "fetchGrounding" in auto
assert "complete_evaluation_v2" in auto

# Manual/API CE follows same six-agent governed shape, not heuristic fallback.
assert "CE_DIMENSIONS.map" in ce
assert "runEvaluator(" in ce
assert "EVALUATOR_RESPONSE_SCHEMA" in ce
assert "validateEvaluatorOutput" in ce
assert "fetchGrounding" in ce
assert "complete_evaluation_v2" in ce

# Signals extraction is a separate model call feeding emotion + next steps.
assert "runSignals(" in auto
assert "SIGNALS_SYSTEM_PROMPT" in auto
assert "validateSignalsOutput" in auto

# Fixed canonical dimension weights.
for marker in [
    'accuracy: 0.25',
    'policy: 0.2',
    'tone: 0.2',
    'sales: 0.15',
    'context: 0.1',
    'hallucination_risk: 0.1',
]:
    assert marker in contract

print("PASS product-ready CE multi-agent / no-heuristic-fallback contract")
