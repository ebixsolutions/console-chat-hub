#!/bin/bash
set -u
set -o pipefail

DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
SINGLE="${PR7_LEGACY_DATA_IS_SINGLE_COMPANY:-}"
ORPHANS="${PR7_LEGACY_ORPHAN_CONVERSATIONS_BELONG_TO_CANONICAL_COMPANY:-}"
RUN_ID="${PR7_CONVERSATION_LINEAGE_RUN_ID:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
PLATFORM_COMPANY_ID="${PR7_CANONICAL_PLATFORM_COMPANY_ID:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ "$SINGLE" = "YES" ] || stop "legacy single-company ownership not explicitly confirmed"
[ "$ORPHANS" = "YES" ] || stop "legacy orphan conversation ownership not explicitly confirmed"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$RUN_ID" ] || stop "PR7_CONVERSATION_LINEAGE_RUN_ID missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
[ -n "$PLATFORM_COMPANY_ID" ] || stop "PR7_CANONICAL_PLATFORM_COMPANY_ID missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

RUN_STATE="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -Atq \
  -v run_id="$RUN_ID" -v company_uuid="$COMPANY_UUID" <<'SQL'
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM public.pr7_conversation_lineage_run
    WHERE run_id=:'run_id'::uuid
      AND company_id=:'company_uuid'::uuid
      AND completed_at IS NOT NULL
      AND rolled_back_at IS NULL
  ) THEN 'exact'
  WHEN EXISTS (
    SELECT 1 FROM public.pr7_conversation_lineage_run
    WHERE run_id=:'run_id'::uuid
  ) THEN 'conflict'
  ELSE 'missing'
END;
SQL
)"
if [ "$RUN_STATE" = "exact" ]; then
  echo "PASS: conversation lineage already backfilled (idempotent no-op)"
  exit 0
fi
[ "$RUN_STATE" != "conflict" ] || stop "conversation lineage run_id conflict or already rolled back"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v run_id="$RUN_ID" \
  -v company_uuid="$COMPANY_UUID" \
  -v platform_company_id="$PLATFORM_COMPANY_ID" <<'SQL'
\set QUIET 1
BEGIN;
SELECT set_config('pr7.conversation_run_id', :'run_id', false);
SELECT set_config('pr7.company_uuid', :'company_uuid', false);
SELECT set_config('pr7.platform_company_id', :'platform_company_id', false);

DO $precheck$
DECLARE
  cid uuid:=current_setting('pr7.company_uuid')::uuid;
  pid bigint:=current_setting('pr7.platform_company_id')::bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.company
    WHERE id=cid AND platform_company_id=pid AND is_active=true
  ) THEN RAISE EXCEPTION 'conversation lineage refused: canonical company missing'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.channel_config
    WHERE company_id IS NULL OR company_id<>cid
  ) THEN
    RAISE EXCEPTION 'conversation lineage refused: Task 3.1 channel ownership incomplete/conflicting';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.channel_config ch ON ch.id=c.channel_config_id
    WHERE c.company_id IS NOT NULL
      AND c.company_id<>ch.company_id
  ) THEN
    RAISE EXCEPTION 'conversation lineage refused: existing conversation/channel conflict';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.conversations
    WHERE company_id IS NOT NULL AND company_id<>cid
  ) THEN
    RAISE EXCEPTION 'conversation lineage refused: foreign conversation company exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.upstream_call_log
    WHERE company_id IS NOT NULL AND company_id<>cid
  ) THEN
    RAISE EXCEPTION 'conversation lineage refused: foreign upstream log company exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.upstream_call_log u
    LEFT JOIN public.conversations c ON c.id=u.conversation_id
    WHERE u.conversation_id IS NOT NULL AND c.id IS NULL
  ) THEN
    RAISE EXCEPTION 'conversation lineage refused: upstream log references missing conversation';
  END IF;
END
$precheck$;

INSERT INTO public.pr7_conversation_lineage_run(run_id,company_id)
VALUES(
  current_setting('pr7.conversation_run_id')::uuid,
  current_setting('pr7.company_uuid')::uuid
);

