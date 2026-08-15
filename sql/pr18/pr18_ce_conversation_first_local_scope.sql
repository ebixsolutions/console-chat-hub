BEGIN;
SET LOCAL lock_timeout='10s';

INSERT INTO public.ce_feature_flags(key,enabled,updated_at)
VALUES ('ce_conversation_first_enabled',true,now())
ON CONFLICT (key) DO UPDATE SET enabled=true,updated_at=now();

CREATE TABLE IF NOT EXISTS public.ce_local_evaluation_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  evaluation_contract_version text NOT NULL,
  input_snapshot_hash text NOT NULL,
  bundle_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('running','succeeded','failed')),
  pipeline_run_id uuid NOT NULL DEFAULT gen_random_uuid(),
  initiated_by uuid NOT NULL,
  model_version text NOT NULL,
  prompt_version text NOT NULL,
  source_deployment text NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id,input_snapshot_hash)
);

CREATE TABLE IF NOT EXISTS public.ce_local_evaluation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES public.ce_local_evaluation_attempt(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  company_id uuid NULL,
  evaluation_contract_version text NOT NULL,
  input_snapshot_hash text NOT NULL,
  bundle_hash text NOT NULL,
  accuracy_score numeric(6,2) NOT NULL,
  policy_score numeric(6,2) NOT NULL,
  tone_score numeric(6,2) NOT NULL,
  sales_score numeric(6,2) NOT NULL,
  context_score numeric(6,2) NOT NULL,
  hallucination_risk_score numeric(6,2) NOT NULL,
  hallucination_quality_score numeric(6,2) NOT NULL,
  overall_score numeric(6,2) NOT NULL,
  severity text NOT NULL CHECK(severity IN ('critical','high','medium','low')),
  has_verified_human_response boolean NOT NULL DEFAULT false,
  model_version text NOT NULL,
  prompt_version text NOT NULL,
  kb_snapshot_id text NOT NULL DEFAULT 'conversation-only',
  policy_snapshot_id text NOT NULL DEFAULT 'conversation-only',
  source_deployment text NOT NULL,
  review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','accepted','rejected')),
  review_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  grounding_manifest jsonb NOT NULL DEFAULT '{"mode":"conversation_only"}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ce_local_evaluation_detail (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES public.ce_local_evaluation(id) ON DELETE CASCADE,
  evaluator_type text NOT NULL,
  raw_score numeric(6,2) NOT NULL,
  weight numeric(6,4) NOT NULL,
  weighted_score numeric(8,4) NOT NULL,
  justification text NOT NULL,
  recommended_correction text,
  evaluator_model_version text,
  evaluator_prompt_version text,
  grounding_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(evaluation_id,evaluator_type)
);

