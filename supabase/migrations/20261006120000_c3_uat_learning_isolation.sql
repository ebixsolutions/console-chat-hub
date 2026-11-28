-- C3-A773-CONSOLIDATED-REPAIR-AUTH-20261006-v1; conditional guarded scope.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.c3_uat_channel_scope') IS NOT NULL OR to_regclass('public.c3_uat_conversation_scope') IS NOT NULL THEN RAISE EXCEPTION 'Compare existing objects; do not replace'; END IF;
 IF md5(pg_get_functiondef('public.hf3_refresh_learning_case_tx(uuid)'::regprocedure)) IS DISTINCT FROM nullif(current_setting('c3.expected_learning_md5',true),'') THEN RAISE EXCEPTION 'Missing/current learning baseline drift'; END IF;
END $$;
CREATE TABLE public.c3_uat_channel_scope (
 channel_id uuid PRIMARY KEY REFERENCES public.channel_config(id),
 company_id uuid NOT NULL UNIQUE REFERENCES public.company(id),
 run_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.c3_uat_conversation_scope (
 conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
 channel_id uuid NOT NULL REFERENCES public.c3_uat_channel_scope(channel_id),
 company_id uuid NOT NULL REFERENCES public.company(id),
 run_id uuid NOT NULL
);
ALTER TABLE public.c3_uat_channel_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.c3_uat_conversation_scope ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.c3_uat_channel_scope,public.c3_uat_conversation_scope FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.c3_uat_register_channel_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.channel_config cc JOIN public.company co ON co.id=cc.company_id WHERE cc.id=NEW.channel_id AND co.id=NEW.company_id AND cc.name LIKE 'C3-UAT-%' AND cc.created_at>=now()-interval '1 hour' AND co.created_at>=now()-interval '1 hour') OR EXISTS(SELECT 1 FROM public.conversations WHERE company_id=NEW.company_id) OR EXISTS(SELECT 1 FROM public.visitor_session WHERE channel_config_id=NEW.channel_id) THEN RAISE EXCEPTION 'Only fresh empty synthetic tenant/channel may be registered'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER c3_uat_register_channel_guard BEFORE INSERT ON public.c3_uat_channel_scope FOR EACH ROW EXECUTE FUNCTION public.c3_uat_register_channel_guard();
CREATE FUNCTION public.c3_uat_bind_conversation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 INSERT INTO public.c3_uat_conversation_scope(conversation_id,channel_id,company_id,run_id)
 SELECT NEW.id,s.channel_id,s.company_id,s.run_id FROM public.c3_uat_channel_scope s WHERE s.channel_id=NEW.channel_config_id AND s.company_id=NEW.company_id;
 RETURN NEW;
END $$;
CREATE TRIGGER c3_uat_bind_conversation AFTER INSERT ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.c3_uat_bind_conversation();
CREATE FUNCTION public.c3_uat_learning_excluded(p_conversation_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.c3_uat_conversation_scope WHERE conversation_id=p_conversation_id)
$$;
CREATE FUNCTION public.c3_uat_evaluation_learning_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF public.c3_uat_learning_excluded(NEW.conversation_id) THEN NEW.training_eligible:=false; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_c3_uat_evaluation_learning_guard BEFORE INSERT OR UPDATE ON public.conversation_evaluation FOR EACH ROW EXECUTE FUNCTION public.c3_uat_evaluation_learning_guard();
CREATE FUNCTION public.c3_uat_learning_sink_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_conversation uuid;
BEGIN
 IF TG_TABLE_NAME='hf3_learning_case' THEN v_conversation:=NEW.conversation_id;
 ELSE SELECT conversation_id INTO v_conversation FROM public.conversation_evaluation WHERE id=NEW.evaluation_id; END IF;
 IF public.c3_uat_learning_excluded(v_conversation) THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER c3_uat_learning_case_guard BEFORE INSERT OR UPDATE ON public.hf3_learning_case FOR EACH ROW EXECUTE FUNCTION public.c3_uat_learning_sink_guard();
CREATE TRIGGER c3_uat_training_outbox_guard BEFORE INSERT OR UPDATE ON public.evaluation_training_outbox FOR EACH ROW EXECUTE FUNCTION public.c3_uat_learning_sink_guard();
REVOKE ALL ON FUNCTION public.c3_uat_register_channel_guard(),public.c3_uat_bind_conversation(),public.c3_uat_learning_excluded(uuid),public.c3_uat_evaluation_learning_guard(),public.c3_uat_learning_sink_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.hf3_refresh_learning_case_tx(p_evaluation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  IF public.c3_uat_learning_excluded((SELECT conversation_id FROM public.conversation_evaluation WHERE id=p_evaluation_id)) THEN
    RETURN jsonb_build_object('result','success','training_excluded',true,'outbox_id',null);
  END IF;
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
$function$;

-- No change to real queue RPC, human-control, receive, AI generation or evaluation scoring.
COMMIT;
