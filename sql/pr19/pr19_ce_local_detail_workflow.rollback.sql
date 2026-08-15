BEGIN;
SET LOCAL lock_timeout='10s';

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.ce_local_qa_case LIMIT 1)
     OR EXISTS(SELECT 1 FROM public.ce_local_root_cause LIMIT 1) THEN
    RAISE EXCEPTION 'PR19_ROLLBACK_BLOCKED_LOCAL_DETAIL_DATA_EXISTS';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.ce_record_local_root_cause_v1(uuid,uuid,text,text,jsonb);
DROP FUNCTION IF EXISTS public.ce_create_local_qa_case_v1(uuid,uuid,text,text,text);
DROP FUNCTION IF EXISTS public.ce_local_actor_can_review(uuid);
DROP TABLE IF EXISTS public.ce_local_root_cause;
DROP TABLE IF EXISTS public.ce_local_qa_case;

COMMIT;