CREATE TABLE IF NOT EXISTS public.ce_local_bundle_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES public.ce_local_evaluation_attempt(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  company_id uuid NULL,
  bundle_hash text NOT NULL,
  transcript_hash text NOT NULL,
  evaluation_contract_version text NOT NULL,
  model_version text NOT NULL,
  prompt_version text NOT NULL,
  kb_snapshot_id text NOT NULL DEFAULT 'conversation-only',
  policy_snapshot_id text NOT NULL DEFAULT 'conversation-only',
  canonical_input text NOT NULL,
  normalized_transcript jsonb NOT NULL,
  evaluated_ai_reply jsonb,
  verified_human_response jsonb,
  grounding_evidence jsonb NOT NULL DEFAULT '{"mode":"conversation_only"}'::jsonb,
  grounding_manifest jsonb NOT NULL DEFAULT '{"mode":"conversation_only"}'::jsonb,
  truncation_manifest jsonb NOT NULL,
  redaction_applied boolean NOT NULL DEFAULT true,
  retention_expires_at timestamptz NOT NULL DEFAULT (now()+interval '180 days'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ce_local_emotion_point (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES public.ce_local_evaluation(id) ON DELETE CASCADE,
  message_id uuid,
  turn_index integer NOT NULL,
  occurred_at timestamptz,
  sentiment text NOT NULL,
  sentiment_score numeric(6,2) NOT NULL,
  trigger_label text,
  UNIQUE(evaluation_id,turn_index)
);

CREATE TABLE IF NOT EXISTS public.ce_local_next_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES public.ce_local_evaluation(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  title text NOT NULL,
  detail text,
  owner_role text,
  status text NOT NULL DEFAULT 'open',
  UNIQUE(evaluation_id,ordinal)
);

CREATE TABLE IF NOT EXISTS public.ce_local_discrepancy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES public.ce_local_evaluation(id) ON DELETE CASCADE,
  dimension text NOT NULL,
  ai_claim text,
  human_claim text,
  grounded_claim text,
  divergence_kind text,
  severity text NOT NULL,
  grounding_refs jsonb NOT NULL DEFAULT '[]'::jsonb
);

ALTER TABLE public.ce_local_evaluation_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ce_local_evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ce_local_evaluation_detail ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ce_local_bundle_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ce_local_emotion_point ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ce_local_next_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ce_local_discrepancy ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ce_local_evaluation_attempt','ce_local_evaluation','ce_local_evaluation_detail',
    'ce_local_bundle_snapshot','ce_local_emotion_point','ce_local_next_step','ce_local_discrepancy'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_staff_read ON public.%I',t,t);
    EXECUTE format(
      'CREATE POLICY %I_staff_read ON public.%I FOR SELECT TO authenticated USING (public.is_staff(auth.uid()))',
      t,t
    );
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.ce_local_actor_can_evaluate(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=''
AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.user_roles r
    WHERE r.user_id=p_user_id
      AND r.role::text IN ('admin','supervisor','qa')
  )
$$;

CREATE OR REPLACE FUNCTION public.initiate_local_evaluation_v1(
  p_conversation_id uuid,
  p_contract_version text,
  p_input_snapshot_hash text,
  p_bundle_hash text,
  p_model_version text,
  p_prompt_version text,
  p_initiated_by uuid,
  p_source_deployment text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_attempt uuid;
  v_eval uuid;
  v_running integer;
  v_customer integer;
  v_ai integer;
BEGIN
  IF NOT COALESCE((SELECT enabled FROM public.ce_feature_flags WHERE key='ce_conversation_first_enabled'),false) THEN
    RETURN jsonb_build_object('result','feature_disabled');
  END IF;
  IF NOT public.ce_local_actor_can_evaluate(p_initiated_by) THEN
    RETURN jsonb_build_object('result','forbidden');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.conversations WHERE id=p_conversation_id) THEN
    RETURN jsonb_build_object('result','not_found');
  END IF;

  SELECT count(*) FILTER(WHERE lower(role) IN ('visitor','customer','user')),
         count(*) FILTER(WHERE lower(role) IN ('assistant','ai','bot'))
    INTO v_customer,v_ai
  FROM public.messages
  WHERE conversation_id=p_conversation_id
    AND NOT COALESCE(is_recalled,false)
    AND content IS DISTINCT FROM '__THINKING__';

  IF v_customer=0 OR v_ai=0 THEN
    RETURN jsonb_build_object('result','conversation_not_evaluable');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ce-local:'||p_conversation_id::text,0));

  SELECT e.id INTO v_eval
  FROM public.ce_local_evaluation e
  JOIN public.ce_local_evaluation_attempt a ON a.id=e.attempt_id
  WHERE a.conversation_id=p_conversation_id
    AND a.input_snapshot_hash=p_input_snapshot_hash
  LIMIT 1;
  IF v_eval IS NOT NULL THEN
    RETURN jsonb_build_object('result','already_evaluated','evaluation_id',v_eval);
  END IF;

  SELECT count(*) INTO v_running
  FROM public.ce_local_evaluation_attempt
  WHERE conversation_id=p_conversation_id AND status='running';
  IF v_running>0 THEN
    RETURN jsonb_build_object('result','already_in_progress');
  END IF;

  INSERT INTO public.ce_local_evaluation_attempt(
    conversation_id,evaluation_contract_version,input_snapshot_hash,bundle_hash,
    status,initiated_by,model_version,prompt_version,source_deployment
  ) VALUES(
    p_conversation_id,p_contract_version,p_input_snapshot_hash,p_bundle_hash,
    'running',p_initiated_by,p_model_version,p_prompt_version,p_source_deployment
  ) RETURNING id INTO v_attempt;

  RETURN jsonb_build_object('result','initiated','attempt_id',v_attempt);
END
$$;

CREATE OR REPLACE FUNCTION public.complete_local_evaluation_v1(
  p_attempt_id uuid,
  p_scores jsonb,
  p_details jsonb,
  p_bundle_hash text,
  p_snapshot jsonb,
  p_derived jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  a public.ce_local_evaluation_attempt;
  v_eval uuid;
  v_quality numeric;
  v_overall numeric;
  v_severity text;
  v_verified boolean;
  k text;
  d jsonb;
  e jsonb;
  n jsonb;
  x jsonb;
  v_weights jsonb := '{"accuracy":0.25,"policy":0.20,"tone":0.20,"sales":0.15,"context":0.10,"hallucination_risk":0.10}'::jsonb;
BEGIN
  SELECT * INTO a FROM public.ce_local_evaluation_attempt WHERE id=p_attempt_id FOR UPDATE;
  IF a.id IS NULL THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF a.status='succeeded' THEN
    SELECT id INTO v_eval FROM public.ce_local_evaluation WHERE attempt_id=a.id;
    RETURN jsonb_build_object('result','success','evaluation_id',v_eval,'idempotent',true);
  END IF;
  IF p_bundle_hash IS DISTINCT FROM a.bundle_hash THEN
    RETURN jsonb_build_object('result','bundle_hash_mismatch');
  END IF;

  FOREACH k IN ARRAY ARRAY['accuracy','policy','tone','sales','context','hallucination_risk'] LOOP
    IF NOT (p_scores ? k) THEN RETURN jsonb_build_object('result','invalid_scores'); END IF;
    IF (p_scores->>k)::numeric<0 OR (p_scores->>k)::numeric>100 THEN
      RETURN jsonb_build_object('result','invalid_scores');
    END IF;
  END LOOP;

  v_quality:=round(100-(p_scores->>'hallucination_risk')::numeric,2);
  v_overall:=round(
      (p_scores->>'accuracy')::numeric*0.25
    + (p_scores->>'policy')::numeric*0.20
    + (p_scores->>'tone')::numeric*0.20
    + (p_scores->>'sales')::numeric*0.15
    + (p_scores->>'context')::numeric*0.10
    + v_quality*0.10,2
  );
  v_severity:=CASE WHEN v_overall<60 THEN 'critical'
                   WHEN v_overall<70 THEN 'high'
                   WHEN v_overall<80 THEN 'medium'
                   ELSE 'low' END;

  SELECT EXISTS(
    SELECT 1 FROM public.messages m
    WHERE m.conversation_id=a.conversation_id
      AND lower(m.role) IN ('agent','human','human_agent','supervisor')
      AND m.sender_id IS NOT NULL
      AND m.sender_identity_verified_at IS NOT NULL
  ) INTO v_verified;

  INSERT INTO public.ce_local_evaluation(
    attempt_id,conversation_id,evaluation_contract_version,input_snapshot_hash,bundle_hash,
    accuracy_score,policy_score,tone_score,sales_score,context_score,
    hallucination_risk_score,hallucination_quality_score,overall_score,severity,
    has_verified_human_response,model_version,prompt_version,source_deployment
  ) VALUES(
    a.id,a.conversation_id,a.evaluation_contract_version,a.input_snapshot_hash,a.bundle_hash,
    (p_scores->>'accuracy')::numeric,(p_scores->>'policy')::numeric,
    (p_scores->>'tone')::numeric,(p_scores->>'sales')::numeric,
    (p_scores->>'context')::numeric,(p_scores->>'hallucination_risk')::numeric,
    v_quality,v_overall,v_severity,v_verified,a.model_version,a.prompt_version,a.source_deployment
  ) RETURNING id INTO v_eval;

  FOR d IN SELECT value FROM jsonb_each(p_details) LOOP
    INSERT INTO public.ce_local_evaluation_detail(
      evaluation_id,evaluator_type,raw_score,weight,weighted_score,justification,
      recommended_correction,evaluator_model_version,evaluator_prompt_version,grounding_refs
    ) VALUES(
      v_eval,d->>'evaluator_type',(d->>'raw_score')::numeric,(d->>'weight')::numeric,
      (d->>'weighted_score')::numeric,left(coalesce(d->>'justification',''),2000),
      left(coalesce(d->>'recommended_correction',''),4000),
      d->>'model_version',d->>'prompt_version',
      COALESCE(d->'grounding_refs','[]'::jsonb)
    );
  END LOOP;

  INSERT INTO public.ce_local_bundle_snapshot(
    attempt_id,conversation_id,bundle_hash,transcript_hash,evaluation_contract_version,
    model_version,prompt_version,canonical_input,normalized_transcript,
    evaluated_ai_reply,verified_human_response,grounding_evidence,grounding_manifest,
    truncation_manifest,redaction_applied
  ) VALUES(
    a.id,a.conversation_id,a.bundle_hash,
    coalesce(p_snapshot->>'transcript_hash',a.input_snapshot_hash),
    a.evaluation_contract_version,a.model_version,a.prompt_version,
    coalesce(p_snapshot->>'canonical_input',''),
    coalesce(p_snapshot->'normalized_transcript','[]'::jsonb),
    p_snapshot->'evaluated_ai_reply',p_snapshot->'verified_human_response',
    coalesce(p_snapshot->'grounding_evidence','{"mode":"conversation_only"}'::jsonb),
    '{"mode":"conversation_only"}'::jsonb,
    coalesce(p_snapshot->'truncation_manifest','{}'::jsonb),true
  );

  FOR e IN SELECT value FROM jsonb_array_elements(coalesce(p_derived->'emotion','[]'::jsonb)) LOOP
    INSERT INTO public.ce_local_emotion_point(
      evaluation_id,message_id,turn_index,occurred_at,sentiment,sentiment_score,trigger_label
    ) VALUES(
      v_eval,NULLIF(e->>'message_id','')::uuid,(e->>'turn_index')::integer,
      NULLIF(e->>'occurred_at','')::timestamptz,e->>'sentiment',
      (e->>'sentiment_score')::numeric,left(coalesce(e->>'trigger_label',''),200)
    );
  END LOOP;

  FOR n IN SELECT value FROM jsonb_array_elements(coalesce(p_derived->'next_steps','[]'::jsonb)) LOOP
    INSERT INTO public.ce_local_next_step(evaluation_id,ordinal,title,detail,owner_role)
    VALUES(
      v_eval,(n->>'ordinal')::integer,left(n->>'title',200),
      left(coalesce(n->>'detail',''),1000),nullif(n->>'owner_role','')
    );
  END LOOP;

  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_derived->'discrepancies','[]'::jsonb)) LOOP
    INSERT INTO public.ce_local_discrepancy(
      evaluation_id,dimension,ai_claim,human_claim,grounded_claim,divergence_kind,severity,grounding_refs
    ) VALUES(
      v_eval,x->>'dimension',left(coalesce(x->>'ai_claim',''),4000),
      left(coalesce(x->>'human_claim',''),4000),left(coalesce(x->>'grounded_claim',''),4000),
      x->>'divergence_kind',x->>'severity',coalesce(x->'grounding_refs','[]'::jsonb)
    );
  END LOOP;

  UPDATE public.ce_local_evaluation_attempt SET status='succeeded',updated_at=now() WHERE id=a.id;
  RETURN jsonb_build_object('result','success','evaluation_id',v_eval,'overall_score',v_overall,'severity',v_severity);