-- Channel-derived conversations.
INSERT INTO public.pr7_conversation_lineage_row(
  run_id,table_name,row_id,previous_company_id,assigned_company_id,lineage_source
)
SELECT
  current_setting('pr7.conversation_run_id')::uuid,
  'conversations',c.id,c.company_id,ch.company_id,'channel'
FROM public.conversations c
JOIN public.channel_config ch ON ch.id=c.channel_config_id
WHERE c.company_id IS NULL;

UPDATE public.conversations c
SET company_id=ch.company_id
FROM public.channel_config ch
WHERE c.channel_config_id=ch.id
  AND c.company_id IS NULL;

-- Orphan conversations are NEVER inferred from absence of a channel. The shell
-- requires an explicit production owner confirmation before entering this SQL.
INSERT INTO public.pr7_conversation_lineage_row(
  run_id,table_name,row_id,previous_company_id,assigned_company_id,lineage_source
)
SELECT
  current_setting('pr7.conversation_run_id')::uuid,
  'conversations',c.id,c.company_id,
  current_setting('pr7.company_uuid')::uuid,
  'explicit_orphan_confirmation'
FROM public.conversations c
WHERE c.channel_config_id IS NULL
  AND c.company_id IS NULL;

UPDATE public.conversations
SET company_id=current_setting('pr7.company_uuid')::uuid
WHERE channel_config_id IS NULL
  AND company_id IS NULL;

-- Direct downstream logs derive ONLY from canonical conversation ownership.
INSERT INTO public.pr7_conversation_lineage_row(
  run_id,table_name,row_id,previous_company_id,assigned_company_id,lineage_source
)
SELECT
  current_setting('pr7.conversation_run_id')::uuid,
  'upstream_call_log',u.id,u.company_id,c.company_id,'conversation'
FROM public.upstream_call_log u
JOIN public.conversations c ON c.id=u.conversation_id
WHERE u.company_id IS NULL;

UPDATE public.upstream_call_log u
SET company_id=c.company_id
FROM public.conversations c
WHERE u.conversation_id=c.id
  AND u.company_id IS NULL;

DO $assert$
DECLARE cid uuid:=current_setting('pr7.company_uuid')::uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.conversations
    WHERE company_id IS NULL OR company_id<>cid
  ) THEN RAISE EXCEPTION 'conversation lineage assertion: conversation ownership incomplete'; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.channel_config ch ON ch.id=c.channel_config_id
    WHERE c.company_id<>ch.company_id
  ) THEN RAISE EXCEPTION 'conversation lineage assertion: channel/company mismatch'; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.upstream_call_log u
    JOIN public.conversations c ON c.id=u.conversation_id
    WHERE u.company_id IS DISTINCT FROM c.company_id
  ) THEN RAISE EXCEPTION 'conversation lineage assertion: upstream log mismatch'; END IF;

  -- CE tables are empty today, but fail closed if any legacy rows unexpectedly
  -- appear without canonical ownership before this task completes.
  IF EXISTS (
    SELECT 1 FROM public.conversation_evaluation
    WHERE company_id IS NULL OR company_id<>cid
  ) OR EXISTS (
    SELECT 1 FROM public.conversation_evaluation_attempt
    WHERE company_id IS NULL OR company_id<>cid
  ) OR EXISTS (
    SELECT 1 FROM public.ce_bundle_snapshot
    WHERE company_id<>cid
  ) OR EXISTS (
    SELECT 1 FROM public.evaluation_training_outbox
    WHERE company_id IS NULL OR company_id<>cid
  ) THEN
    RAISE EXCEPTION 'conversation lineage assertion: unexpected noncanonical CE lineage';
  END IF;
END
$assert$;

UPDATE public.pr7_conversation_lineage_run
SET completed_at=now()
WHERE run_id=current_setting('pr7.conversation_run_id')::uuid;

COMMIT;
SQL

echo "PASS: conversation and upstream-call lineage backfilled"
