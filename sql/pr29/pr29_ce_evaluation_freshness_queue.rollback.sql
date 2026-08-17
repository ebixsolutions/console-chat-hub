-- PR29 Task 1 rollback — removes only PR29 freshness/queue foundation.
-- Safe before Task 2 activation. Core CE evaluations/details/snapshots are preserved.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DROP TRIGGER IF EXISTS trg_ce_message_evaluation_dirty ON public.messages;

DROP FUNCTION IF EXISTS public.ce_finalize_evaluation_freshness_v1(
  uuid,uuid,text,text,text,bigint,timestamptz
);
DROP FUNCTION IF EXISTS public.ce_enqueue_evaluation_v1(
  uuid,text,text,bigint,text,timestamptz
);
DROP FUNCTION IF EXISTS public.ce_current_evaluation_fingerprint();
DROP FUNCTION IF EXISTS public.ce_activate_evaluation_methodology_v1(
  text,text,text,text,text,boolean
);
DROP FUNCTION IF EXISTS public.ce_message_evaluation_dirty_trigger();
DROP FUNCTION IF EXISTS public.ce_mark_evaluation_dirty(uuid,timestamptz);
DROP FUNCTION IF EXISTS public.ce_runtime_conversation_company(uuid);

DROP INDEX IF EXISTS public.conversation_evaluation_current_idx;
DROP INDEX IF EXISTS public.ce_local_evaluation_current_idx;

ALTER TABLE IF EXISTS public.conversation_evaluation
  DROP CONSTRAINT IF EXISTS conversation_evaluation_freshness_check;
ALTER TABLE IF EXISTS public.ce_local_evaluation
  DROP CONSTRAINT IF EXISTS ce_local_evaluation_freshness_check;

ALTER TABLE IF EXISTS public.conversation_evaluation_attempt
  DROP COLUMN IF EXISTS evaluation_fingerprint;
ALTER TABLE IF EXISTS public.conversation_evaluation
  DROP COLUMN IF EXISTS evaluation_fingerprint;
ALTER TABLE IF EXISTS public.conversation_evaluation
  DROP COLUMN IF EXISTS freshness;

ALTER TABLE IF EXISTS public.ce_local_evaluation_attempt
  DROP COLUMN IF EXISTS evaluation_fingerprint;
ALTER TABLE IF EXISTS public.ce_local_evaluation
  DROP COLUMN IF EXISTS evaluation_fingerprint;
ALTER TABLE IF EXISTS public.ce_local_evaluation
  DROP COLUMN IF EXISTS freshness;

DROP TABLE IF EXISTS public.ce_evaluation_job;
DROP TABLE IF EXISTS public.ce_evaluation_state;
DROP TABLE IF EXISTS public.ce_evaluation_methodology;

COMMIT;
