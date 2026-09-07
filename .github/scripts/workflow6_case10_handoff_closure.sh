#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
from pathlib import Path
p=Path('supabase/functions/_shared/conversation-intelligence.ts')
s=p.read_text()
old='const EXPLICIT_ZH = /(?:而家|現在|现在|即刻|立即).{0,8}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:請|请|麻煩|麻烦|幫我|帮我).{0,10}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我要|我想|我需要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我)?(?:而家|現在|现在|即刻|立即).{0,4}(?:要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)/;'
new='const EXPLICIT_ZH = /(?:而家|現在|现在|即刻|立即).{0,8}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:請|请|麻煩|麻烦|幫我|帮我).{0,10}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我要|我想|我需要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我)?(?:而家|現在|现在|即刻|立即).{0,4}(?:要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我)?(?:而家|現在|现在|即刻|立即)?(?:正式|明確|明确|確定|确定)(?:要|要求|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)/;'
if old not in s:
    if new in s:
        print('WORKFLOW6_HANDOFF_CLASSIFIER_PATCH=ALREADY_APPLIED')
    else:
        raise SystemExit('STOP: EXPLICIT_ZH anchor not found')
else:
    if s.count(old) != 1: raise SystemExit(f'STOP: EXPLICIT_ZH anchor count={s.count(old)}')
    s=s.replace(old,new,1)
    p.write_text(s)
    print('WORKFLOW6_HANDOFF_CLASSIFIER_PATCH=PASS')
PY

# Same-class classifier matrix: positive family plus frozen non-explicit precedence.
deno eval --node-modules-dir=auto '
import { classifyHandoffIntent } from "./supabase/functions/_shared/conversation-intelligence.ts";
const positives = [
  "今日一定要搞掂，我正式要真人。",
  "我正式要求真人。",
  "我明確要求真人客服。",
  "現在正式要人工客服。",
  "我确定要求人工客服。",
];
for (const input of positives) {
  const c=classifyHandoffIntent(input);
  if (!c.explicit_request || c.kind!=="explicit_now") throw new Error(`positive failed: ${input} => ${JSON.stringify(c)}`);
}
const negatives = [
  ["唔好轉真人。","negated"],
  ["如果處理唔到先轉真人。","conditional"],
  ["之後可能搵真人。","future"],
  ["假如我要真人會點？","conditional"],
  ["真人客服幾時有人？","question_about_human_support"],
];
for (const [input,kind] of negatives) {
  const c=classifyHandoffIntent(input);
  if (c.explicit_request || c.kind!==kind) throw new Error(`precedence failed: ${input} => ${JSON.stringify(c)} expected ${kind}`);
}
console.log("WORKFLOW6_HANDOFF_CLASSIFIER_MATRIX=PASS");'

deno check --node-modules-dir=auto supabase/functions/generate-reply/index.ts
echo WORKFLOW6_GENERATE_COMPILE=PASS

deno test --allow-env tests/edge/workflow5-multilingual-privacy.test.ts
deno test --allow-env tests/edge/workflow4-latest-condition-state.test.ts
deno test --allow-env tests/edge/task4-1-current-context-memory.test.ts
echo WORKFLOW6_FROZEN_REGRESSIONS=PASS

git config user.name 'ebixsolutions'
git config user.email '64578119+ebixsolutions@users.noreply.github.com'
git add supabase/functions/_shared/conversation-intelligence.ts
if ! git diff --cached --quiet; then
  git commit -m 'fix: honor explicit strengthened human handoff requests'
  git push origin HEAD:main
fi
echo "WORKFLOW6_FUNCTIONAL_COMMIT=$(git rev-parse HEAD)"

npx supabase functions deploy generate-reply --project-ref "$PROJECT_REF" --no-verify-jwt
echo WORKFLOW6_GENERATE_DEPLOY=PASS

# Fresh final consolidated 10-case production regression after the fix.
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run production-conversation-stress-10x24.yml --ref main
run_id=""
for _ in $(seq 1 40); do
  payload="$(gh run list --workflow production-conversation-stress-10x24.yml --branch main --event workflow_dispatch --limit 3 --json databaseId,createdAt)"
  run_id="$(jq -r --arg started "$started" '[.[]|select(.createdAt > $started)][0].databaseId // empty' <<<"$payload")"
  [[ -n "$run_id" ]] && break
  sleep 2
done
[[ -n "$run_id" ]] || { echo 'STOP: fresh Workflow 6 final run not found'; exit 1; }
echo "WORKFLOW6_FINAL_RUN_ID=$run_id"
set +e
gh run watch "$run_id" --exit-status
watch_rc=$?
set -e
jobs_json="$(gh run view "$run_id" --json jobs,conclusion,status)"
echo "$jobs_json" > /tmp/workflow6-final-jobs.json
total="$(jq '.jobs|length' <<<"$jobs_json")"
success="$(jq '[.jobs[]|select(.conclusion=="success")]|length' <<<"$jobs_json")"
failed="$(jq '[.jobs[]|select(.conclusion!="success")]|length' <<<"$jobs_json")"
echo "WORKFLOW6_FINAL_TOTAL_JOBS=$total"
echo "WORKFLOW6_FINAL_SUCCESS_JOBS=$success"
echo "WORKFLOW6_FINAL_FAILED_JOBS=$failed"
jq -r '.jobs[] | "WORKFLOW6_CASE_RESULT=\(.name):\(.conclusion)"' <<<"$jobs_json"
[[ "$watch_rc" -eq 0 ]] || { echo 'WORKFLOW6_FINAL_10X24=FAIL'; exit 1; }
[[ "$total" -eq 10 && "$success" -eq 10 && "$failed" -eq 0 ]] || { echo 'WORKFLOW6_FINAL_10X24=FAIL'; exit 1; }
echo WORKFLOW6_FINAL_10X24=PASS
