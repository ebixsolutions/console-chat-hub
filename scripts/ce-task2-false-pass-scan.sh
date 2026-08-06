#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
F=0
bad(){ echo "FAIL: $1"; F=$((F+1)); }
EDGE=scripts/ce-task2-edge-contract.sh
DRIVER=tests/edge/ce-edge-contract-runtime.py
SPEC=tests/ce-smoke/ce-evaluation.spec.ts
FIX=tests/edge/ce-edge-contract-fixtures.sql
for f in "$EDGE" "$DRIVER" "$SPEC" "$FIX"; do [ -s "$f" ] || bad "missing $f"; done
for p in 'expect(true)\.toBe(true)' 'test\.skip\(' '\.catch\(\(\) => \{\}\)' 'covered by' 'tested via' 'requires full stack' 'simulated/placeholder' '\[ -n "\$ERROR_CODE" \].*ok' 'HTTP_CODE.*!=' 'check_no_leak.*&&.*ok' '2>/dev/null.*curl'; do
  grep -RInE "$p" "$EDGE" "$DRIVER" "$SPEC" "$FIX" >/tmp/ce-fp 2>/dev/null && { cat /tmp/ce-fp; bad "$p"; } || true
done
python3 - <<'PYSCAN' || F=$((F+1))
import ast,re
D=open('tests/edge/ce-edge-contract-runtime.py').read()
E=open('scripts/ce-task2-edge-contract.sh').read()
S=open('tests/ce-smoke/ce-evaluation.spec.ts').read()
X=open('tests/edge/ce-edge-contract-fixtures.sql').read()
exp=[]
for p,n in [('AUTH',5),('HTTP',5),('BODY',8),('TENANT',7),('GROUND',8),('LLM',10),('RPC',12)]:
    exp += [f'E-{p}-{i:02d}' for i in range(1,n+1)]
for name,t in [('edge',E),('driver',D)]:
    ids=set(re.findall(r'E-(?:AUTH|HTTP|BODY|TENANT|GROUND|LLM|RPC)-\d{2}',t))
    miss=set(exp)-ids
    if miss: raise SystemExit(f'{name} missing {sorted(miss)}')
front=set(re.findall(r'F-(?:LIST|NAV|DETAIL|AUTH|ARCH|FAIL)-\d{2}',S))
if len(front)!=30: raise SystemExit(f'frontend {len(front)} != 30')
for x in ['setup(c)','action(c)','assert_case(c','cleanup(c)']:
    if x not in D: raise SystemExit('lifecycle incomplete '+x)
# Evaluate only top-level constant section ending before LEAK; no test execution.
ns={}
prefix=D.split('LEAK=',1)[0]
exec(compile(prefix,'tests/edge/ce-edge-contract-runtime.py','exec'),ns,ns)
case_ids=ns['CASE_IDS']; expected=ns['EXPECTED']
if set(case_ids)!=set(expected): raise SystemExit('EXPECTED map coverage mismatch')
if len(expected)!=55: raise SystemExit(f'EXPECTED map size {len(expected)} != 55')
# E-RPC-09 is intentionally DB-only; all other cases require explicit HTTP expectations.
if [k for k,v in expected.items() if v is None] != ['E-RPC-09']:
    raise SystemExit('unexpected DB-only cases')
required={
'E-TENANT-01':(503,'unavailable'),'E-TENANT-02':(403,'forbidden'),'E-TENANT-03':(403,'forbidden'),
'E-TENANT-04':(403,'forbidden'),'E-TENANT-05':(404,'not_found'),'E-TENANT-06':(403,'forbidden'),
'E-TENANT-07':(400,'invalid_request'),'E-GROUND-02':(503,'unavailable'),'E-GROUND-04':(503,'unavailable'),
'E-GROUND-05':(403,'forbidden'),'E-GROUND-06':(400,'invalid_request'),'E-GROUND-07':(503,'unavailable'),
'E-GROUND-08':(503,'unavailable'),'E-RPC-01':(503,'unavailable'),'E-RPC-04':(502,'provider_failed'),
'E-RPC-05':(502,'provider_failed'),'E-HTTP-02':(403,''),'E-HTTP-05':(403,'forbidden')}
for k,v in required.items():
    if expected.get(k)!=v: raise SystemExit(f'{k} expected {expected.get(k)} != {v}')
for fn in ['ce_test_prepare_case','ce_test_case_request','ce_test_assert_case','ce_test_cleanup_case','ce_test_fixture_leaks']:
    if not re.search(r'CREATE OR REPLACE FUNCTION\s+public\.'+re.escape(fn)+r'\s*\(',X,re.I):
        raise SystemExit('missing '+fn)
# Wrapper must load the harness before invoking the runtime.
if 'ce-edge-contract-fixtures.sql' not in E: raise SystemExit('edge wrapper does not load SQL harness')
print('False-PASS structural assertions PASS')
PYSCAN
if [ "$F" -eq 0 ]; then echo 'False-PASS scan: PASS=1 FAIL=0'; exit 0; fi
echo "False-PASS scan: PASS=0 FAIL=$F"; exit 1