END
$$;

CREATE OR REPLACE FUNCTION public.fail_local_evaluation_v1(p_attempt_id uuid,p_error text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
BEGIN
  UPDATE public.ce_local_evaluation_attempt
  SET status='failed',error_code=left(coalesce(p_error,'unknown'),200),updated_at=now()
  WHERE id=p_attempt_id AND status='running';
  RETURN jsonb_build_object('result','failed');
END
$$;

CREATE OR REPLACE FUNCTION public.review_local_evaluation_v1(
  p_evaluation_id uuid,p_expected_conversation_id uuid,p_decision text,p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE v_uid uuid:=auth.uid(); v_current text; v_target text;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.user_roles r
    WHERE r.user_id=v_uid AND r.role::text IN ('admin','supervisor')
  ) THEN RETURN jsonb_build_object('result','forbidden'); END IF;

  SELECT review_status INTO v_current
  FROM public.ce_local_evaluation
  WHERE id=p_evaluation_id AND conversation_id=p_expected_conversation_id
  FOR UPDATE;
  IF v_current IS NULL THEN RETURN jsonb_build_object('result','not_found'); END IF;

  v_target:=CASE p_decision WHEN 'accept' THEN 'accepted'
                            WHEN 'reject' THEN 'rejected'
                            WHEN 'reopen' THEN 'pending'
                            ELSE NULL END;
  IF v_target IS NULL THEN RETURN jsonb_build_object('result','invalid_transition'); END IF;
  IF p_decision='reject' AND nullif(trim(coalesce(p_note,'')),'') IS NULL THEN
    RETURN jsonb_build_object('result','note_required');
  END IF;

  UPDATE public.ce_local_evaluation
  SET review_status=v_target,review_note=nullif(trim(coalesce(p_note,'')),''),
      reviewed_by=v_uid,reviewed_at=now()
  WHERE id=p_evaluation_id;

  RETURN jsonb_build_object('result','success','from',v_current,'to',v_target,'reviewed_at',now());
END
$$;

REVOKE ALL ON FUNCTION public.ce_local_actor_can_evaluate(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.initiate_local_evaluation_v1(uuid,text,text,text,text,text,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.complete_local_evaluation_v1(uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fail_local_evaluation_v1(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ce_local_actor_can_evaluate(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.initiate_local_evaluation_v1(uuid,text,text,text,text,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_local_evaluation_v1(uuid,jsonb,jsonb,text,jsonb,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_local_evaluation_v1(uuid,text) TO service_role;

REVOKE ALL ON FUNCTION public.review_local_evaluation_v1(uuid,uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_local_evaluation_v1(uuid,uuid,text,text) TO authenticated,service_role;

COMMIT;
