#!/bin/bash
set -Eeuo pipefail

REPO="${PR22_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
EXPECTED_PROJECT_REF="hvmtoqiwdqvgnjepxwrc"
PROJECT_REF="${PR22_PROJECT_REF:-}"
AUTH="${PR22_PRODUCTION_DEPLOY_AUTHORIZED:-}"
DB="${SUPABASE_DB_URL:-}"
ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }
pass(){ echo "PASS $1"; }

[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ "$PROJECT_REF" = "$EXPECTED_PROJECT_REF" ] || stop "project ref mismatch"
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
[ -n "$ACCESS_TOKEN" ] || stop "SUPABASE_ACCESS_TOKEN missing"
[ -d "$REPO/.git" ] || stop "repo not found"
cd "$REPO"
[ "$(git branch --show-current)" = main ] || stop "branch must be main"
git diff --quiet || stop "repo has unstaged changes"
git diff --cached --quiet || stop "repo has staged changes"
command -v psql >/dev/null 2>&1 || stop "psql missing"
command -v npx >/dev/null 2>&1 || stop "npx missing"

bash scripts/pr22-ce-runtime-source-gate.sh || stop "PR22 CE source gate failed"

# Only CE-local prerequisites. No canonical company, Singapore KB, Customer360,
# Coach training endpoint or PR20 rebind parameters are required here.
export SUPABASE_ACCESS_TOKEN="$ACCESS_TOKEN"
SECRET_LIST="$(npx supabase secrets list --project-ref "$PROJECT_REF" 2>/dev/null)" \
  || stop "unable to read Edge secret inventory"

required_remote=(
  ANTHROPIC_API_KEY
  CE_CONTRACT_VERSION
  CE_SOURCE_DEPLOYMENT
  LLM_MODEL_EVALUATION
)
for n in "${required_remote[@]}"; do
  printf '%s\n' "$SECRET_LIST" | awk '{print $1}' | grep -Fxq "$n" \
    || stop "production Edge runtime name missing: $n"
  pass "Edge runtime name present: $n"
done

# Apply the already-frozen local CE schema idempotently, plus only the additive
# pre-canonical columns required by current source.
psql "$DB" -v ON_ERROR_STOP=1 -f sql/pr18/pr18_ce_conversation_first_local_scope.sql
psql "$DB" -v ON_ERROR_STOP=1 -f sql/pr19/pr19_ce_local_detail_workflow.sql
psql "$DB" -v ON_ERROR_STOP=1 -f sql/pr22/pr22_ce_runtime_precanonical_schema.sql

# Assert schema/RPCs before changing the Edge runtime.
psql "$DB" -v ON_ERROR_STOP=1 -At <<'SQL' | grep -Fxq 'schema_pass' \
  || fail "local CE schema/RPC assertion failed"
SELECT CASE WHEN
  to_regclass('public.ce_local_evaluation') IS NOT NULL
  AND to_regclass('public.ce_local_evaluation_detail') IS NOT NULL
  AND to_regclass('public.ce_local_bundle_snapshot') IS NOT NULL
  AND EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ce_local_evaluation'
      AND column_name='canonical_evaluation_id'
  )
  AND to_regprocedure('public.initiate_local_evaluation_v1(uuid,text,text,text,text,text,uuid,text)') IS NOT NULL
  AND to_regprocedure('public.complete_local_evaluation_v1(uuid,jsonb,jsonb,text,jsonb,jsonb)') IS NOT NULL
THEN 'schema_pass' ELSE 'schema_fail' END;
SQL
pass "local CE schema and RPCs"

# Deploy exactly one Edge function. Canonical activation remains untouched.
npx supabase functions deploy conversation-evaluate \
  --project-ref "$PROJECT_REF" \
  || fail "conversation-evaluate deployment failed"

echo "PR22 CE RUNTIME ACTIVATION: DEPLOYED"
echo "Canonical company/rebind writes: 0"
