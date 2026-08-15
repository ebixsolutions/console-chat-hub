BEGIN;
SET LOCAL lock_timeout='10s';

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.ce_local_evaluation LIMIT 1) THEN
    RAISE EXCEPTION 'PR18_ROLLBACK_BLOCKED_LOCAL_EVALUATIONS_EXIST';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.review_local_evaluation_v1(uuid,uuid,text,text);
DROP FUNCTION IF EXISTS public.fail_local_evaluation_v1(uuid,text);
DROP FUNCTION IF EXISTS public.complete_local_evaluation_v1(uuid,jsonb,jsonb,text,jsonb,jsonb);
DROP FUNCTION IF EXISTS public.initiate_local_evaluation_v1(uuid,text,text,text,text,text,uuid,text);
DROP FUNCTION IF EXISTS public.ce_local_actor_can_evaluate(uuid);

DROP TABLE IF EXISTS public.ce_local_discrepancy;
DROP TABLE IF EXISTS public.ce_local_next_step;
DROP TABLE IF EXISTS public.ce_local_emotion_point;
DROP TABLE IF EXISTS public.ce_local_bundle_snapshot;
DROP TABLE IF EXISTS public.ce_local_evaluation_detail;
DROP TABLE IF EXISTS public.ce_local_evaluation;
DROP TABLE IF EXISTS public.ce_local_evaluation_attempt;

DELETE FROM public.ce_feature_flags WHERE key='ce_conversation_first_enabled';

COMMIT;
