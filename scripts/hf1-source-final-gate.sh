#!/usr/bin/env bash
set -euo pipefail

echo "HF1_GATE_VERSION=3"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

files=(
  "supabase/functions/_shared/handoff-decision.ts"
  "supabase/functions/_shared/conversation-closure.ts"
  "supabase/functions/_shared/warm-handoff.ts"
  "supabase/functions/_shared/task1-closure-handoff.test.ts"
  "supabase/functions/generate-reply/index.ts"
)
for f in "${files[@]}"; do
  test -s "$f" || { echo "HF1_FILE_NONEMPTY=FAIL:$f"; exit 11; }
done
echo "HF1_FILES_NONEMPTY=PASS"

node - <<'NODE'
const p=require('./package.json');
if(p.name !== 'tanstack_start_ts' || p.private !== true) process.exit(12);
console.log('HF1_REPO_BASELINE=PASS');
NODE

python3 - <<'PY'
from pathlib import Path
h=Path('supabase/functions/_shared/handoff-decision.ts').read_text()
c=Path('supabase/functions/_shared/conversation-closure.ts').read_text()
w=Path('supabase/functions/_shared/warm-handoff.ts').read_text()
g=Path('supabase/functions/generate-reply/index.ts').read_text()
assert 'handoff_not_blocked_for_missing_info' in h
assert 'human_request_count' in h and 'sentiment_trend' in h and 'unresolved_turns' in h
assert 'vip_tier' in h and 'predicted_csat' in h and 'churn_risk' in h
assert 'return { handoff_mode:"immediate", handoff_priority:"required"' in h
assert 'e2_threat_precedes_closure' in c and 'human_handoff_precedes_closure' in c
assert 'missing_fact_not_closure' in c and 'customer_has_no_more_help_requests' in c
assert '轉接仍會繼續' in w and 'handoff will still proceed' in w
assert 'explicit_handoff_tx' in g
assert 'persistExplicitR1IfRequested' in g and 'deriveHandoffDecisionInput' in g
assert 'anger_level: _pr5R3Sentiment?.anger_flag === true ? "high" : null' in g
assert 'sentiment_trend: _pr5R3Sentiment?.sentiment_trend ?? null' in g
assert 'unresolved_turns: _pr5History.consecutive_no_answer' in g
assert 'same_intent_repeat: _pr5History.exact_same_intent_repeated === true' in g
assert 'vip_tier: _hf1CustomerContext?.tier ?? null' in g
assert 'predicted_csat: _hf1CustomerContext?.predicted_csat ?? null' in g
assert 'churn_risk: _hf1CustomerContext?.churn_risk ?? null' in g
assert 'current_intent: _canonicalTurn.operation' in g
assert 'response_route:"warm_handoff_data_collection"' in g
print('HF1_SOURCE_ASSERTIONS=PASS')
PY

npm ci
echo "HF1_DEPENDENCY_INSTALL=PASS"

deno test supabase/functions/_shared/task1-closure-handoff.test.ts
echo "HF1_UNIT_GATE=PASS"

deno check supabase/functions/generate-reply/index.ts
echo "HF1_DENO_CHECK=PASS"

npm run build
echo "HF1_BUILD_GATE=PASS"

echo "HF1_SOURCE_FINAL_GATE=PASS"
