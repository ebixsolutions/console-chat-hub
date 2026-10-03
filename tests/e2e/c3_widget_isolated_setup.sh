#!/usr/bin/env bash
set -euo pipefail
test "${CI:-}" = true
test -n "${RUNNER_TEMP:-}"
test -z "${SUPABASE_ACCESS_TOKEN:-}"
LOCAL_ROOT="$RUNNER_TEMP/c3-isolated-auth"
mkdir -p "$LOCAL_ROOT/supabase"
printf '%s\n' 'project_id = "c3-director-isolated-auth"' > "$LOCAL_ROOT/supabase/config.toml"
ln -s "$GITHUB_WORKSPACE/supabase/functions" "$LOCAL_ROOT/supabase/functions"
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
timeout 300s node tests/e2e/c3_widget_isolated_auth.mjs
