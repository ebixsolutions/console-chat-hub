#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
from pathlib import Path
p=Path('.github/workflows/production-conversation-stress-10x24.yml')
s=p.read_text()
old="                  for pat in case.get('forbid_regex',[]):\n                      if re.search(pat,content): fail('FORBIDDEN_CONTENT',turn=i,pattern=pat,output=content[:500])\n"
new="                  for pat in case.get('forbid_regex',[]):\n                      if re.search(pat,content):\n                          roadmap_refusal = CASE_ID=='05' and bool(re.search(r\"(?i)(無法|无法|不能|不會|不会|唔會|cannot|can.?t|unable|not able).{0,30}(承諾|承诺|promise|保證|保证|confirmed|預計|预计|expected).{0,20}(Q1|第一季)\",content))\n                          if not roadmap_refusal: fail('FORBIDDEN_CONTENT',turn=i,pattern=pat,output=content[:500])\n"
if old not in s:
    if new in s:
        print('WORKFLOW6_ROADMAP_ASSERTION_PATCH=ALREADY_APPLIED')
    else:
        raise SystemExit('STOP: forbid assertion anchor not found')
else:
    if s.count(old)!=1: raise SystemExit(f'STOP: forbid assertion anchor count={s.count(old)}')
    p.write_text(s.replace(old,new,1))
    print('WORKFLOW6_ROADMAP_ASSERTION_PATCH=PASS')
PY

python - <<'PY'
import re
def forbidden(content):
    pat=r'(?i)(confirmed|確定|保證|promise|承諾).{0,20}(Q1|第一季)'
    if not re.search(pat,content): return False
    refusal=bool(re.search(r"(?i)(無法|无法|不能|不會|不会|唔會|cannot|can.?t|unable|not able).{0,30}(承諾|承诺|promise|保證|保证|confirmed|預計|预计|expected).{0,20}(Q1|第一季)",content))
    return not refusal
assert forbidden('因此無法承諾Q1。') is False
assert forbidden('我承諾Q1推出。') is True
assert forbidden('confirmed Q1 launch') is True
print('WORKFLOW6_ROADMAP_ASSERTION_MATRIX=PASS')
PY

git config user.name 'ebixsolutions'
git config user.email '64578119+ebixsolutions@users.noreply.github.com'
git add .github/workflows/production-conversation-stress-10x24.yml
if ! git diff --cached --quiet; then
  git commit -m 'test: distinguish roadmap refusal from false promise'
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git push origin HEAD:main
else
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  gh workflow run production-conversation-stress-10x24.yml --ref main
fi
echo "WORKFLOW6_ASSERTION_COMMIT=$(git rev-parse HEAD)"

run_id=""
for _ in $(seq 1 40); do
  payload="$(gh run list --workflow production-conversation-stress-10x24.yml --branch main --limit 8 --json databaseId,createdAt,event)"
  run_id="$(jq -r --arg started "$started" '[.[]|select(.createdAt > $started and (.event=="push" or .event=="workflow_dispatch"))][0].databaseId // empty' <<<"$payload")"
  [[ -n "$run_id" ]] && break
  sleep 2
done
[[ -n "$run_id" ]] || { echo 'STOP: final Workflow 6 run not found'; exit 1; }
echo "WORKFLOW6_FINAL_RUN_ID=$run_id"
gh run watch "$run_id" --exit-status
jobs_json="$(gh run view "$run_id" --json jobs,conclusion,status)"
total="$(jq '.jobs|length' <<<"$jobs_json")"
success="$(jq '[.jobs[]|select(.conclusion=="success")]|length' <<<"$jobs_json")"
failed="$(jq '[.jobs[]|select(.conclusion!="success")]|length' <<<"$jobs_json")"
echo "WORKFLOW6_FINAL_TOTAL_JOBS=$total"
echo "WORKFLOW6_FINAL_SUCCESS_JOBS=$success"
echo "WORKFLOW6_FINAL_FAILED_JOBS=$failed"
jq -r '.jobs[] | "WORKFLOW6_CASE_RESULT=\(.name):\(.conclusion)"' <<<"$jobs_json"
[[ "$total" -eq 10 && "$success" -eq 10 && "$failed" -eq 0 ]] || { echo 'WORKFLOW6_FINAL_10X24=FAIL'; exit 1; }
echo WORKFLOW6_FINAL_10X24=PASS
