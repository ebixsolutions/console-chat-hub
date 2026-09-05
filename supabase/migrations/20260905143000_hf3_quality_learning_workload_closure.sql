-- HF-3 — Quality Learning + Workload Reduction Closure
--
-- Ownership boundaries:
--   AI Chatbot: conversation / CE / feedback / handoff / learning candidate
--   SU CoachAI: training / improved result
--   Knowledge Base: governed approval / publish / version / vector lifecycle
--
-- This migration never treats feedback or a low score as live escalation input.
-- It is post-hoc only and cannot reopen a resolved conversation.

BEGIN;

CREATE TABLE IF NOT EXISTS public.hf3_learning_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  evaluation_id uuid NOT NULL UNIQUE,
  feedback_request_id uuid NULL,
  source_handoff_event_id uuid NULL,
  intent_key text NULL,
  handoff_classification text NOT NULL DEFAULT 'not_applicable'
    CHECK (handoff_classification IN ('not_applicable','unavoidable','potentially_avoidable','unknown')),
  classification_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  feedback_quality_score numeric NULL CHECK (feedback_quality_score IS NULL OR (feedback_quality_score >= 0 AND feedback_quality_score <= 100)),
  has_negative_feedback boolean NOT NULL DEFAULT false,
  has_verified_human_response boolean NOT NULL DEFAULT false,
  ai_answer_sha256 text NULL,
  human_answer_sha256 text NULL,
  answer_delta_dimensions jsonb NOT NULL DEFAULT '[]'::jsonb,
  training_candidate boolean NOT NULL DEFAULT false,
  candidate_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  training_outbox_id uuid NULL,
  learning_state text NOT NULL DEFAULT 'observed'
    CHECK (learning_state IN ('observed','candidate','queued','delivered','trained','kb_pending','kb_published','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hf3_learning_case_company_intent
  ON public.hf3_learning_case(company_id, intent_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hf3_learning_case_candidate
  ON public.hf3_learning_case(company_id, training_candidate, learning_state, created_at DESC);

ALTER TABLE public.hf3_learning_case ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hf3_learning_case FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hf3_learning_case TO service_role;

CREATE TABLE IF NOT EXISTS public.hf3_workload_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  intent_key text NOT NULL,
  snapshot_label text NOT NULL CHECK (snapshot_label IN ('before','after')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  conversations_count integer NOT NULL CHECK (conversations_count >= 0),
  handoff_conversation_count integer NOT NULL CHECK (handoff_conversation_count >= 0),
  potentially_avoidable_handoff_count integer NOT NULL CHECK (potentially_avoidable_handoff_count >= 0),
  r2_repeat_handoff_count integer NOT NULL CHECK (r2_repeat_handoff_count >= 0),
  human_takeover_count integer NOT NULL CHECK (human_takeover_count >= 0),
  avg_first_human_response_seconds numeric NULL CHECK (avg_first_human_response_seconds IS NULL OR avg_first_human_response_seconds >= 0),
  feedback_response_count integer NOT NULL CHECK (feedback_response_count >= 0),
  avg_feedback_quality_score numeric NULL CHECK (avg_feedback_quality_score IS NULL OR (avg_feedback_quality_score >= 0 AND avg_feedback_quality_score <= 100)),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS idx_hf3_workload_snapshot_scope
  ON public.hf3_workload_snapshot(company_id, intent_key, created_at DESC);
ALTER TABLE public.hf3_workload_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hf3_workload_snapshot FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hf3_workload_snapshot TO service_role;

CREATE TABLE IF NOT EXISTS public.hf3_closed_loop_proof (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  learning_case_id uuid NOT NULL REFERENCES public.hf3_learning_case(id) ON DELETE RESTRICT,
  evaluation_id uuid NOT NULL,
  before_conversation_id uuid NOT NULL,
  after_conversation_id uuid NOT NULL,
  intent_key text NOT NULL,
  kb_document_id text NOT NULL,
  kb_publish_state_id uuid NOT NULL,
  latest_kb_reconsumed boolean NOT NULL DEFAULT false,
  before_handoff_count integer NOT NULL DEFAULT 0,
  after_handoff_count integer NOT NULL DEFAULT 0,
  before_r2_repeat_count integer NOT NULL DEFAULT 0,
  after_r2_repeat_count integer NOT NULL DEFAULT 0,
  before_overall_score numeric NULL,
  after_overall_score numeric NULL,
  proof_status text NOT NULL CHECK (proof_status IN ('improved_no_handoff','observed_reduction','observed_no_reduction')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (learning_case_id, after_conversation_id)
);

ALTER TABLE public.hf3_closed_loop_proof ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hf3_closed_loop_proof FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hf3_closed_loop_proof TO service_role;

CREATE OR REPLACE FUNCTION public.hf3_feedback_quality_score(
  p_rating_type text,
  p_rating integer
) RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
  SELECT CASE lower(coalesce(p_rating_type,''))
    WHEN 'nps' THEN CASE WHEN p_rating BETWEEN 0 AND 10 THEN p_rating * 10.0 END
    WHEN 'stars_1_5' THEN CASE WHEN p_rating BETWEEN 1 AND 5 THEN (p_rating - 1) * 25.0 END
    WHEN 'csat' THEN CASE WHEN p_rating BETWEEN 1 AND 5 THEN (p_rating - 1) * 25.0 END
    WHEN 'ces' THEN CASE WHEN p_rating BETWEEN 1 AND 7 THEN round(((p_rating - 1) * 100.0 / 6.0)::numeric, 2) END
    WHEN 'thumbs' THEN CASE WHEN p_rating = 1 THEN 100.0 WHEN p_rating = 0 THEN 0.0 END
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public.hf3_feedback_quality_score(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hf3_feedback_quality_score(text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.hf3_refresh_learning_case_tx(p_evaluation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  e record;
  f record;
  h record;
  s record;
  o record;
  l record;
  v_feedback_score numeric;
  v_negative boolean := false;
  v_handoff_class text := 'not_applicable';
  v_class_reasons text[] := ARRAY[]::text[];
  v_delta_dims jsonb := '[]'::jsonb;
  v_delta_count integer := 0;
  v_candidate boolean := false;
  v_candidate_reasons text[] := ARRAY[]::text[];
  v_ai_hash text;
  v_human_hash text;
  v_state text := 'observed';
  v_case_id uuid;
  v_outbox_id uuid;
BEGIN
  SELECT e0.*, c.intent
    INTO e
    FROM public.conversation_evaluation e0
    JOIN public.conversations c ON c.id = e0.conversation_id
   WHERE e0.id = p_evaluation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','evaluation_not_found');
  END IF;

  SELECT fr.id, fr.rating_type, fr.rating, fr.responded_at
    INTO f
    FROM public.feedback_request fr
   WHERE fr.conversation_id = e.conversation_id
     AND fr.status = 'responded'
     AND fr.rating IS NOT NULL
   ORDER BY fr.responded_at DESC NULLS LAST, fr.created_at DESC
   LIMIT 1;

  IF FOUND THEN
    v_feedback_score := public.hf3_feedback_quality_score(f.rating_type, f.rating);
    v_negative := v_feedback_score IS NOT NULL AND v_feedback_score < 60;
  END IF;

  SELECT he.id, he.escalation_rule, he.handoff_reason, he.handoff_type, he.created_at
    INTO h
    FROM public.handoff_event he
   WHERE he.conversation_id = e.conversation_id
   ORDER BY he.created_at DESC NULLS LAST, he.id DESC
   LIMIT 1;

  IF FOUND THEN
    IF h.escalation_rule IN ('E1','E2','R1','S0') THEN
      v_handoff_class := 'unavoidable';
      v_class_reasons := array_append(v_class_reasons, lower(h.escalation_rule) || '_protected_handoff');
    ELSIF h.escalation_rule = 'R2' THEN
      IF e.has_verified_human_response AND (e.overall_score < 80 OR v_negative) THEN
        v_handoff_class := 'potentially_avoidable';
        v_class_reasons := array_append(v_class_reasons, 'r2_same_intent_unresolved');
      ELSE
        v_handoff_class := 'unknown';
        v_class_reasons := array_append(v_class_reasons, 'r2_without_sufficient_quality_delta');
      END IF;
    ELSE
      v_handoff_class := 'unknown';
      v_class_reasons := array_append(v_class_reasons, 'handoff_without_avoidable_evidence');
    END IF;
  END IF;

  SELECT coalesce(jsonb_agg(x.dimension ORDER BY x.dimension), '[]'::jsonb), count(*)
    INTO v_delta_dims, v_delta_count
    FROM (
      SELECT DISTINCT d.dimension
        FROM public.ce_discrepancy d
       WHERE d.evaluation_id = e.id
         AND d.dimension IS NOT NULL
         AND btrim(d.dimension) <> ''
    ) x;

  SELECT bs.evaluated_ai_reply, bs.verified_human_response
    INTO s
    FROM public.ce_bundle_snapshot bs
   WHERE bs.attempt_id = e.attempt_id
     AND bs.conversation_id = e.conversation_id
     AND bs.company_id = e.company_id
   LIMIT 1;

  IF FOUND THEN
    IF s.evaluated_ai_reply IS NOT NULL THEN
      v_ai_hash := encode(extensions.digest(convert_to(s.evaluated_ai_reply::text, 'UTF8'), 'sha256'), 'hex');
    END IF;
    IF s.verified_human_response IS NOT NULL THEN
      v_human_hash := encode(extensions.digest(convert_to(s.verified_human_response::text, 'UTF8'), 'sha256'), 'hex');
    END IF;
  END IF;

  v_candidate := e.has_verified_human_response AND (
    e.training_eligible
    OR v_negative
    OR v_handoff_class = 'potentially_avoidable'
    OR v_delta_count > 0
  );

  IF e.training_eligible THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'ce_training_eligible');
  END IF;
  IF v_negative THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'negative_customer_feedback');
  END IF;
  IF v_handoff_class = 'potentially_avoidable' THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'potentially_avoidable_handoff');
  END IF;
  IF v_delta_count > 0 THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'ai_human_answer_delta');
  END IF;
  IF NOT e.has_verified_human_response AND (e.training_eligible OR v_negative OR v_delta_count > 0) THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'human_correction_required_before_training');
  END IF;

  INSERT INTO public.hf3_learning_case(
    company_id, conversation_id, evaluation_id, feedback_request_id,
    source_handoff_event_id, intent_key, handoff_classification,
    classification_reason_codes, feedback_quality_score, has_negative_feedback,
    has_verified_human_response, ai_answer_sha256, human_answer_sha256,
    answer_delta_dimensions, training_candidate, candidate_reason_codes,
    learning_state, updated_at
  ) VALUES (
    e.company_id, e.conversation_id, e.id, f.id,
    h.id, nullif(lower(btrim(coalesce(e.intent,''))), ''), v_handoff_class,
    to_jsonb(v_class_reasons), v_feedback_score, v_negative,
    e.has_verified_human_response, v_ai_hash, v_human_hash,
    v_delta_dims, v_candidate, to_jsonb(v_candidate_reasons),
    CASE WHEN v_candidate THEN 'candidate' ELSE 'observed' END, now()
  )
  ON CONFLICT (evaluation_id) DO UPDATE SET
    company_id = EXCLUDED.company_id,
    conversation_id = EXCLUDED.conversation_id,
    feedback_request_id = EXCLUDED.feedback_request_id,
    source_handoff_event_id = EXCLUDED.source_handoff_event_id,
    intent_key = EXCLUDED.intent_key,
    handoff_classification = EXCLUDED.handoff_classification,
    classification_reason_codes = EXCLUDED.classification_reason_codes,
    feedback_quality_score = EXCLUDED.feedback_quality_score,
    has_negative_feedback = EXCLUDED.has_negative_feedback,
    has_verified_human_response = EXCLUDED.has_verified_human_response,
    ai_answer_sha256 = EXCLUDED.ai_answer_sha256,
    human_answer_sha256 = EXCLUDED.human_answer_sha256,
    answer_delta_dimensions = EXCLUDED.answer_delta_dimensions,
    training_candidate = EXCLUDED.training_candidate,
    candidate_reason_codes = EXCLUDED.candidate_reason_codes,
    learning_state = CASE
      WHEN public.hf3_learning_case.learning_state IN ('delivered','trained','kb_pending','kb_published','closed')
        THEN public.hf3_learning_case.learning_state
      ELSE EXCLUDED.learning_state
    END,
    updated_at = now()
  RETURNING id INTO v_case_id;

  IF v_candidate AND e.review_status = 'accepted' THEN
    INSERT INTO public.evaluation_training_outbox(
      evaluation_id, status, delivery_idempotency_key, source_app,
      source_deployment, evaluation_contract_version, company_id
    ) VALUES (
      e.id, 'pending', e.id::text, 'ai_chatbot',
      e.source_deployment, e.evaluation_contract_version, e.company_id
    )
    ON CONFLICT (evaluation_id) DO UPDATE SET
      status = 'pending',
      delivery_attempts = 0,
      last_attempt_at = NULL,
      last_error = NULL,
      delivered_at = NULL,
      company_id = EXCLUDED.company_id,
      source_deployment = EXCLUDED.source_deployment,
      evaluation_contract_version = EXCLUDED.evaluation_contract_version
    WHERE public.evaluation_training_outbox.status = 'failed'
      AND public.evaluation_training_outbox.last_error = 'hf3_not_approved_learning_candidate';
  ELSE
    UPDATE public.evaluation_training_outbox o0
       SET status = 'failed',
           last_error = 'hf3_not_approved_learning_candidate'
     WHERE o0.evaluation_id = e.id
       AND o0.status = 'pending';
  END IF;

  SELECT id, status INTO o
    FROM public.evaluation_training_outbox
   WHERE evaluation_id = e.id;
  IF FOUND THEN
    v_outbox_id := o.id;
    IF o.status = 'delivered' THEN v_state := 'delivered';
    ELSIF o.status IN ('pending','in_progress') THEN v_state := 'queued';
    ELSIF v_candidate THEN v_state := 'candidate';
    ELSE v_state := 'observed';
    END IF;
  ELSE
    v_state := CASE WHEN v_candidate THEN 'candidate' ELSE 'observed' END;
  END IF;

  SELECT local_state, improved_state, remote_sync_state INTO l
    FROM public.ce_training_link
   WHERE evaluation_id = e.id
     AND company_id = e.company_id
     AND link_kind = 'training_candidate'
   LIMIT 1;
  IF FOUND THEN
    IF l.improved_state = 'received' THEN v_state := 'trained'; END IF;
    IF l.improved_state = 'received' AND l.remote_sync_state = 'synced' THEN v_state := 'kb_pending'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.ce_kb_publish_state ps
       WHERE ps.evaluation_id = e.id
         AND ps.company_id = e.company_id
         AND ps.action = 'publish'
         AND ps.state = 'published'
         AND ps.remote_sync_state = 'synced'
    ) THEN
      v_state := 'kb_published';
    END IF;
  END IF;

  UPDATE public.hf3_learning_case
     SET training_outbox_id = v_outbox_id,
         learning_state = v_state,
         updated_at = now()
   WHERE id = v_case_id;

  RETURN jsonb_build_object(
    'result','success',
    'learning_case_id',v_case_id,
    'training_candidate',v_candidate,
    'review_status',e.review_status,
    'handoff_classification',v_handoff_class,
    'learning_state',v_state,
    'outbox_id',v_outbox_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.hf3_refresh_learning_case_tx(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hf3_refresh_learning_case_tx(uuid) TO service_role;

-- Replace the historical unconditional PR6 enqueue. It retains the lineage/snapshot
-- invariant, but enqueue is now allowed only for an already-reviewed eligible row.
-- Normal inserts are review_status=pending, so review/HF3 refresh owns candidate enqueue.
CREATE OR REPLACE FUNCTION public.pr6_enqueue_canonical_evaluation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.id IS NULL OR NEW.company_id IS NULL OR NEW.conversation_id IS NULL
     OR NEW.evaluation_contract_version IS NULL OR NEW.source_deployment IS NULL THEN
    RAISE EXCEPTION 'PR6_OUTBOX_SCOPE_INVALID' USING ERRCODE='check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.conversation_evaluation_attempt a
      JOIN public.ce_bundle_snapshot s ON s.attempt_id = a.id
     WHERE a.id = NEW.attempt_id
       AND a.conversation_id = NEW.conversation_id
       AND a.company_id = NEW.company_id
       AND a.status IN ('running','complete')
       AND s.conversation_id = NEW.conversation_id
       AND s.company_id = NEW.company_id
       AND s.bundle_hash = NEW.bundle_hash
       AND s.evaluation_contract_version = NEW.evaluation_contract_version
  ) THEN
    RAISE EXCEPTION 'PR6_CANONICAL_SNAPSHOT_MISSING' USING ERRCODE='check_violation';
  END IF;

  IF NEW.training_eligible AND NEW.review_status = 'accepted' THEN
    INSERT INTO public.evaluation_training_outbox(
      evaluation_id,status,delivery_idempotency_key,source_app,
      source_deployment,evaluation_contract_version,company_id
    ) VALUES (
      NEW.id,'pending',NEW.id::text,'ai_chatbot',
      NEW.source_deployment,NEW.evaluation_contract_version,NEW.company_id
    ) ON CONFLICT(evaluation_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.hf3_evaluation_refresh_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  PERFORM public.hf3_refresh_learning_case_tx(NEW.id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hf3_evaluation_refresh_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_hf3_evaluation_refresh ON public.conversation_evaluation;
CREATE TRIGGER trg_hf3_evaluation_refresh
AFTER INSERT OR UPDATE OF review_status, training_eligible
ON public.conversation_evaluation
FOR EACH ROW EXECUTE FUNCTION public.hf3_evaluation_refresh_trigger();

CREATE OR REPLACE FUNCTION public.hf3_feedback_refresh_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE v_eval_id uuid;
BEGIN
  IF NEW.status = 'responded' AND NEW.rating IS NOT NULL THEN
    SELECT e.id INTO v_eval_id
      FROM public.conversation_evaluation e
     WHERE e.conversation_id = NEW.conversation_id
       AND e.freshness = 'current'
     ORDER BY e.created_at DESC
     LIMIT 1;
    IF v_eval_id IS NOT NULL THEN
      PERFORM public.hf3_refresh_learning_case_tx(v_eval_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hf3_feedback_refresh_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_hf3_feedback_refresh ON public.feedback_request;
CREATE TRIGGER trg_hf3_feedback_refresh
AFTER INSERT OR UPDATE OF status, rating, feedback_text
ON public.feedback_request
FOR EACH ROW EXECUTE FUNCTION public.hf3_feedback_refresh_trigger();

CREATE OR REPLACE FUNCTION public.hf3_handoff_refresh_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE v_eval_id uuid;
BEGIN
  SELECT e.id INTO v_eval_id
    FROM public.conversation_evaluation e
   WHERE e.conversation_id = NEW.conversation_id
     AND e.freshness = 'current'
   ORDER BY e.created_at DESC
   LIMIT 1;
  IF v_eval_id IS NOT NULL THEN
    PERFORM public.hf3_refresh_learning_case_tx(v_eval_id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hf3_handoff_refresh_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_hf3_handoff_refresh ON public.handoff_event;
CREATE TRIGGER trg_hf3_handoff_refresh
AFTER INSERT OR UPDATE OF escalation_rule, handoff_reason
ON public.handoff_event
FOR EACH ROW EXECUTE FUNCTION public.hf3_handoff_refresh_trigger();

CREATE OR REPLACE FUNCTION public.hf3_discrepancy_refresh_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  PERFORM public.hf3_refresh_learning_case_tx(NEW.evaluation_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hf3_discrepancy_refresh_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_hf3_discrepancy_refresh ON public.ce_discrepancy;
CREATE TRIGGER trg_hf3_discrepancy_refresh
AFTER INSERT OR UPDATE OF dimension, divergence_kind, severity
ON public.ce_discrepancy
FOR EACH ROW EXECUTE FUNCTION public.hf3_discrepancy_refresh_trigger();

CREATE OR REPLACE FUNCTION public.hf3_training_link_refresh_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  PERFORM public.hf3_refresh_learning_case_tx(NEW.evaluation_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.hf3_training_link_refresh_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_hf3_training_link_refresh ON public.ce_training_link;
CREATE TRIGGER trg_hf3_training_link_refresh
AFTER INSERT OR UPDATE OF improved_state, remote_sync_state
ON public.ce_training_link
FOR EACH ROW EXECUTE FUNCTION public.hf3_training_link_refresh_trigger();

CREATE OR REPLACE FUNCTION public.hf3_claim_training_outbox_tx(p_max_batch integer DEFAULT 10)
RETURNS SETOF public.evaluation_training_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_max_batch IS NULL OR p_max_batch < 1 OR p_max_batch > 50 THEN
    RAISE EXCEPTION 'HF3_INVALID_BATCH_SIZE' USING ERRCODE='22023';
  END IF;

  UPDATE public.evaluation_training_outbox o
     SET status='pending', last_error='stale_claim_recovered'
   WHERE o.status='in_progress'
     AND o.last_attempt_at < now() - interval '15 minutes'
     AND EXISTS (
       SELECT 1
         FROM public.hf3_learning_case lc
         JOIN public.conversation_evaluation e ON e.id=lc.evaluation_id
        WHERE lc.evaluation_id=o.evaluation_id
          AND lc.company_id=o.company_id
          AND lc.training_candidate
          AND e.review_status='accepted'
     );

  RETURN QUERY
  WITH candidates AS (
    SELECT o.id
      FROM public.evaluation_training_outbox o
      JOIN public.hf3_learning_case lc
        ON lc.evaluation_id=o.evaluation_id AND lc.company_id=o.company_id
      JOIN public.conversation_evaluation e ON e.id=o.evaluation_id
     WHERE o.status='pending'
       AND lc.training_candidate
       AND e.review_status='accepted'
       AND e.company_id=o.company_id
     ORDER BY o.created_at
     FOR UPDATE OF o SKIP LOCKED
     LIMIT p_max_batch
  )
  UPDATE public.evaluation_training_outbox o
     SET status='in_progress',
         delivery_attempts=o.delivery_attempts+1,
         last_attempt_at=now(),
         last_error=NULL
    FROM candidates c
   WHERE o.id=c.id
  RETURNING o.*;
END;
$$;
REVOKE ALL ON FUNCTION public.hf3_claim_training_outbox_tx(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hf3_claim_training_outbox_tx(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.hf3_finish_training_outbox_tx(
  p_outbox_id uuid,
  p_success boolean,
  p_error text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE o record;
BEGIN
  SELECT * INTO o
    FROM public.evaluation_training_outbox
   WHERE id=p_outbox_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF o.status='delivered' AND p_success THEN RETURN jsonb_build_object('result','idempotent'); END IF;
  IF o.status <> 'in_progress' THEN RETURN jsonb_build_object('result','stale_state','status',o.status); END IF;

  IF p_success THEN
    UPDATE public.evaluation_training_outbox
       SET status='delivered', delivered_at=now(), last_error=NULL
     WHERE id=p_outbox_id;
    UPDATE public.hf3_learning_case
       SET learning_state='delivered', updated_at=now()
     WHERE evaluation_id=o.evaluation_id AND company_id=o.company_id;
    RETURN jsonb_build_object('result','success','status','delivered');
  END IF;

  UPDATE public.evaluation_training_outbox
     SET status=CASE WHEN o.delivery_attempts >= o.max_attempts THEN 'failed' ELSE 'pending' END,
         last_error=left(coalesce(p_error,'delivery_failed'),160)
   WHERE id=p_outbox_id;
  RETURN jsonb_build_object(
    'result','success',
    'status',CASE WHEN o.delivery_attempts >= o.max_attempts THEN 'failed' ELSE 'pending' END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.hf3_finish_training_outbox_tx(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hf3_finish_training_outbox_tx(uuid, boolean, text) TO service_role;

CREATE OR REPLACE FUNCTION public.hf3_capture_workload_snapshot_tx(
  p_company_id uuid,
  p_intent_key text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_snapshot_label text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_id uuid;
  v_intent text := lower(btrim(coalesce(p_intent_key,'')));
BEGIN
  IF v_intent='' OR p_snapshot_label NOT IN ('before','after') OR p_period_end<=p_period_start THEN
    RAISE EXCEPTION 'HF3_INVALID_WORKLOAD_SNAPSHOT_INPUT' USING ERRCODE='22023';
  END IF;

  WITH scoped AS (
    SELECT c.id
      FROM public.conversations c
     WHERE c.company_id=p_company_id
       AND lower(btrim(coalesce(c.intent,'')))=v_intent
       AND c.created_at>=p_period_start
       AND c.created_at<p_period_end
  ), first_human AS (
    SELECT s.id AS conversation_id,
           min(h.created_at) AS handoff_at,
           min(m.created_at) FILTER (WHERE m.role='human_agent') AS first_human_at
      FROM scoped s
      LEFT JOIN public.handoff_event h ON h.conversation_id=s.id
      LEFT JOIN public.messages m ON m.conversation_id=s.id
     GROUP BY s.id
  ), metrics AS (
    SELECT
      (SELECT count(*) FROM scoped)::int AS conversations_count,
      (SELECT count(*) FROM scoped s WHERE EXISTS (SELECT 1 FROM public.handoff_event h WHERE h.conversation_id=s.id))::int AS handoff_count,
      (SELECT count(DISTINCT lc.conversation_id) FROM public.hf3_learning_case lc JOIN scoped s ON s.id=lc.conversation_id WHERE lc.handoff_classification='potentially_avoidable')::int AS avoidable_count,
      (SELECT count(DISTINCT h.conversation_id) FROM public.handoff_event h JOIN scoped s ON s.id=h.conversation_id WHERE h.escalation_rule='R2')::int AS r2_count,
      (SELECT count(*) FROM first_human WHERE handoff_at IS NOT NULL AND first_human_at IS NOT NULL)::int AS human_takeover_count,
      (SELECT round(avg(extract(epoch FROM (first_human_at-handoff_at)))::numeric,2) FROM first_human WHERE handoff_at IS NOT NULL AND first_human_at>=handoff_at) AS avg_first_human_seconds,
      (SELECT count(*) FROM public.hf3_learning_case lc JOIN scoped s ON s.id=lc.conversation_id WHERE lc.feedback_quality_score IS NOT NULL)::int AS feedback_count,
      (SELECT round(avg(lc.feedback_quality_score)::numeric,2) FROM public.hf3_learning_case lc JOIN scoped s ON s.id=lc.conversation_id WHERE lc.feedback_quality_score IS NOT NULL) AS avg_feedback
  )
  INSERT INTO public.hf3_workload_snapshot(
    company_id,intent_key,snapshot_label,period_start,period_end,
    conversations_count,handoff_conversation_count,potentially_avoidable_handoff_count,
    r2_repeat_handoff_count,human_takeover_count,avg_first_human_response_seconds,
    feedback_response_count,avg_feedback_quality_score
  )
  SELECT p_company_id,v_intent,p_snapshot_label,p_period_start,p_period_end,
         conversations_count,handoff_count,avoidable_count,r2_count,
         human_takeover_count,avg_first_human_seconds,feedback_count,avg_feedback
    FROM metrics
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.hf3_capture_workload_snapshot_tx(uuid,text,timestamptz,timestamptz,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hf3_capture_workload_snapshot_tx(uuid,text,timestamptz,timestamptz,text) TO service_role;

CREATE OR REPLACE FUNCTION public.hf3_compare_workload_snapshots_tx(
  p_before_id uuid,
  p_after_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE b record; a record; bh numeric; ah numeric; br numeric; ar numeric;
BEGIN
  SELECT * INTO b FROM public.hf3_workload_snapshot WHERE id=p_before_id;
  SELECT * INTO a FROM public.hf3_workload_snapshot WHERE id=p_after_id;
  IF b IS NULL OR a IS NULL THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF b.snapshot_label<>'before' OR a.snapshot_label<>'after' THEN RETURN jsonb_build_object('result','label_mismatch'); END IF;
  IF b.company_id<>a.company_id OR b.intent_key<>a.intent_key THEN RETURN jsonb_build_object('result','scope_mismatch'); END IF;
  IF b.conversations_count=0 OR a.conversations_count=0 THEN RETURN jsonb_build_object('result','insufficient_sample'); END IF;

  bh := b.potentially_avoidable_handoff_count::numeric / b.conversations_count;
  ah := a.potentially_avoidable_handoff_count::numeric / a.conversations_count;
  br := b.r2_repeat_handoff_count::numeric / b.conversations_count;
  ar := a.r2_repeat_handoff_count::numeric / a.conversations_count;

  RETURN jsonb_build_object(
    'result','success',
    'company_id',b.company_id,
    'intent_key',b.intent_key,
    'before',jsonb_build_object(
      'conversations',b.conversations_count,
      'avoidable_handoff_rate',round(bh,4),
      'r2_repeat_rate',round(br,4),
      'avg_first_human_response_seconds',b.avg_first_human_response_seconds,
      'avg_feedback_quality_score',b.avg_feedback_quality_score
    ),
    'after',jsonb_build_object(
      'conversations',a.conversations_count,
      'avoidable_handoff_rate',round(ah,4),
      'r2_repeat_rate',round(ar,4),
      'avg_first_human_response_seconds',a.avg_first_human_response_seconds,
      'avg_feedback_quality_score',a.avg_feedback_quality_score
    ),
    'deltas',jsonb_build_object(
      'avoidable_handoff_rate',round(ah-bh,4),
      'r2_repeat_rate',round(ar-br,4),
      'avg_first_human_response_seconds',
        CASE WHEN b.avg_first_human_response_seconds IS NOT NULL AND a.avg_first_human_response_seconds IS NOT NULL
          THEN round(a.avg_first_human_response_seconds-b.avg_first_human_response_seconds,2) END,
      'avg_feedback_quality_score',
        CASE WHEN b.avg_feedback_quality_score IS NOT NULL AND a.avg_feedback_quality_score IS NOT NULL
          THEN round(a.avg_feedback_quality_score-b.avg_feedback_quality_score,2) END
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.hf3_compare_workload_snapshots_tx(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hf3_compare_workload_snapshots_tx(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.hf3_record_closed_loop_proof_tx(
  p_learning_case_id uuid,
  p_after_conversation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE lc record; before_c record; after_c record; ps record; after_eval record;
DECLARE v_before_handoff integer; v_after_handoff integer; v_before_r2 integer; v_after_r2 integer;
DECLARE v_reconsumed boolean := false; v_status text; v_id uuid;
BEGIN
  SELECT * INTO lc FROM public.hf3_learning_case WHERE id=p_learning_case_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','learning_case_not_found'); END IF;
  IF lc.intent_key IS NULL OR lc.intent_key='' THEN RETURN jsonb_build_object('result','intent_unresolved'); END IF;

  SELECT id,company_id,intent,created_at INTO before_c
    FROM public.conversations WHERE id=lc.conversation_id;
  SELECT id,company_id,intent,created_at INTO after_c
    FROM public.conversations WHERE id=p_after_conversation_id;
  IF before_c IS NULL OR after_c IS NULL THEN RETURN jsonb_build_object('result','conversation_not_found'); END IF;
  IF after_c.company_id IS DISTINCT FROM lc.company_id OR before_c.company_id IS DISTINCT FROM lc.company_id THEN
    RETURN jsonb_build_object('result','company_mismatch');
  END IF;
  IF lower(btrim(coalesce(after_c.intent,''))) IS DISTINCT FROM lc.intent_key THEN
    RETURN jsonb_build_object('result','intent_mismatch');
  END IF;

  SELECT * INTO ps
    FROM public.ce_kb_publish_state
   WHERE evaluation_id=lc.evaluation_id
     AND company_id=lc.company_id
     AND action='publish'
     AND state='published'
     AND remote_sync_state='synced'
   ORDER BY updated_at DESC
   LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','kb_not_published'); END IF;
  IF after_c.created_at <= ps.updated_at THEN RETURN jsonb_build_object('result','after_conversation_predates_kb'); END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.messages m
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(coalesce(m.metadata->'citations','[]'::jsonb))='array'
          THEN coalesce(m.metadata->'citations','[]'::jsonb) ELSE '[]'::jsonb END
      ) citation
     WHERE m.conversation_id=p_after_conversation_id
       AND citation->>'document_id'=ps.kb_document_ref
  ) INTO v_reconsumed;
  IF NOT v_reconsumed THEN RETURN jsonb_build_object('result','latest_kb_not_reconsumed'); END IF;

  SELECT count(*)::int INTO v_before_handoff FROM public.handoff_event WHERE conversation_id=lc.conversation_id;
  SELECT count(*)::int INTO v_after_handoff FROM public.handoff_event WHERE conversation_id=p_after_conversation_id;
  SELECT count(*)::int INTO v_before_r2 FROM public.handoff_event WHERE conversation_id=lc.conversation_id AND escalation_rule='R2';
  SELECT count(*)::int INTO v_after_r2 FROM public.handoff_event WHERE conversation_id=p_after_conversation_id AND escalation_rule='R2';

  SELECT e.overall_score INTO after_eval
    FROM public.conversation_evaluation e
   WHERE e.conversation_id=p_after_conversation_id AND e.freshness='current'
   ORDER BY e.created_at DESC LIMIT 1;

  v_status := CASE
    WHEN v_before_handoff>0 AND v_after_handoff=0 THEN 'improved_no_handoff'
    WHEN v_after_handoff<v_before_handoff OR v_after_r2<v_before_r2 THEN 'observed_reduction'
    ELSE 'observed_no_reduction'
  END;

  INSERT INTO public.hf3_closed_loop_proof(
    company_id,learning_case_id,evaluation_id,before_conversation_id,after_conversation_id,
    intent_key,kb_document_id,kb_publish_state_id,latest_kb_reconsumed,
    before_handoff_count,after_handoff_count,before_r2_repeat_count,after_r2_repeat_count,
    before_overall_score,after_overall_score,proof_status
  ) VALUES (
    lc.company_id,lc.id,lc.evaluation_id,lc.conversation_id,p_after_conversation_id,
    lc.intent_key,ps.kb_document_ref,ps.id,true,
    v_before_handoff,v_after_handoff,v_before_r2,v_after_r2,
    (SELECT overall_score FROM public.conversation_evaluation WHERE id=lc.evaluation_id),
    after_eval.overall_score,v_status
  )
  ON CONFLICT (learning_case_id,after_conversation_id) DO UPDATE SET
    latest_kb_reconsumed=EXCLUDED.latest_kb_reconsumed,
    before_handoff_count=EXCLUDED.before_handoff_count,
    after_handoff_count=EXCLUDED.after_handoff_count,
    before_r2_repeat_count=EXCLUDED.before_r2_repeat_count,
    after_r2_repeat_count=EXCLUDED.after_r2_repeat_count,
    after_overall_score=EXCLUDED.after_overall_score,
    proof_status=EXCLUDED.proof_status
  RETURNING id INTO v_id;

  IF v_status IN ('improved_no_handoff','observed_reduction') THEN
    UPDATE public.hf3_learning_case SET learning_state='closed',updated_at=now() WHERE id=lc.id;
  END IF;

  RETURN jsonb_build_object('result','success','proof_id',v_id,'proof_status',v_status,'latest_kb_reconsumed',true);
END;
$$;
REVOKE ALL ON FUNCTION public.hf3_record_closed_loop_proof_tx(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hf3_record_closed_loop_proof_tx(uuid,uuid) TO service_role;

-- Backfill learning observations from existing canonical evaluations. The refresh
-- is deterministic and does not change conversation status, handoff state, feedback,
-- CE scores, or KB state.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.conversation_evaluation ORDER BY created_at LOOP
    PERFORM public.hf3_refresh_learning_case_tx(r.id);
  END LOOP;
END $$;

-- Historical PR6 inserted pending outbox rows before review. Park only rows that
-- remain pending and are not currently approved HF-3 candidates. No delivered or
-- in-progress row is rewritten.
UPDATE public.evaluation_training_outbox o
   SET status='failed', last_error='hf3_not_approved_learning_candidate'
 WHERE o.status='pending'
   AND NOT EXISTS (
     SELECT 1
       FROM public.hf3_learning_case lc
       JOIN public.conversation_evaluation e ON e.id=lc.evaluation_id
      WHERE lc.evaluation_id=o.evaluation_id
        AND lc.company_id=o.company_id
        AND lc.training_candidate
        AND e.review_status='accepted'
   );

COMMIT;
