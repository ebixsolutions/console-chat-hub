-- Task 2.2 — Canonical Conversation Evaluation integrity closure.
-- Close runtime/schema drift, enforce tenant lineage, one-outbox cardinality,
-- and retire unsafe legacy completion/initiation RPCs.

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.conversation_evaluation_attempt WHERE company_id IS NULL)
     OR EXISTS (SELECT 1 FROM public.conversation_evaluation WHERE company_id IS NULL)
     OR EXISTS (SELECT 1 FROM public.evaluation_training_outbox WHERE company_id IS NULL)
     OR EXISTS (SELECT 1 FROM public.ce_evaluation_state WHERE company_id IS NULL)
     OR EXISTS (SELECT 1 FROM public.ce_evaluation_job WHERE company_id IS NULL)
  THEN RAISE EXCEPTION 'TASK2_2_NULL_COMPANY_PRECONDITION'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.conversation_evaluation e
    WHERE e.hallucination_quality_score IS DISTINCT FROM round(100 - e.hallucination_risk_score,2)
  ) THEN RAISE EXCEPTION 'TASK2_2_HALLUCINATION_QUALITY_PRECONDITION'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.conversation_evaluation e
    LEFT JOIN public.conversation_evaluation_attempt a ON a.id=e.attempt_id
    WHERE a.id IS NULL OR a.conversation_id IS DISTINCT FROM e.conversation_id OR a.company_id IS DISTINCT FROM e.company_id
  ) THEN RAISE EXCEPTION 'TASK2_2_ATTEMPT_EVALUATION_LINEAGE_PRECONDITION'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.evaluation_training_outbox o
    LEFT JOIN public.conversation_evaluation e ON e.id=o.evaluation_id
    WHERE e.id IS NULL OR o.company_id IS DISTINCT FROM e.company_id
  ) THEN RAISE EXCEPTION 'TASK2_2_OUTBOX_LINEAGE_PRECONDITION'; END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.task22_fill_hallucination_quality_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  IF NEW.hallucination_quality_score IS NULL THEN
    NEW.hallucination_quality_score := round(100 - NEW.hallucination_risk_score, 2);
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.task22_fill_hallucination_quality_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.task22_fill_hallucination_quality_v1() TO service_role;

DROP TRIGGER IF EXISTS trg_task22_fill_hallucination_quality ON public.conversation_evaluation;
CREATE TRIGGER trg_task22_fill_hallucination_quality
BEFORE INSERT ON public.conversation_evaluation
FOR EACH ROW EXECUTE FUNCTION public.task22_fill_hallucination_quality_v1();

ALTER TABLE public.conversation_evaluation
  DROP CONSTRAINT IF EXISTS conversation_evaluation_hallucination_quality_score_check;
ALTER TABLE public.conversation_evaluation
  ADD CONSTRAINT conversation_evaluation_hallucination_quality_score_check
  CHECK (
    hallucination_quality_score >= 0 AND hallucination_quality_score <= 100
    AND hallucination_quality_score = round(100 - hallucination_risk_score, 2)
  ) NOT VALID;
ALTER TABLE public.conversation_evaluation
  VALIDATE CONSTRAINT conversation_evaluation_hallucination_quality_score_check;

ALTER TABLE public.conversation_evaluation_attempt ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.conversation_evaluation ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.evaluation_training_outbox ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.ce_evaluation_state ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.ce_evaluation_job ALTER COLUMN company_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_id_company_id_uq
  ON public.conversations(id, company_id);
CREATE UNIQUE INDEX IF NOT EXISTS ce_attempt_id_conversation_company_uq
  ON public.conversation_evaluation_attempt(id, conversation_id, company_id);
