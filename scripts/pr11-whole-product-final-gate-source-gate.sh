#!/bin/bash
set -Eeuo pipefail

SOURCE="scripts/pr7-final-gate.sh"
PROD="scripts/pr7-production-final-gate.sh"
DEPLOY="scripts/pr7-production-deploy.sh"
SELF="scripts/pr11-whole-product-final-gate.sh"
PKG="package.json"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$SOURCE" "$PROD" "$DEPLOY" "$SELF" "$PKG"; do
  [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }
done

# Exact mutually-exclusive status semantics.
has "$PROD" 'stop(){ echo "STOP: $1"; exit 2; }' "production STOP exits immediately with rc=2"
has "$PROD" 'fail(){ echo "FAIL: $1"; exit 1; }' "production FAIL exits rc=1"
has "$PROD" 'echo "FINAL STATUS: READY"' "production READY emitted only at successful end"
not_has "$PROD" 'stop(){ echo "== PREVIEW ROLE ACCEPTANCE BRIDGE SAFETY =="' "recursive/side-effecting STOP implementation removed"
has "$PROD" 'pr7-production-atomic-rollback-source-gate.sh' "production rollback source contract executes in main flow"
has "$PROD" 'pr7-production-runtime-config-gate.sh' "production runtime config executes in main flow"

# Whole-product wrapper classification.
has "$SELF" 'SOURCE_RC' "wrapper captures source final-gate exit code"
has "$SELF" 'PROD_RC' "wrapper captures production final-gate exit code"
has "$SELF" 'WHOLE-PRODUCT FINAL STATUS: READY' "wrapper READY status exists"
has "$SELF" 'WHOLE-PRODUCT FINAL STATUS: STOP' "wrapper STOP status exists"
has "$SELF" 'WHOLE-PRODUCT FINAL STATUS: FAIL' "wrapper FAIL status exists"
has "$SELF" '[ "$SOURCE_RC" -eq 2 ]' "source PASS requires exact rc=2"
has "$SELF" '[ "$PROD_RC" -eq 0 ]' "READY requires production rc=0"
has "$SELF" '[ "$PROD_RC" -eq 2 ]' "STOP requires production rc=2"

# All completed workflow runtime/source gates must remain wired.
for marker in \
  pr8-ce-production-activation-source-gate.sh \
  pr8-ce-runtime-smoke-source-gate.sh \
  pr8-ce-review-training-handoff-source-gate.sh \
  pr9-singapore-kb-authenticated-runtime-source-gate.sh \
  pr10-two-tenant-security-source-gate.sh \
  pr10-cross-tenant-edge-api-source-gate.sh \
  pr10-cross-tenant-mutation-write-source-gate.sh \
  pr11-final-product-ready-integration-source-gate.sh \
  pr11-final-integration-source-lock-source-gate.sh \
  pr12-singapore-kb-production-mapping-source-gate.sh \
  pr12-activation-parameter-contract-source-gate.sh \
  pr12-production-runtime-identity-binding-source-gate.sh
do
  has "$SOURCE" "$marker" "source final gate includes $marker"
done

python3 - "$PROD" <<'PY' || { bad "production runtime gates are outside STOP and correctly ordered"; }
import sys
text=open(sys.argv[1],encoding="utf-8").read()

stop_start=text.find('stop(){')
fail_start=text.find('fail(){', stop_start)
if stop_start < 0 or fail_start < 0:
    raise SystemExit(1)
stop_body=text[stop_start:fail_start]

markers=[
  'pr8-ce-production-activation-gate.sh',
  'pr8-ce-runtime-smoke.sh',
  'pr8-ce-review-training-handoff-runtime-smoke.sh',
  'pr9-singapore-kb-authenticated-runtime-smoke.sh',
  'pr10-two-tenant-security-runtime-smoke.sh',
  'pr10-cross-tenant-edge-api-runtime-smoke.sh',
  'pr10-cross-tenant-mutation-write-runtime-smoke.sh',
]
for marker in markers:
    if marker not in text:
        print("missing",marker)
        raise SystemExit(1)
    if marker in stop_body:
        print("runtime marker illegally inside stop()",marker)
        raise SystemExit(1)

source_rc=text.find('[ "$SOURCE_RC" -eq 2 ]')
runtime_cfg=text.find('pr7-production-runtime-config-gate.sh')
runtime_positions=[text.find(m) for m in markers]
inventory=text.find('REQUIRED_FUNCTIONS=(')
ready=text.rfind('FINAL STATUS: READY')

if min(source_rc,runtime_cfg,*runtime_positions,inventory,ready) < 0:
    raise SystemExit(1)
if not (source_rc < runtime_cfg < runtime_positions[0]):
    raise SystemExit(1)
if runtime_positions != sorted(runtime_positions):
    raise SystemExit(1)
if not (runtime_positions[-1] < inventory < ready):
    raise SystemExit(1)

print("PASS all production runtime gates execute in main flow outside stop()")
print("PASS production runtime gates are correctly ordered before inventory/READY")
PY

# Exact 28-function production inventory contract.
python3 - "$PROD" <<'PY' || { bad "exact 28 Edge function inventory"; }
import re,sys
text=open(sys.argv[1],encoding="utf-8").read()
m=re.search(r'REQUIRED_FUNCTIONS=\(\s*(.*?)\s*\)', text, re.S)
if not m: raise SystemExit(1)
items=re.findall(r'\b[a-z][a-z0-9-]+\b', m.group(1))
expected=[
"get-public-widget-config","create-visitor-session","receive-widget-message",
"widget-poll-messages","generate-reply","health-check","submit-feedback-response",
"deliver-feedback-request","agent-send-reply","assign-conversation",
"take-over-conversation","transfer-conversation","return-to-ai",
"resolve-conversation","mark-unresolved","recall-message","kb-search-proxy",
"visitor-analytics","agent-assist","agent-management","conversation-evaluate",
"customer360-local","customer360-adapter","customer360-coach-sync",
"training-outbox-worker","training-result-receiver","training-kb-sync","training-kb-finalize"]
if items != expected:
    print("inventory:",items)
    raise SystemExit(1)
print("PASS exact 28 Edge function inventory")
PY

# Package baseline is part of authoritative runtime closure.
python3 - "$PKG" <<'PY' || { bad "package baseline"; }
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
deps={}
for k in ("dependencies","devDependencies"):
    deps.update(d.get(k,{}) or {})
v=deps.get("@lovable.dev/vite-tanstack-config")
if v!="2.12.0":
    raise SystemExit(1)
print("PASS @lovable.dev/vite-tanstack-config=2.12.0")
PY

# Deployment entrypoint must still require explicit authorization and atomic rollback.
has "$DEPLOY" 'PR7_PRODUCTION_DEPLOY_AUTHORIZED' "deploy requires explicit production authorization"
has "$DEPLOY" 'PR7_ROLLBACK_COMMIT' "deploy requires rollback commit"
has "$DEPLOY" 'rollback' "deploy retains rollback path"
has "$DEPLOY" 'pr7-production-final-gate.sh' "deploy finishes through production final gate"

if [ "$fail" -ne 0 ]; then
  echo "TASK 11.1 WHOLE-PRODUCT FINAL-GATE SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 11.1 WHOLE-PRODUCT FINAL-GATE SOURCE STATUS: PASS"
