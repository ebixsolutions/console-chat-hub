#!/usr/bin/env bash
set -euo pipefail
test "${CI:-}" = true
test -n "${RUNNER_TEMP:-}"
test -z "${SUPABASE_ACCESS_TOKEN:-}"
LOCAL_ROOT="$RUNNER_TEMP/c3-isolated-auth"
mkdir -p "$LOCAL_ROOT/supabase"
printf '%s\n' 'project_id = "c3-director-isolated-auth"' > "$LOCAL_ROOT/supabase/config.toml"
cp -a "$GITHUB_WORKSPACE/supabase/functions" "$LOCAL_ROOT/supabase/functions"
printf '%s\n' 'C3_NATIVE_ISOLATED_AUTH=local-only' > "$LOCAL_ROOT/native.env"
timeout 900s bash -c 'cd "$1" && supabase start' _ "$LOCAL_ROOT"
timeout 20s bash -c 'cd "$1" && supabase status -o env' _ "$LOCAL_ROOT" > "$LOCAL_ROOT/local.env"
set -a
# The CLI generated this file for disposable local Docker containers.
source "$LOCAL_ROOT/local.env"
set +a
export C3_LOCAL_SUPABASE_URL="$API_URL"
export C3_LOCAL_SUPABASE_ANON_KEY="$ANON_KEY"
export C3_LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export C3_LOCAL_AUTH_DB_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres"
test "$C3_LOCAL_SUPABASE_URL" = http://127.0.0.1:54321
timeout 90s psql "$C3_LOCAL_AUTH_DB_URL" -X -v ON_ERROR_STOP=1 \
  -f sql/c3-nonproduction/00_repository_baseline.sql
timeout 90s psql "$C3_LOCAL_AUTH_DB_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260728093000_ce_task1.sql
timeout 30s psql "$C3_LOCAL_AUTH_DB_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260903052000_task4_3_channel_settings_rbac_closure.sql
# The repository pre-migration bootstrap omits this existing live column.
timeout 15s psql "$C3_LOCAL_AUTH_DB_URL" -X -v ON_ERROR_STOP=1 \
  -c "ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS metadata_source jsonb NOT NULL DEFAULT '{}'::jsonb"
# Install the exact approved context definitions only in this disposable local DB.
timeout 30s psql "$C3_LOCAL_AUTH_DB_URL" -X -v ON_ERROR_STOP=1 \
  -f sql/c3-nonproduction/08_widget_auth_isolation_context.sql
# Explicit local env file; JWT verification remains enabled. No remote project link.
timeout 900s bash -c 'cd "$1" && exec supabase functions serve widget-live-ai-test --env-file "$2"' _ "$LOCAL_ROOT" "$LOCAL_ROOT/native.env" > "$LOCAL_ROOT/edge.log" 2>&1 &
C3_NATIVE_EDGE_PID=$!
trap 'kill "$C3_NATIVE_EDGE_PID" 2>/dev/null || true' EXIT
timeout 300s node tests/e2e/c3_widget_isolated_auth.mjs
