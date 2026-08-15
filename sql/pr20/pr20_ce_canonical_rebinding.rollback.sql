BEGIN;
SET LOCAL lock_timeout='10s';

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.ce_local_canonical_map LIMIT 1)
     OR EXISTS(
       SELECT 1 FROM public.ce_local_evaluation
       WHERE canonical_evaluation_id IS NOT NULL OR rebound_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'PR20_ROLLBACK_BLOCKED_CANONICAL_REBIND_EXISTS';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.rebind_local_evaluations_v1(uuid,uuid,uuid);

GRANT EXECUTE ON FUNCTION public.review_local_evaluation_v1(uuid,uuid,text,text)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.ce_create_local_qa_case_v1(uuid,uuid,text,text,text)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.ce_record_local_root_cause_v1(uuid,uuid,text,text,jsonb)
TO authenticated;

DROP POLICY IF EXISTS ce_local_evaluation_tenant_read ON public.ce_local_evaluation;
DROP POLICY IF EXISTS ce_local_evaluation_attempt_tenant_read ON public.ce_local_evaluation_attempt;
DROP POLICY IF EXISTS ce_local_evaluation_detail_tenant_read ON public.ce_local_evaluation_detail;
DROP POLICY IF EXISTS ce_local_bundle_snapshot_tenant_read ON public.ce_local_bundle_snapshot;
DROP POLICY IF EXISTS ce_local_emotion_point_tenant_read ON public.ce_local_emotion_point;
DROP POLICY IF EXISTS ce_local_next_step_tenant_read ON public.ce_local_next_step;
DROP POLICY IF EXISTS ce_local_discrepancy_tenant_read ON public.ce_local_discrepancy;
DROP POLICY IF EXISTS ce_local_qa_case_tenant_read ON public.ce_local_qa_case;
DROP POLICY IF EXISTS ce_local_root_cause_tenant_read ON public.ce_local_root_cause;
DROP POLICY IF EXISTS ce_local_canonical_map_tenant_read ON public.ce_local_canonical_map;

CREATE POLICY ce_local_evaluation_attempt_staff_read
ON public.ce_local_evaluation_attempt FOR SELECT TO authenticated
USING(public.is_staff(auth.uid()));
CREATE POLICY ce_local_evaluation_staff_read
ON public.ce_local_evaluation FOR SELECT TO authenticated
USING(public.is_staff(auth.uid()));
CREATE POLICY ce_local_evaluation_detail_staff_read
ON public.ce_local_evaluation_detail FOR SELECT TO authenticated
USING(public.is_staff(auth.uid()));
CREATE POLICY ce_local_bundle_snapshot_staff_read
ON public.ce_local_bundle_snapshot FOR SELECT TO authenticated
USING(public.is_staff(auth.uid()));
CREATE POLICY ce_local_emotion_point_staff_read
ON public.ce_local_emotion_point FOR SELECT TO authenticated
USING(public.is_staff(auth.uid()));
CREATE POLICY ce_local_next_step_staff_read
ON public.ce_local_next_step FOR SELECT TO authenticated
USING(public.is_staff(auth.uid()));
CREATE POLICY ce_local_discrepancy_staff_read
ON public.ce_local_discrepancy FOR SELECT TO authenticated
USING(public.is_staff(auth.uid()));
CREATE POLICY ce_local_qa_case_staff_read
ON public.ce_local_qa_case FOR SELECT TO authenticated
USING(public.is_staff(auth.uid()));
CREATE POLICY ce_local_root_cause_staff_read
ON public.ce_local_root_cause FOR SELECT TO authenticated
USING(public.is_staff(auth.uid()));

DROP TABLE IF EXISTS public.ce_local_canonical_map;

ALTER TABLE public.ce_local_bundle_snapshot
  DROP COLUMN IF EXISTS rebound_at,
  DROP COLUMN IF EXISTS rebound_run_id;

ALTER TABLE public.ce_local_evaluation
  DROP COLUMN IF EXISTS rebound_at,
  DROP COLUMN IF EXISTS rebound_run_id,
  DROP COLUMN IF EXISTS canonical_evaluation_id;

ALTER TABLE public.ce_local_evaluation_attempt
  DROP COLUMN IF EXISTS rebound_at,
  DROP COLUMN IF EXISTS rebound_run_id,
  DROP COLUMN IF EXISTS company_id;

COMMIT;
