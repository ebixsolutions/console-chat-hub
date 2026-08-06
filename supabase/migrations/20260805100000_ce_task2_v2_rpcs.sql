BEGIN;
SET LOCAL lock_timeout = '10s';

DO $all$
DECLARE
  v_sigs text[] := ARRAY[
    'public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text)',
    'public.complete_evaluation_v2(uuid,jsonb,jsonb,text,jsonb,jsonb)',
    'public.fail_evaluation(uuid,text)',
    'public.review_evaluation(uuid,uuid,text,text)',
    'public.reap_stale_evaluation_attempts(interval)'];
  v_sig text; v_oid oid; v_def text; v_own text; v_acl text[];
BEGIN
  -- True no-op (#1): if ledger has rows, skip entire migration
  IF to_regclass('public._ce_t2r_prov_7b2d') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public._ce_t2r_prov_7b2d) THEN
      RAISE NOTICE 'CE_T2R_ALREADY_APPLIED';
      RETURN;
    END IF;
  END IF;

  IF to_regclass('public._ce_t2r_prov_7b2d') IS NULL THEN
    CREATE TABLE public._ce_t2r_prov_7b2d (
      obj_kind text NOT NULL, obj_ident text NOT NULL, created boolean NOT NULL,
      prior_def text, prior_owner text, prior_acl text[],
      PRIMARY KEY (obj_kind, obj_ident));
  END IF;

  -- Capture provenance by exact signature
  FOREACH v_sig IN ARRAY v_sigs LOOP
    BEGIN v_oid := v_sig::regprocedure;
    EXCEPTION WHEN undefined_function OR invalid_text_representation THEN v_oid := NULL; END;
    IF v_oid IS NOT NULL THEN
      SELECT pg_get_functiondef(v_oid), pg_get_userbyid(p.proowner), p.proacl::text[]
        INTO v_def, v_own, v_acl FROM pg_proc p WHERE p.oid=v_oid;
      INSERT INTO public._ce_t2r_prov_7b2d VALUES ('function',v_sig,false,v_def,v_own,v_acl) ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO public._ce_t2r_prov_7b2d VALUES ('function',v_sig,true,NULL,NULL,NULL) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  IF to_regclass('public.ce_conversation_status_v') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='ce_conversation_status_v' AND c.relkind='v') THEN
    SELECT 'CREATE OR REPLACE VIEW public.ce_conversation_status_v AS '||pg_get_viewdef(c.oid,true),
           pg_get_userbyid(c.relowner), c.relacl::text[]
      INTO v_def, v_own, v_acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='ce_conversation_status_v';
    INSERT INTO public._ce_t2r_prov_7b2d VALUES ('view','public.ce_conversation_status_v',false,v_def,v_own,v_acl) ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public._ce_t2r_prov_7b2d VALUES ('view','public.ce_conversation_status_v',true,NULL,NULL,NULL) ON CONFLICT DO NOTHING;
  END IF;

  -- All DDL via EXECUTE so RETURN above truly skips everything

  EXECUTE 'DROP FUNCTION IF EXISTS public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text)';
  EXECUTE $fn1$CREATE FUNCTION public.initiate_evaluation_v2(
    p_conversation_id uuid, p_contract_version text, p_kb_snapshot_id text,
    p_policy_snapshot_id text, p_model_version text, p_prompt_version text,
    p_input_snapshot_hash text, p_bundle_hash text, p_grounding_manifest jsonb,
    p_initiated_by uuid, p_source_deployment text
  ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
  DECLARE v_conv record; v_attempt_id uuid; v_eval_id uuid; v_running int;
  BEGIN
    IF NOT COALESCE((SELECT enabled FROM public.ce_feature_flags WHERE key='ce_grounding_fail_closed_enabled'),false) THEN
      RETURN jsonb_build_object('result','feature_disabled'); END IF;
    SELECT id, company_id INTO v_conv FROM public.conversations WHERE id=p_conversation_id;
    IF v_conv IS NULL THEN RETURN jsonb_build_object('result','not_found'); END IF;
    IF v_conv.company_id IS NULL THEN RETURN jsonb_build_object('result','tenant_unresolved'); END IF;
    IF NOT public.is_company_member(v_conv.company_id, p_initiated_by) THEN
      RETURN jsonb_build_object('result','tenant_forbidden'); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_conversation_id::text,0));
    -- All checks inside lock to prevent races
    SELECT ce.id INTO v_eval_id FROM public.conversation_evaluation ce
      JOIN public.conversation_evaluation_attempt a ON a.id=ce.attempt_id
     WHERE a.conversation_id=p_conversation_id AND a.input_snapshot_hash=p_input_snapshot_hash LIMIT 1;
    IF v_eval_id IS NOT NULL THEN
      RETURN jsonb_build_object('result','already_evaluated','evaluation_id',v_eval_id); END IF;
    SELECT count(*) INTO v_running FROM public.conversation_evaluation_attempt
     WHERE conversation_id=p_conversation_id AND status='running';
    IF v_running>0 THEN RETURN jsonb_build_object('result','already_in_progress'); END IF;
    INSERT INTO public.conversation_evaluation_attempt (
      conversation_id,evaluation_contract_version,input_snapshot_hash,status,
      pipeline_run_id,initiated_by,kb_snapshot_id,policy_snapshot_id,
      model_version,prompt_version,source_deployment,bundle_hash,grounding_manifest,company_id
    ) VALUES (
      p_conversation_id,p_contract_version,p_input_snapshot_hash,'running',
      gen_random_uuid(),p_initiated_by,p_kb_snapshot_id,p_policy_snapshot_id,
      p_model_version,p_prompt_version,p_source_deployment,p_bundle_hash,p_grounding_manifest,v_conv.company_id
    ) RETURNING id INTO v_attempt_id;
    RETURN jsonb_build_object('result','initiated','attempt_id',v_attempt_id);
  END $f$$fn1$;
  EXECUTE 'REVOKE ALL ON FUNCTION public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text) TO service_role';

  EXECUTE 'DROP FUNCTION IF EXISTS public.complete_evaluation_v2(uuid,jsonb,jsonb,text,jsonb,jsonb)';
  EXECUTE $fn2$CREATE FUNCTION public.complete_evaluation_v2(
    p_attempt_id uuid, p_scores jsonb, p_details jsonb,
    p_bundle_hash text, p_snapshot jsonb, p_derived jsonb
  ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
  DECLARE
    v_a record; v_eval_id uuid; v_ex uuid; v_o numeric; v_q numeric; v_s text;
    v_v boolean; v_cid uuid; v_d jsonb; v_et text; v_w numeric;
    v_emo jsonb; v_st jsonb; v_dc jsonb;
  BEGIN
    SELECT * INTO v_a FROM public.conversation_evaluation_attempt WHERE id=p_attempt_id FOR UPDATE;
    IF v_a IS NULL THEN RETURN jsonb_build_object('result','attempt_not_found'); END IF;
    IF v_a.status <> 'running' THEN
      SELECT id INTO v_ex FROM public.conversation_evaluation WHERE attempt_id=p_attempt_id;
      IF v_ex IS NOT NULL THEN
        RETURN jsonb_build_object('result','success','evaluation_id',v_ex,'idempotent',true); END IF;
      RETURN jsonb_build_object('result','attempt_not_running','status',v_a.status);
    END IF;
    IF v_a.bundle_hash IS NOT NULL AND v_a.bundle_hash <> p_bundle_hash THEN
      RETURN jsonb_build_object('result','bundle_hash_mismatch'); END IF;
    -- Input shape validation
    IF jsonb_typeof(p_scores) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('result','invalid_scores','detail','not_object'); END IF;
    IF jsonb_typeof(p_details) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('result','invalid_details','detail','not_object'); END IF;
    IF p_snapshot IS NOT NULL AND jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('result','invalid_snapshot','detail','not_object'); END IF;
    IF p_derived IS NOT NULL AND jsonb_typeof(p_derived) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('result','invalid_derived','detail','not_object'); END IF;
    -- Input validation: exact 6 score keys, numeric 0-100, no extras
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_scores) k)
       IS DISTINCT FROM ARRAY['accuracy','context','hallucination_risk','policy','sales','tone'] THEN
      RETURN jsonb_build_object('result','invalid_scores','detail','wrong_keys'); END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(p_scores) WHERE jsonb_typeof(value) <> 'number') THEN
      RETURN jsonb_build_object('result','invalid_scores','detail','not_numeric'); END IF;
    BEGIN
      IF (p_scores->>'accuracy')::numeric < 0 OR (p_scores->>'accuracy')::numeric > 100
         OR (p_scores->>'policy')::numeric < 0 OR (p_scores->>'policy')::numeric > 100
         OR (p_scores->>'tone')::numeric < 0 OR (p_scores->>'tone')::numeric > 100
         OR (p_scores->>'sales')::numeric < 0 OR (p_scores->>'sales')::numeric > 100
         OR (p_scores->>'context')::numeric < 0 OR (p_scores->>'context')::numeric > 100
         OR (p_scores->>'hallucination_risk')::numeric < 0 OR (p_scores->>'hallucination_risk')::numeric > 100 THEN
        RETURN jsonb_build_object('result','invalid_scores','detail','out_of_range');
      END IF;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN jsonb_build_object('result','invalid_scores','detail','not_numeric');
    END;
    -- Validate p_details has exactly 6 canonical evaluator types (#2)
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_details) k)
       IS DISTINCT FROM ARRAY['accuracy','context','hallucination','policy','sales','tone'] THEN
      RETURN jsonb_build_object('result','invalid_details','detail','wrong_keys'); END IF;
    v_cid := COALESCE(v_a.company_id, (SELECT company_id FROM public.conversations WHERE id=v_a.conversation_id));
    v_q:=round(100-(p_scores->>'hallucination_risk')::numeric,2);
    v_o:=round((p_scores->>'accuracy')::numeric*0.25+(p_scores->>'policy')::numeric*0.20
      +(p_scores->>'tone')::numeric*0.20+(p_scores->>'sales')::numeric*0.15
      +(p_scores->>'context')::numeric*0.10+v_q*0.10,2);
    v_s:=CASE WHEN v_o<60 THEN 'critical' WHEN v_o<70 THEN 'high' WHEN v_o<80 THEN 'medium' ELSE 'low' END;
    v_v:=public.verified_human_response(v_a.conversation_id);
    INSERT INTO public.conversation_evaluation (
      attempt_id,conversation_id,evaluation_contract_version,input_snapshot_hash,
      accuracy_score,policy_score,tone_score,sales_score,context_score,
      hallucination_risk_score,hallucination_quality_score,overall_score,severity,
      has_verified_human_response,training_eligible,model_version,prompt_version,
      kb_snapshot_id,policy_snapshot_id,source_deployment,evaluated_by,
      company_id,bundle_hash,review_status,grounding_manifest
    ) VALUES (
      v_a.id,v_a.conversation_id,v_a.evaluation_contract_version,v_a.input_snapshot_hash,
      (p_scores->>'accuracy')::numeric,(p_scores->>'policy')::numeric,
      (p_scores->>'tone')::numeric,(p_scores->>'sales')::numeric,
      (p_scores->>'context')::numeric,(p_scores->>'hallucination_risk')::numeric,
      v_q,v_o,v_s,v_v,(v_o<70 AND v_v),v_a.model_version,v_a.prompt_version,
      v_a.kb_snapshot_id,v_a.policy_snapshot_id,v_a.source_deployment,v_a.initiated_by,
      v_cid,p_bundle_hash,'pending',v_a.grounding_manifest
    ) RETURNING id INTO v_eval_id;
    FOR v_et IN SELECT jsonb_object_keys(p_details) LOOP
      v_d:=p_details->v_et;
      v_w:=CASE v_et WHEN 'accuracy' THEN 0.25 WHEN 'policy' THEN 0.20 WHEN 'tone' THEN 0.20
          WHEN 'sales' THEN 0.15 WHEN 'context' THEN 0.10 WHEN 'hallucination' THEN 0.10 ELSE 0 END;
      INSERT INTO public.conversation_evaluation_detail (
        evaluation_id,evaluator_type,raw_score,weight,weighted_score,justification,
        raw_llm_response,recommended_correction,grounding_refs,
        evaluator_model_version,evaluator_prompt_version
      ) VALUES (v_eval_id,v_et,
        CASE v_et WHEN 'accuracy' THEN (p_scores->>'accuracy')::numeric
            WHEN 'policy' THEN (p_scores->>'policy')::numeric WHEN 'tone' THEN (p_scores->>'tone')::numeric
            WHEN 'sales' THEN (p_scores->>'sales')::numeric WHEN 'context' THEN (p_scores->>'context')::numeric
            WHEN 'hallucination' THEN (p_scores->>'hallucination_risk')::numeric END,
        v_w,
        round(CASE v_et WHEN 'accuracy' THEN (p_scores->>'accuracy')::numeric
            WHEN 'policy' THEN (p_scores->>'policy')::numeric WHEN 'tone' THEN (p_scores->>'tone')::numeric
            WHEN 'sales' THEN (p_scores->>'sales')::numeric WHEN 'context' THEN (p_scores->>'context')::numeric
            WHEN 'hallucination' THEN (p_scores->>'hallucination_risk')::numeric END * v_w, 2),
        left(coalesce(v_d->>'justification',''),2000), NULL,
        left(coalesce(v_d->>'recommended_correction',''),4000),
        coalesce(v_d->'grounding_refs','[]'::jsonb),
        v_a.model_version, v_a.prompt_version);
      IF v_d->'raw_llm_response' IS NOT NULL THEN
        INSERT INTO public.ce_raw_provider_output (evaluation_id,evaluator_type,company_id,raw_response)
        VALUES (v_eval_id,v_et,v_cid,v_d->'raw_llm_response');
      END IF;
    END LOOP;
    INSERT INTO public.ce_bundle_snapshot (
      attempt_id,conversation_id,company_id,bundle_hash,transcript_hash,
      evaluation_contract_version,model_version,prompt_version,
      kb_snapshot_id,policy_snapshot_id,canonical_input,normalized_transcript,
      evaluated_ai_reply,verified_human_response,grounding_evidence,
      grounding_manifest,truncation_manifest
    ) VALUES (
      v_a.id,v_a.conversation_id,v_cid,p_bundle_hash,v_a.input_snapshot_hash,
      v_a.evaluation_contract_version,v_a.model_version,v_a.prompt_version,
      v_a.kb_snapshot_id,v_a.policy_snapshot_id,
      coalesce(p_snapshot->>'canonical_input',''),
      coalesce(p_snapshot->'normalized_transcript','[]'::jsonb),
      p_snapshot->'evaluated_ai_reply',p_snapshot->'verified_human_response',
      coalesce(p_snapshot->'grounding_evidence','{}'::jsonb),
      coalesce(v_a.grounding_manifest,'{}'::jsonb),
      coalesce(p_snapshot->'truncation_manifest','{}'::jsonb));
    IF jsonb_typeof(coalesce(p_derived->'emotion','null'::jsonb))='array' THEN
      FOR v_emo IN SELECT value FROM jsonb_array_elements(p_derived->'emotion') LOOP
        INSERT INTO public.ce_emotion_point (evaluation_id,company_id,message_id,turn_index,
          occurred_at,sentiment,sentiment_score,trigger_label)
        VALUES (v_eval_id,v_cid,(v_emo->>'message_id')::uuid,(v_emo->>'turn_index')::int,
          coalesce((v_emo->>'occurred_at')::timestamptz,now()),v_emo->>'sentiment',
          (v_emo->>'sentiment_score')::numeric,v_emo->>'trigger_label')
        ON CONFLICT (evaluation_id,message_id) DO NOTHING;
      END LOOP;
    END IF;
    IF jsonb_typeof(coalesce(p_derived->'next_steps','null'::jsonb))='array' THEN
      FOR v_st IN SELECT value FROM jsonb_array_elements(p_derived->'next_steps') LOOP
        INSERT INTO public.ce_next_step (evaluation_id,company_id,ordinal,title,detail,owner_role)
        VALUES (v_eval_id,v_cid,(v_st->>'ordinal')::int,v_st->>'title',v_st->>'detail',
          CASE WHEN v_st->>'owner_role' IN ('admin','supervisor','agent','qa')
            THEN (v_st->>'owner_role')::public.app_role ELSE NULL END)
        ON CONFLICT (evaluation_id,ordinal) DO NOTHING;
      END LOOP;
    END IF;
    IF jsonb_typeof(coalesce(p_derived->'discrepancies','null'::jsonb))='array' THEN
      FOR v_dc IN SELECT value FROM jsonb_array_elements(p_derived->'discrepancies') LOOP
        INSERT INTO public.ce_discrepancy (evaluation_id,company_id,dimension,ai_claim,
          human_claim,grounded_claim,divergence_kind,severity,grounding_refs)
        VALUES (v_eval_id,v_cid,v_dc->>'dimension',
          left(coalesce(v_dc->>'ai_claim',''),4000),left(v_dc->>'human_claim',4000),
          left(v_dc->>'grounded_claim',4000),v_dc->>'divergence_kind',
          v_dc->>'severity',coalesce(v_dc->'grounding_refs','[]'::jsonb));
      END LOOP;
    END IF;
    UPDATE public.conversation_evaluation_attempt SET status='complete',updated_at=now() WHERE id=v_a.id;
    RETURN jsonb_build_object('result','success','evaluation_id',v_eval_id);
  END $f$$fn2$;
  EXECUTE 'REVOKE ALL ON FUNCTION public.complete_evaluation_v2(uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.complete_evaluation_v2(uuid,jsonb,jsonb,text,jsonb,jsonb) TO service_role';

  EXECUTE 'DROP FUNCTION IF EXISTS public.fail_evaluation(uuid,text)';
  EXECUTE $fn3$CREATE FUNCTION public.fail_evaluation(p_attempt_id uuid, p_error text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
  BEGIN
    UPDATE public.conversation_evaluation_attempt
       SET status='failed', error_message=left(coalesce(p_error,'unknown'),500), updated_at=now()
     WHERE id=p_attempt_id AND status='running';
    IF NOT FOUND THEN RETURN jsonb_build_object('result','noop'); END IF;
    RETURN jsonb_build_object('result','failed');
  END $f$$fn3$;
  EXECUTE 'REVOKE ALL ON FUNCTION public.fail_evaluation(uuid,text) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid,text) TO service_role';

  EXECUTE 'DROP FUNCTION IF EXISTS public.review_evaluation(uuid,uuid,text,text)';
  EXECUTE $fn4$CREATE FUNCTION public.review_evaluation(
    p_evaluation_id uuid, p_expected_conversation_id uuid,
    p_decision text, p_note text DEFAULT NULL
  ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
  DECLARE v_uid uuid:=auth.uid(); v_eval record; v_old text; v_new text; v_el boolean;
  BEGIN
    IF v_uid IS NULL THEN RETURN jsonb_build_object('result','forbidden'); END IF;
    SELECT id,conversation_id,company_id,review_status,training_eligible INTO v_eval
      FROM public.conversation_evaluation WHERE id=p_evaluation_id;
    IF v_eval IS NULL THEN RETURN jsonb_build_object('result','not_found'); END IF;
    IF v_eval.conversation_id<>p_expected_conversation_id THEN RETURN jsonb_build_object('result','scope_mismatch'); END IF;
    IF v_eval.company_id IS NULL THEN RETURN jsonb_build_object('result','tenant_unresolved'); END IF;
    IF NOT public.is_company_member(v_eval.company_id,v_uid) THEN RETURN jsonb_build_object('result','forbidden'); END IF;
    IF NOT (public.has_company_role(v_eval.company_id,v_uid,'admin'::public.app_role)
         OR public.has_company_role(v_eval.company_id,v_uid,'supervisor'::public.app_role)) THEN
      RETURN jsonb_build_object('result','forbidden'); END IF;
    v_old:=v_eval.review_status;
    v_new:=CASE p_decision WHEN 'accept' THEN 'accepted' WHEN 'reject' THEN 'rejected' WHEN 'reopen' THEN 'pending' ELSE NULL END;
    IF v_new IS NULL OR v_old=v_new THEN RETURN jsonb_build_object('result','invalid_transition'); END IF;
    IF v_new='rejected' AND (p_note IS NULL OR length(btrim(p_note))=0) THEN RETURN jsonb_build_object('result','note_required'); END IF;
    UPDATE public.conversation_evaluation
       SET review_status=v_new, reviewed_by=CASE WHEN v_new='pending' THEN NULL ELSE v_uid END,
           reviewed_at=CASE WHEN v_new='pending' THEN NULL ELSE now() END,
           review_note=CASE WHEN v_new='pending' THEN NULL ELSE left(p_note,2000) END
     WHERE id=p_evaluation_id;
    v_el:=v_eval.training_eligible;
    IF v_new='accepted' AND v_el THEN
      INSERT INTO public.evaluation_training_outbox (evaluation_id,status,delivery_idempotency_key,source_app,source_deployment,evaluation_contract_version,company_id)
      SELECT p_evaluation_id,'pending',p_evaluation_id::text,'ai_chatbot',e.source_deployment,e.evaluation_contract_version,e.company_id
        FROM public.conversation_evaluation e WHERE e.id=p_evaluation_id
      ON CONFLICT (evaluation_id) DO NOTHING;
    END IF;
    RETURN jsonb_build_object('result','success','from',v_old,'to',v_new,'reviewed_at',now(),'training_eligible',v_el,'outbox_created',(v_new='accepted' AND v_el));
  END $f$$fn4$;
  EXECUTE 'REVOKE ALL ON FUNCTION public.review_evaluation(uuid,uuid,text,text) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.review_evaluation(uuid,uuid,text,text) TO authenticated, service_role';

  EXECUTE 'DROP FUNCTION IF EXISTS public.reap_stale_evaluation_attempts(interval)';
  EXECUTE $fn5$CREATE FUNCTION public.reap_stale_evaluation_attempts(p_older_than interval DEFAULT '15 minutes')
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
  DECLARE v_n int;
  BEGIN
    UPDATE public.conversation_evaluation_attempt
       SET status='failed', error_message='CE_STALE_ATTEMPT_REAPED', updated_at=now()
     WHERE status='running' AND created_at<now()-p_older_than;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('reaped',v_n);
  END $f$$fn5$;
  EXECUTE 'REVOKE ALL ON FUNCTION public.reap_stale_evaluation_attempts(interval) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.reap_stale_evaluation_attempts(interval) TO service_role';

  EXECUTE $vw$CREATE OR REPLACE VIEW public.ce_conversation_status_v AS
  SELECT e.id AS evaluation_id,e.conversation_id,e.company_id,
    e.overall_score,e.severity,e.training_eligible,e.has_verified_human_response,
    e.created_at AS evaluated_at,e.review_status,
    o.status AS outbox_status,o.delivered_at,
    'none'::text AS improved_result_status,NULL::timestamptz AS improved_result_received_at,
    (e.review_status='pending' AND (e.severity IN ('critical','high') OR e.overall_score<70)) AS needs_review,
    (e.review_status='accepted' AND e.training_eligible AND COALESCE(o.status,'none')<>'delivered') AS training_ready,
    (COALESCE(o.status,'none')='delivered') AS trained,
    CASE WHEN COALESCE(o.status,'none')='delivered' THEN 'delivered'
         WHEN e.review_status='accepted' AND e.training_eligible THEN 'pending'
         ELSE 'not_applicable' END AS improved_result_state
  FROM public.conversation_evaluation e
  LEFT JOIN public.evaluation_training_outbox o ON o.evaluation_id=e.id$vw$;
  EXECUTE 'GRANT SELECT ON public.ce_conversation_status_v TO authenticated';
  EXECUTE 'GRANT ALL ON public.ce_conversation_status_v TO service_role';
END $all$;

COMMIT;
