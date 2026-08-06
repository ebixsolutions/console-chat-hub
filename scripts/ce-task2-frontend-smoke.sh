#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
CONTRACT="CE-T2-C20-EVIDENCE-CLOSURE-v1.0"
PKG="nexusai-3task-current-27"
TRID=$(jq -r '.task_run_id' validation/execution-metadata.json 2>/dev/null)
SPEC="tests/ce-smoke/ce-evaluation.spec.ts"

# Count actual declared cases from spec
CASE_COUNT=$(grep -c '^test(' "$SPEC" 2>/dev/null)
[ "$CASE_COUNT" -gt 0 ] || { echo "FATAL: no test cases in $SPEC"; exit 1; }

src_hashes() {
  python3 -c "
import json,hashlib,os
h={}
for f in ['src/routes/_authenticated/console.conversation-evaluation.tsx',
          'src/routes/_authenticated/console.conversation-evaluation.index.tsx',
          'src/routes/_authenticated/console.conversation-evaluation.\$evaluationId.tsx',
          'src/lib/ce/scoring.ts','src/components/console/PageStates.tsx',
          '$SPEC','package.json']:
    if os.path.exists(f):
        with open(f,'rb') as fh: h[f]=hashlib.sha256(fh.read()).hexdigest()
print(json.dumps(h))
"
}

# Check for full repo + Playwright
if [ ! -f "vite.config.ts" ] && [ ! -f "app.config.ts" ]; then
  python3 -c "
import json
result={'contract_id':'$CONTRACT','package_version':'$PKG','task_run_id':'$TRID',
    'generated_at':'$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'environment':{},'command':'bash scripts/ce-task2-frontend-smoke.sh',
    'exit_code':1,'pass':0,'fail':0,'skip':0,'blocked':$CASE_COUNT,
    'blocker':{'resource':'Complete Lovable repo + Playwright',
        'test_spec':'$SPEC','declared_cases':$CASE_COUNT,
        'access_attempts':[
            {'method':'git clone','error':'No git URL for Lovable projects'},
            {'method':'Lovable:send_message','error':'Forbidden (lovable_chat=0)'},
            {'method':'Live repo','result':'No test/e2e scripts in package.json'}],
        'responsible_owner':'Director',
        'owner_command':'npm i -D @playwright/test && npx playwright install && APP_URL=<url> npx playwright test $SPEC'},
    'tested_source_hashes':$(src_hashes),
    'status':'BLOCKED'}
with open('validation/results/frontend-smoke.json','w') as f: json.dump(result,f,indent=2)
print('BLOCKED: $CASE_COUNT cases, complete repo + Playwright required')
"
  exit 1
fi

if ! command -v npx >/dev/null 2>&1 || ! npx playwright --version >/dev/null 2>&1; then
  echo "BLOCKED: Playwright not installed"
  exit 1
fi

APP_URL="${APP_URL:-https://console-chat-hub.lovable.app}" npx playwright test "$SPEC" --reporter=json 2>&1
exit $?
