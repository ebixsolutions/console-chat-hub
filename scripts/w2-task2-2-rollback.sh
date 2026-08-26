#!/bin/bash
set -Eeuo pipefail
# W2 Task 2.2 rollback is intentionally conservative. Canonical CE publication
# and downstream training/outbox references must not be silently deleted.
DB="${SUPABASE_DB_URL:-}"
AUTH="${W2_T2_2_PRODUCTION_AUTHORIZED:-}"
REPO="${W2_T2_2_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
stop(){ echo "STOP: $1" >&2; exit 2; }
[ "$AUTH" = "YES" ] || stop "explicit production authorization missing"
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
[ -d "$REPO/.git" ] || stop "repo missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

# Once canonical evaluations or their outbox rows exist, destructive Task 2.2
# rollback is unsafe and deliberately blocked. Use the frozen PR20 rollback only
# before canonical rebinding has produced downstream state.
psql "$DB" -v ON_ERROR_STOP=1 -At <<'SQL' | grep -Fxq 'rollback_safe' \
  || stop "canonical CE/downstream rows exist; rollback blocked to preserve data integrity"
SELECT CASE WHEN
  NOT EXISTS(SELECT 1 FROM public.ce_local_canonical_map)
  AND NOT EXISTS(SELECT 1 FROM public.conversation_evaluation)
  AND NOT EXISTS(SELECT 1 FROM public.evaluation_training_outbox)
THEN 'rollback_safe' ELSE 'rollback_blocked' END;
SQL

cd "$REPO"
[ -s sql/pr20/pr20_ce_canonical_rebinding.rollback.sql ] || stop "PR20 rollback missing"
psql "$DB" -v ON_ERROR_STOP=1 -f sql/pr20/pr20_ce_canonical_rebinding.rollback.sql

echo "PASS W2 Task 2.2 pre-rebind schema rollback complete"
