#!/bin/bash
set -Eeuo pipefail
REPO="${PR25_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
PROJECT_REF="${PR25_PROJECT_REF:-hvmtoqiwdqvgnjepxwrc}"
AUTH="${PR25_PRODUCTION_DEPLOY_AUTHORIZED:-NO}"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }

[ "$AUTH" = "YES" ] || stop "production deploy authorization missing"
[ -d "$REPO/.git" ] || stop "repo not found"
cd "$REPO"
[ "$(git branch --show-current)" = main ] || stop "branch must be main"
git diff --quiet || stop "repo has unstaged changes"
git diff --cached --quiet || stop "repo has staged changes"
command -v npx >/dev/null 2>&1 || stop "npx missing"

bash scripts/pr25-ce-edge-runtime-compile-gate.sh || fail "compile gate failed"

npx supabase functions deploy conversation-evaluate --project-ref "$PROJECT_REF" \
  || fail "conversation-evaluate deployment failed"

echo "PR25 CE EDGE DEPLOYMENT: PASS"
