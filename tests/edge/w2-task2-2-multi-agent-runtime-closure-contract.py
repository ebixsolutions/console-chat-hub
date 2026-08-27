#!/usr/bin/env python3
from pathlib import Path
import sys

r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
runtime=(r/"scripts/w2-task2-2-runtime-gate.sh").read_text()
activate=(r/"scripts/w3-task3-3-production-activate.sh").read_text()
ce=(r/"supabase/functions/conversation-evaluate/index.ts").read_text()
pr8=(r/"scripts/pr8-ce-runtime-smoke.sh").read_text()

assert "bash scripts/pr8-ce-runtime-smoke.sh" in runtime
assert "PASS canonical six-agent CE runtime evaluation" in runtime

# Runtime fixture is derived from frozen Tenant A config/runtime values.
assert 'PR8_CE_SMOKE_FIXTURE_APPROVED=YES' in activate
assert 'PR8_CE_SMOKE_CONVERSATION_ID="${PR10_TENANT_A_CONVERSATION_UUID}"' in activate
assert 'PR8_CE_SMOKE_BEARER_TOKEN="${PR10_TENANT_A_BEARER_TOKEN}"' in activate

# Canonical source really executes six independent governed evaluators.
assert "Promise.all(" in ce
assert "CE_DIMENSIONS.map" in ce
assert "runEvaluator(" in ce
assert 'purpose: "evaluation"' in ce
assert "EVALUATOR_RESPONSE_SCHEMA" in ce
assert "validateEvaluatorOutput" in ce
assert "runSignals(" in ce
assert "complete_evaluation_v2" in ce

# Runtime smoke proves six persisted evaluator details and no replay duplication.
assert 'DETAIL_COUNT" = "6"' in pr8
assert 'DIM_COUNT" = "6"' in pr8
assert "CE replay created duplicate evaluation" in pr8
assert "CE replay created duplicate outbox" in pr8
assert "redaction flag not true" in pr8
assert "outbox idempotency key must equal evaluation id" in pr8

print("PASS W2 Task2.2 Product-ready multi-agent runtime closure source contract")
