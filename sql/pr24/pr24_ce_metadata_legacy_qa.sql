-- PR24 Task 3 — Conversation metadata + legacy QA compatibility contract.
-- Additive schema only. No inferred/backfilled values are written.

BEGIN;
SET LOCAL lock_timeout='10s';

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS customer_tier text,
  ADD COLUMN IF NOT EXISTS intent text,
  ADD COLUMN IF NOT EXISTS language text,
  ADD COLUMN IF NOT EXISTS metadata_source jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata_updated_at timestamptz;

COMMENT ON COLUMN public.conversations.customer_tier IS
  'Upstream customer tier. Never inferred by Conversation Evaluation.';
COMMENT ON COLUMN public.conversations.intent IS
  'Upstream conversation intent. Never inferred by Conversation Evaluation.';
COMMENT ON COLUMN public.conversations.language IS
  'Upstream conversation language/locale. Never inferred by Conversation Evaluation.';
COMMENT ON COLUMN public.conversations.metadata_source IS
  'Field-level source provenance for customer_tier/intent/language.';

CREATE TABLE IF NOT EXISTS public.ce_legacy_qa_metric (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.company(id) ON DELETE RESTRICT,
  empathy_score numeric(6,2) NOT NULL CHECK (empathy_score BETWEEN 0 AND 100),
  policy_accuracy_score numeric(6,2) NOT NULL CHECK (policy_accuracy_score BETWEEN 0 AND 100),
  vip_awareness_score numeric(6,2) NOT NULL CHECK (vip_awareness_score BETWEEN 0 AND 100),
  resolution_speed_score numeric(6,2) NOT NULL CHECK (resolution_speed_score BETWEEN 0 AND 100),
  context_score numeric(6,2) NOT NULL CHECK (context_score BETWEEN 0 AND 100),
  quality_score numeric(6,2) GENERATED ALWAYS AS (
    round(
      empathy_score * 0.20
      + policy_accuracy_score * 0.25
      + vip_awareness_score * 0.25
      + resolution_speed_score * 0.15
      + context_score * 0.15,
      2
    )
  ) STORED,
  source_system text NOT NULL,
  source_record_id text,
  source_payload_hash text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, source_system, source_record_id)
);

COMMENT ON TABLE public.ce_legacy_qa_metric IS
  'Optional SU Coach legacy QA Quality Score compatibility metric. Separate from canonical six-evaluator CE score.';
COMMENT ON COLUMN public.ce_legacy_qa_metric.quality_score IS
  'Empathy20 + Policy25 + VIP25 + Resolution15 + Context15. Must not replace conversation_evaluation.overall_score.';

ALTER TABLE public.ce_legacy_qa_metric ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ce_legacy_qa_metric_read ON public.ce_legacy_qa_metric;
CREATE POLICY ce_legacy_qa_metric_read
ON public.ce_legacy_qa_metric
FOR SELECT TO authenticated
USING (
  (
    company_id IS NULL
    AND public.is_staff(auth.uid())
  )
  OR EXISTS (
    SELECT 1
    FROM public.company_membership cm
    WHERE cm.company_id=ce_legacy_qa_metric.company_id
      AND cm.user_id=auth.uid()
      AND cm.is_active
  )
);

GRANT SELECT ON public.ce_legacy_qa_metric TO authenticated;
GRANT ALL ON public.ce_legacy_qa_metric TO service_role;

CREATE OR REPLACE FUNCTION public.ce_legacy_qa_company_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE v_company uuid;
BEGIN
  SELECT company_id INTO v_company
  FROM public.conversations
  WHERE id=NEW.conversation_id;

  IF v_company IS NOT NULL
     AND NEW.company_id IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'CE_LEGACY_QA_COMPANY_MISMATCH';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ce_legacy_qa_company_guard_t
ON public.ce_legacy_qa_metric;
CREATE TRIGGER ce_legacy_qa_company_guard_t
BEFORE INSERT OR UPDATE OF conversation_id,company_id
ON public.ce_legacy_qa_metric
FOR EACH ROW EXECUTE FUNCTION public.ce_legacy_qa_company_guard();

REVOKE ALL ON FUNCTION public.ce_legacy_qa_company_guard()
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ce_legacy_qa_company_guard()
TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
