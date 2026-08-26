#!/bin/bash
set -Eeuo pipefail

REPO="${W2_T2_2_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
DB="${SUPABASE_DB_URL:-}"
AUTH="${W2_T2_2_PRODUCTION_AUTHORIZED:-}"
CID="${W2_T2_2_CANONICAL_COMPANY_UUID:-}"
PID="${W2_T2_2_CANONICAL_PLATFORM_COMPANY_ID:-}"
ADMIN_USER="${W2_T2_2_PRIMARY_ADMIN_USER_UUID:-}"
MEMBERSHIP_RUN="${W2_T2_2_MEMBERSHIP_RUN_ID:-}"
CHANNEL_RUN="${W2_T2_2_CHANNEL_RUN_ID:-}"
LINEAGE_RUN="${W2_T2_2_LINEAGE_RUN_ID:-}"
REBINDS_RUN="${W2_T2_2_CE_REBIND_RUN_ID:-}"
SINGLE="${W2_T2_2_LEGACY_SINGLE_COMPANY_CONFIRMED:-}"
ORPHANS="${W2_T2_2_ORPHAN_CONVERSATIONS_CONFIRMED:-}"

stop(){ echo "STOP: $1" >&2; exit 2; }
[ "$AUTH" = "YES" ] || stop "explicit production authorization missing"
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
[ -d "$REPO/.git" ] || stop "repo missing"
[ "$(git -C "$REPO" branch --show-current)" = "main" ] || stop "branch must be main"
[ -z "$(git -C "$REPO" status --porcelain)" ] || stop "working tree must be clean"
[[ "$CID" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "canonical company UUID missing/invalid"
[[ "$PID" =~ ^[1-9][0-9]*$ ]] || stop "canonical platform company id missing/invalid"
[[ "$ADMIN_USER" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "primary admin user UUID missing/invalid"
for v in MEMBERSHIP_RUN CHANNEL_RUN LINEAGE_RUN REBINDS_RUN; do
  value="${!v:-}"; [[ "$value" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "$v missing/invalid"
done
[ "$SINGLE" = "YES" ] || stop "legacy single-company ownership not explicitly confirmed"
[ "$ORPHANS" = "YES" ] || stop "orphan conversation ownership not explicitly confirmed"
command -v psql >/dev/null 2>&1 || stop "psql missing"

cd "$REPO"

# Frozen dependencies must be physically present and recognizable before any write.
for f in \
  sql/pr7/pr7_company_membership_foundation.sql \
  sql/pr7/pr7_channel_ownership_foundation.sql \
  sql/pr7/pr7_conversation_lineage_foundation.sql \
  sql/pr20/pr20_ce_canonical_rebinding.sql \
  scripts/pr7-company-membership-bootstrap.sh \
  scripts/pr7-channel-ownership-bootstrap.sh \
  scripts/pr7-conversation-lineage-bootstrap.sh \
  scripts/pr20-ce-local-to-canonical-migrate.sh
 do [ -s "$f" ] || stop "frozen dependency missing/empty: $f"; done

grep -q 'uq_company_membership_company_user' sql/pr7/pr7_company_membership_foundation.sql || stop "membership foundation marker missing"
grep -q 'pr7_channel_ownership_run' sql/pr7/pr7_channel_ownership_foundation.sql || stop "channel foundation marker missing"
grep -q 'pr7_conversation_lineage_run' sql/pr7/pr7_conversation_lineage_foundation.sql || stop "conversation lineage marker missing"
grep -q 'rebind_local_evaluations_v1' sql/pr20/pr20_ce_canonical_rebinding.sql || stop "CE rebinding marker missing"

# Task 2.1 must already be activated and exact. Never invent/replace company identity here.
psql "$DB" -v ON_ERROR_STOP=1 -v cid="$CID" -v pid="$PID" -At <<'SQL' | grep -Fxq 'task21_pass' \
  || stop "Task 2.1 canonical company identity not active/exact"
SELECT CASE WHEN
  EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='company'
      AND column_name='platform_company_id' AND udt_name='int8' AND is_nullable='NO')
  AND EXISTS(SELECT 1 FROM public.company
    WHERE id=:'cid'::uuid AND platform_company_id=:'pid'::bigint AND is_active=true)
  AND (SELECT count(*) FROM public.company)=1
THEN 'task21_pass' ELSE 'task21_fail' END;
SQL

# Install idempotent foundations. Each is transactional.
psql "$DB" -v ON_ERROR_STOP=1 -f sql/pr7/pr7_company_membership_foundation.sql
psql "$DB" -v ON_ERROR_STOP=1 -f sql/pr7/pr7_channel_ownership_foundation.sql
psql "$DB" -v ON_ERROR_STOP=1 -f sql/pr7/pr7_conversation_lineage_foundation.sql
psql "$DB" -v ON_ERROR_STOP=1 -f sql/pr20/pr20_ce_canonical_rebinding.sql

# Reuse the frozen authoritative bootstrap implementations with W2 Task 2.2
# parameters. No Lovable/source writes and no LLM recomputation occur here.
export PR7_PRODUCTION_DEPLOY_AUTHORIZED=YES
export PR7_CANONICAL_COMPANY_UUID="$CID"
export PR7_CANONICAL_PLATFORM_COMPANY_ID="$PID"
export PR7_MEMBERSHIP_BOOTSTRAP_RUN_ID="$MEMBERSHIP_RUN"
export PR7_CHANNEL_OWNERSHIP_RUN_ID="$CHANNEL_RUN"
export PR7_CONVERSATION_LINEAGE_RUN_ID="$LINEAGE_RUN"
export PR7_LEGACY_DATA_IS_SINGLE_COMPANY=YES
export PR7_LEGACY_ORPHAN_CONVERSATIONS_BELONG_TO_CANONICAL_COMPANY=YES
export PR11_PRIMARY_ACCEPTANCE_USER_UUID="$ADMIN_USER"

bash scripts/pr7-company-membership-bootstrap.sh
bash scripts/pr7-channel-ownership-bootstrap.sh
bash scripts/pr7-conversation-lineage-bootstrap.sh

# PR20 uses PR7_CONVERSATION_LINEAGE_RUN_ID as immutable rebind provenance.
# Bind it to this Task 2.2 CE rebind run, not the lineage run, while retaining
# exact canonical company/admin identity.
export PR7_CONVERSATION_LINEAGE_RUN_ID="$REBINDS_RUN"
bash scripts/pr20-ce-local-to-canonical-migrate.sh

echo "W2 TASK 2.2 CANONICAL CE ACTIVATION: APPLIED"
