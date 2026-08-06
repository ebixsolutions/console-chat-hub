#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
CONTRACT="CE-T2-C20-EVIDENCE-CLOSURE-v1.0"; PKG="nexusai-3task-current-27"
CASES=(E-AUTH-01 E-AUTH-02 E-AUTH-03 E-AUTH-04 E-AUTH-05 E-HTTP-01 E-HTTP-02 E-HTTP-03 E-HTTP-04 E-HTTP-05 E-BODY-01 E-BODY-02 E-BODY-03 E-BODY-04 E-BODY-05 E-BODY-06 E-BODY-07 E-BODY-08 E-TENANT-01 E-TENANT-02 E-TENANT-03 E-TENANT-04 E-TENANT-05 E-TENANT-06 E-TENANT-07 E-GROUND-01 E-GROUND-02 E-GROUND-03 E-GROUND-04 E-GROUND-05 E-GROUND-06 E-GROUND-07 E-GROUND-08 E-LLM-01 E-LLM-02 E-LLM-03 E-LLM-04 E-LLM-05 E-LLM-06 E-LLM-07 E-LLM-08 E-LLM-09 E-LLM-10 E-RPC-01 E-RPC-02 E-RPC-03 E-RPC-04 E-RPC-05 E-RPC-06 E-RPC-07 E-RPC-08 E-RPC-09 E-RPC-10 E-RPC-11 E-RPC-12)
write_blocked(){
 python3 - "$1" "${#CASES[@]}" <<'PYBLOCK'
import json,sys,datetime,hashlib,os
m=json.load(open('validation/execution-metadata.json')); err=sys.argv[1]; n=int(sys.argv[2])
files=['supabase/functions/conversation-evaluate/index.ts','supabase/functions/_shared/ce-contract.ts','supabase/functions/_shared/ce-grounding.ts','supabase/functions/_shared/llm-router.ts','supabase/functions/_shared/cors.ts','supabase/functions/deno.json','tests/stubs/llm-stub-server.ts','tests/edge/ce-edge-contract-runtime.py']
h={p:hashlib.sha256(open(p,'rb').read()).hexdigest() for p in files if os.path.isfile(p)}
r={'contract_id':'CE-T2-C20-EVIDENCE-CLOSURE-v1.0','package_version':'nexusai-3task-current-27','task_run_id':m['task_run_id'],'generated_at':datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),'environment':{'docker':'unavailable'},'command':'bash scripts/ce-task2-edge-contract.sh','exit_code':2,'pass':0,'fail':0,'skip':0,'blocked':n,'blocker':{'resource':'Docker/Supabase local runtime','command_attempted':'docker info','stderr':err[:500],'responsible_owner':'Director / CI owner','owner_command':'cd repo && supabase start && supabase db reset && supabase functions serve --env-file .env.test & bash scripts/ce-task2-edge-contract.sh'},'tested_source_hashes':h,'status':'BLOCKED'}
json.dump(r,open('validation/results/edge-contract.json','w'),indent=2)
PYBLOCK
 echo 'BLOCKED: Docker/Supabase runtime unavailable'; exit 2
}
command -v docker >/dev/null 2>&1 || write_blocked 'docker: command not found'
docker info >/tmp/ce-docker.out 2>/tmp/ce-docker.err || write_blocked "$(cat /tmp/ce-docker.err)"
for t in jq curl psql python3 supabase; do command -v "$t" >/dev/null || { echo "FAIL: missing $t"; exit 1; }; done
: "${SUPABASE_URL:?required}"; : "${SUPABASE_ANON_KEY:?required}"; : "${SUPABASE_SERVICE_ROLE_KEY:?required}"; : "${DATABASE_URL:?required}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/edge/ce-edge-contract-fixtures.sql >/tmp/ce-edge-fixtures.out
for fn in ce_test_prepare_case ce_test_case_request ce_test_assert_case ce_test_cleanup_case ce_test_fixture_leaks; do
  psql "$DATABASE_URL" -Atq -v ON_ERROR_STOP=1 -c "select to_regprocedure('public.'||'$fn'||'(text)') is not null" | grep -qx t || { echo "FAIL: missing harness function $fn"; exit 1; }
done
python3 tests/edge/ce-edge-contract-runtime.py --result validation/results/edge-contract.json
