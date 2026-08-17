-- PR29 Task 2 safe rollback.
-- Stops automatic execution first. Core evaluations/history are preserved.
-- Fingerprint columns/widened uniqueness remain additive to avoid data loss if
-- more than one methodology has already evaluated the same snapshot.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF to_regprocedure('public.ce_deactivate_scheduler_v1()') IS NOT NULL THEN
    PERFORM public.ce_deactivate_scheduler_v1();
  END IF;
END
$$;

DROP TRIGGER IF EXISTS trg_zz_ce_verified_correction_priority ON public.messages;
DROP TRIGGER IF EXISTS trg_ce_resolved_priority ON public.conversations;
DROP TRIGGER IF EXISTS trg_ce_copy_fingerprint_canonical ON public.conversation_evaluation;
DROP TRIGGER IF EXISTS trg_ce_copy_fingerprint_local ON public.ce_local_evaluation;

DROP FUNCTION IF EXISTS public.ce_verified_correction_priority_trigger_v1();
DROP FUNCTION IF EXISTS public.ce_resolved_priority_trigger_v1();
DROP FUNCTION IF EXISTS public.ce_copy_evaluation_fingerprint_v1();
DROP FUNCTION IF EXISTS public.ce_automation_initiate_canonical_v1(
  uuid,text,text,text,text,text,jsonb,text,text,text
);
DROP FUNCTION IF EXISTS public.ce_automation_initiate_local_v1(
  uuid,text,text,text,text,text,text
);
DROP FUNCTION IF EXISTS public.ce_fail_job_v1(uuid,text);
DROP FUNCTION IF EXISTS public.ce_complete_job_v1(uuid);
DROP FUNCTION IF EXISTS public.ce_claim_specific_job_v1(uuid,text);
DROP FUNCTION IF EXISTS public.ce_claim_evaluation_jobs_v1(text,integer);
DROP FUNCTION IF EXISTS public.ce_reap_expired_jobs_v1();
DROP FUNCTION IF EXISTS public.ce_scheduler_enqueue_due_v1();
DROP FUNCTION IF EXISTS public.ce_enqueue_current_snapshot_v1(uuid,text,timestamptz);
DROP FUNCTION IF EXISTS public.ce_conversation_evaluable_v1(uuid);
DROP FUNCTION IF EXISTS public.ce_trigger_snapshot_hash_v1(uuid);
DROP FUNCTION IF EXISTS public.ce_scheduler_http_tick_v1();
DROP FUNCTION IF EXISTS public.ce_verify_worker_token_v1(text);
DROP FUNCTION IF EXISTS public.ce_activate_scheduler_v1(text);
DROP FUNCTION IF EXISTS public.ce_deactivate_scheduler_v1();

DROP TABLE IF EXISTS public.ce_automation_runtime;

-- Deliberately keep:
--   evaluation_fingerprint / initiated_by_kind columns
--   fingerprint-aware uniqueness indexes
-- They are additive provenance/data-integrity changes; narrowing uniqueness
-- after live multi-methodology rows would be unsafe.

COMMIT;
