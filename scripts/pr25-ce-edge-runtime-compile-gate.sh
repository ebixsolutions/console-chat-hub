#!/bin/bash
set -Eeuo pipefail
E="supabase/functions/conversation-evaluate/index.ts"
R="supabase/functions/_shared/llm-router.ts"
C="supabase/functions/_shared/ce-contract.ts"

fail=0
bash scripts/pr25-ce-edge-dependency-preflight.sh || { echo "FAIL Edge dependency preflight"; exit 1; }

pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }

for f in "$E" "$R" "$C"; do
  [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }
done

has "$E" 'companyId: string | null,' "runEvaluator accepts nullable company id"
# Must appear twice: runEvaluator + runSignals
COUNT="$(grep -Fc 'companyId: string | null,' "$E")"
[ "$COUNT" -ge 2 ] && pass "both evaluator and signals wrappers accept nullable company id" || bad "nullable company id wrapper coverage"
has "$R" 'companyId: string | null;' "llm-router contract accepts nullable company id"
has "$E" 'company?.company_id ?? null' "conversation-local calls pass null company id"
has "$E" 'CE_EDGE_RUNTIME_VERSION = "ce-conversation-first-1.0.0"' "runtime version remains frozen"
has "$E" 'initiate_local_evaluation_v1' "local initiation retained"
has "$E" 'complete_local_evaluation_v1' "local persistence retained"

DENO_VERSION="2.9.4"

run_deno() {
  if command -v deno >/dev/null 2>&1; then
    deno "$@"
  else
    command -v npx >/dev/null 2>&1 || return 127
    npx --yes "deno@$DENO_VERSION" "$@"
  fi
}

if run_deno --version; then
  pass "Deno runtime available (system or pinned npm runner)"
else
  bad "unable to start Deno runtime"
fi

if run_deno check --node-modules-dir=none "$E"; then
  pass "deno check --node-modules-dir=none conversation-evaluate"
else
  bad "deno check conversation-evaluate"
fi

if [ "$fail" -ne 0 ]; then
  echo "PR25 CE EDGE COMPILE STATUS: FAIL"
  exit 1
fi
echo "PR25 CE EDGE COMPILE STATUS: PASS"
