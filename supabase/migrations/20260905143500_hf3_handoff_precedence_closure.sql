-- HF-3 Director takeover — deterministic handoff precedence closure
-- Preserves the original HF-3 learning orchestration while correcting handoff
-- classification to the frozen escalation precedence:
-- E2 -> E1 -> R1 -> S0 -> R2 -> R3 -> P2 -> R4 -> P1.

BEGIN;

ALTER FUNCTION public.hf3_refresh_learning_case_tx(uuid)
  RENAME TO hf3_refresh_learning_case_legacy_tx;

CREATE OR REPLACE FUNCTION public.hf3_refresh_learning_case_tx(p_evaluation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_result jsonb;
  e record;
  lc record;
  h record;
  o record;
  v_handoff_class text := 'not_applicable';
  v_class_reasons text[] := ARRAY[]::text[];
  v_candidate boolean := false;
  v_candidate_reasons text[] := ARRAY[]::text[];
  v_state text;
  v_outbox_id uuid;
BEGIN
  -- Run the full original orchestration first. The remainder of this wrapper
  -- only corrects precedence-sensitive handoff classification/candidate state.
  v_result := public.hf3_refresh_learning_case_legacy_tx(p_evaluation_id);
  IF coalesce(v_result->>'result','') <> 'success' THEN
    RETURN v_result;
  END IF;

  SELECT e0.id, e0.company_id, e0.review_status, e0.training_eligible,
         e0.has_verified_human_response
    INTO e
    FROM public.conversation_evaluation e0
   WHERE e0.id = p_evaluation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','evaluation_not_found');
  END IF;

  SELECT * INTO lc
    FROM public.hf3_learning_case
   WHERE evaluation_id = p_evaluation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','learning_case_not_found');
  END IF;

  -- Select the authoritative handoff reason by the same frozen precedence used
  -- by live escalation, not by timestamp/UUID tie-breaking.
  SELECT he.id, he.escalation_rule, he.handoff_reason, he.handoff_type, he.created_at
    INTO h
    FROM public.handoff_event he
   WHERE he.conversation_id = lc.conversation_id
   ORDER BY
     CASE he.escalation_rule
       WHEN 'E2' THEN 1
       WHEN 'E1' THEN 2
       WHEN 'R1' THEN 3
       WHEN 'S0' THEN 4
       WHEN 'R2' THEN 5
       WHEN 'R3' THEN 6
       WHEN 'P2' THEN 7
       WHEN 'R4' THEN 8
       WHEN 'P1' THEN 9
       ELSE 99
     END,
     he.created_at DESC NULLS LAST,
     he.id DESC
   LIMIT 1;

  IF FOUND THEN
    IF h.escalation_rule IN ('E1','E2','R1','S0') THEN
      v_handoff_class := 'unavoidable';
      v_class_reasons := array_append(v_class_reasons, lower(h.escalation_rule) || '_protected_handoff');
    ELSIF h.escalation_rule = 'R2' THEN
      IF e.has_verified_human_response AND
         ((lc.feedback_quality_score IS NOT NULL AND lc.feedback_quality_score < 60)
           OR EXISTS (
             SELECT 1 FROM public.conversation_evaluation ce
              WHERE ce.id=p_evaluation_id AND ce.overall_score < 80
           )) THEN
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

  v_candidate := e.has_verified_human_response AND (
    e.training_eligible
    OR lc.has_negative_feedback
    OR v_handoff_class = 'potentially_avoidable'
    OR jsonb_array_length(coalesce(lc.answer_delta_dimensions,'[]'::jsonb)) > 0
  );

  IF e.training_eligible THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'ce_training_eligible');
  END IF;
  IF lc.has_negative_feedback THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'negative_customer_feedback');
  END IF;
  IF v_handoff_class = 'potentially_avoidable' THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'potentially_avoidable_handoff');
  END IF;
  IF jsonb_array_length(coalesce(lc.answer_delta_dimensions,'[]'::jsonb)) > 0 THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'ai_human_answer_delta');
  END IF;
  IF NOT e.has_verified_human_response AND
     (e.training_eligible OR lc.has_negative_feedback OR
      jsonb_array_length(coalesce(lc.answer_delta_dimensions,'[]'::jsonb)) > 0) THEN
    v_candidate_reasons := array_append(v_candidate_reasons, 'human_correction_required_before_training');
  END IF;

  UPDATE public.hf3_learning_case
     SET source_handoff_event_id = h.id,
         handoff_classification = v_handoff_class,
         classification_reason_codes = to_jsonb(v_class_reasons),
         training_candidate = v_candidate,
         candidate_reason_codes = to_jsonb(v_candidate_reasons),
         learning_state = CASE
           WHEN learning_state IN ('delivered','trained','kb_pending','kb_published','closed') THEN learning_state
           WHEN v_candidate THEN 'candidate'
           ELSE 'observed'
         END,
         updated_at = now()
   WHERE evaluation_id = p_evaluation_id;

  IF v_candidate AND e.review_status='accepted' THEN
    INSERT INTO public.evaluation_training_outbox(
      evaluation_id,status,delivery_idempotency_key,source_app,
      source_deployment,evaluation_contract_version,company_id
    )
    SELECT ce.id,'pending',ce.id::text,'ai_chatbot',
           ce.source_deployment,ce.evaluation_contract_version,ce.company_id
      FROM public.conversation_evaluation ce
     WHERE ce.id=p_evaluation_id
    ON CONFLICT(evaluation_id) DO UPDATE SET
      status='pending', delivery_attempts=0, last_attempt_at=NULL,
      last_error=NULL, delivered_at=NULL,
      company_id=EXCLUDED.company_id,
      source_deployment=EXCLUDED.source_deployment,
      evaluation_contract_version=EXCLUDED.evaluation_contract_version
    WHERE public.evaluation_training_outbox.status='failed'
      AND public.evaluation_training_outbox.last_error='hf3_not_approved_learning_candidate';
  ELSE
    UPDATE public.evaluation_training_outbox
       SET status='failed', last_error='hf3_not_approved_learning_candidate'
     WHERE evaluation_id=p_evaluation_id AND status='pending';
  END IF;

  SELECT id,status INTO o
    FROM public.evaluation_training_outbox
   WHERE evaluation_id=p_evaluation_id;
  IF FOUND THEN
    v_outbox_id := o.id;
    v_state := CASE
      WHEN o.status='delivered' THEN 'delivered'
      WHEN o.status IN ('pending','in_progress') THEN 'queued'
      WHEN v_candidate THEN 'candidate'
      ELSE 'observed'
    END;
  ELSE
    v_state := CASE WHEN v_candidate THEN 'candidate' ELSE 'observed' END;
  END IF;

  -- Preserve states advanced by downstream SU CoachAI / KB lifecycle.
  UPDATE public.hf3_learning_case
     SET training_outbox_id=v_outbox_id,
         learning_state=CASE
           WHEN learning_state IN ('trained','kb_pending','kb_published','closed') THEN learning_state
           ELSE v_state
         END,
         updated_at=now()
   WHERE evaluation_id=p_evaluation_id;

  RETURN jsonb_build_object(
    'result','success',
    'learning_case_id',lc.id,
    'training_candidate',v_candidate,
    'review_status',e.review_status,
    'handoff_classification',v_handoff_class,
    'learning_state',(SELECT learning_state FROM public.hf3_learning_case WHERE evaluation_id=p_evaluation_id),
    'outbox_id',v_outbox_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hf3_refresh_learning_case_tx(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hf3_refresh_learning_case_tx(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.hf3_refresh_learning_case_legacy_tx(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hf3_refresh_learning_case_legacy_tx(uuid) TO service_role;

-- Re-evaluate all existing HF-3 observations deterministically. This is post-hoc
-- only: no conversation status, handoff, feedback, CE score, or KB content changes.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.conversation_evaluation ORDER BY created_at LOOP
    PERFORM public.hf3_refresh_learning_case_tx(r.id);
  END LOOP;
END $$;

COMMIT;