CREATE UNIQUE INDEX IF NOT EXISTS ce_evaluation_id_company_uq
  ON public.conversation_evaluation(id, company_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_evaluation_training_outbox_evaluation_id
  ON public.evaluation_training_outbox(evaluation_id);

ALTER TABLE public.conversation_evaluation_attempt
  DROP CONSTRAINT IF EXISTS ce_attempt_conversation_company_fkey;
ALTER TABLE public.conversation_evaluation_attempt
  ADD CONSTRAINT ce_attempt_conversation_company_fkey
  FOREIGN KEY (conversation_id, company_id)
  REFERENCES public.conversations(id, company_id) NOT VALID;
ALTER TABLE public.conversation_evaluation_attempt
  VALIDATE CONSTRAINT ce_attempt_conversation_company_fkey;

ALTER TABLE public.conversation_evaluation
  DROP CONSTRAINT IF EXISTS ce_evaluation_attempt_lineage_fkey;
ALTER TABLE public.conversation_evaluation
  ADD CONSTRAINT ce_evaluation_attempt_lineage_fkey
  FOREIGN KEY (attempt_id, conversation_id, company_id)
  REFERENCES public.conversation_evaluation_attempt(id, conversation_id, company_id) NOT VALID;
ALTER TABLE public.conversation_evaluation
  VALIDATE CONSTRAINT ce_evaluation_attempt_lineage_fkey;

ALTER TABLE public.evaluation_training_outbox
  DROP CONSTRAINT IF EXISTS ce_outbox_evaluation_company_fkey;
ALTER TABLE public.evaluation_training_outbox
  ADD CONSTRAINT ce_outbox_evaluation_company_fkey
  FOREIGN KEY (evaluation_id, company_id)
  REFERENCES public.conversation_evaluation(id, company_id) NOT VALID;
ALTER TABLE public.evaluation_training_outbox
  VALIDATE CONSTRAINT ce_outbox_evaluation_company_fkey;

ALTER TABLE public.ce_evaluation_state
  DROP CONSTRAINT IF EXISTS ce_state_conversation_company_fkey;
ALTER TABLE public.ce_evaluation_state
  ADD CONSTRAINT ce_state_conversation_company_fkey
  FOREIGN KEY (conversation_id, company_id)
  REFERENCES public.conversations(id, company_id) NOT VALID;
ALTER TABLE public.ce_evaluation_state
  VALIDATE CONSTRAINT ce_state_conversation_company_fkey;

ALTER TABLE public.ce_evaluation_job
  DROP CONSTRAINT IF EXISTS ce_job_conversation_company_fkey;
ALTER TABLE public.ce_evaluation_job
  ADD CONSTRAINT ce_job_conversation_company_fkey
  FOREIGN KEY (conversation_id, company_id)
  REFERENCES public.conversations(id, company_id) NOT VALID;
ALTER TABLE public.ce_evaluation_job
  VALIDATE CONSTRAINT ce_job_conversation_company_fkey;

DROP POLICY IF EXISTS ce_evaluation_state_staff_read ON public.ce_evaluation_state;
CREATE POLICY ce_evaluation_state_staff_read ON public.ce_evaluation_state
FOR SELECT TO authenticated
USING (
  public.is_staff(auth.uid())
  AND public.is_company_member(company_id, auth.uid())
);

REVOKE EXECUTE ON FUNCTION public.initiate_evaluation(uuid,text,text,text,text,text,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.complete_evaluation(uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.initiate_evaluation(uuid,text,text,text,text,text,text,uuid,text) TO postgres;
GRANT EXECUTE ON FUNCTION public.complete_evaluation(uuid,jsonb) TO postgres;

DO $assert$
DECLARE
  v_bad_detail integer;
  v_bad_outbox integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.conversation_evaluation_attempt a JOIN public.conversations c ON c.id=a.conversation_id WHERE a.company_id IS DISTINCT FROM c.company_id)
     OR EXISTS (SELECT 1 FROM public.conversation_evaluation e JOIN public.conversations c ON c.id=e.conversation_id WHERE e.company_id IS DISTINCT FROM c.company_id)
     OR EXISTS (SELECT 1 FROM public.ce_evaluation_state s JOIN public.conversations c ON c.id=s.conversation_id WHERE s.company_id IS DISTINCT FROM c.company_id)
     OR EXISTS (SELECT 1 FROM public.ce_evaluation_job j JOIN public.conversations c ON c.id=j.conversation_id WHERE j.company_id IS DISTINCT FROM c.company_id)
  THEN RAISE EXCEPTION 'TASK2_2_TENANT_LINEAGE_ASSERTION'; END IF;

  SELECT count(*) INTO v_bad_detail
  FROM public.conversation_evaluation e
  WHERE (SELECT count(*) FROM public.conversation_evaluation_detail d WHERE d.evaluation_id=e.id) <> 6
     OR (SELECT count(DISTINCT d.evaluator_type) FROM public.conversation_evaluation_detail d WHERE d.evaluation_id=e.id) <> 6;
  IF v_bad_detail <> 0 THEN RAISE EXCEPTION 'TASK2_2_DETAIL_CARDINALITY:%',v_bad_detail; END IF;

  SELECT count(*) INTO v_bad_outbox
  FROM public.conversation_evaluation e
  WHERE (SELECT count(*) FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id) <> 1;
  IF v_bad_outbox <> 0 THEN RAISE EXCEPTION 'TASK2_2_OUTBOX_CARDINALITY:%',v_bad_outbox; END IF;
END
$assert$;
