#!/usr/bin/env bash
set -euo pipefail

echo "HF1_GATE_VERSION=1"
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
assert 'deriveHF1RuntimeSignals' in g and 'deriveHandoffDecisionInput' in g
assert 'response_route:"warm_handoff_data_collection"' in g
print('HF1_SOURCE_ASSERTIONS=PASS')
PY

deno test supabase/functions/_shared/task1-closure-handoff.test.ts
echo "HF1_UNIT_GATE=PASS"

deno check supabase/functions/generate-reply/index.ts
echo "HF1_DENO_CHECK=PASS"

npm ci
npm run build
echo "HF1_BUILD_GATE=PASS"

echo "HF1_SOURCE_FINAL_GATE=PASS"
