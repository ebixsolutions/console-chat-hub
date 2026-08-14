BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.initiate_evaluation_v2(
  p_conversation_id uuid, p_contract_version text, p_kb_snapshot_id text,
  p_policy_snapshot_id text, p_model_version text, p_prompt_version text,
  p_input_snapshot_hash text, p_bundle_hash text, p_grounding_manifest jsonb,
  p_initiated_by uuid, p_source_deployment text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_conv record;
  v_resolved_company_id uuid;
  v_attempt_id uuid;
  v_eval_id uuid;
  v_running int;
BEGIN
  IF NOT COALESCE((SELECT enabled FROM public.ce_feature_flags WHERE key='ce_grounding_fail_closed_enabled'),false) THEN
    RETURN jsonb_build_object('result','feature_disabled');
  END IF;

  SELECT
    c.id,
    c.company_id AS conversation_company_id,
    ch.company_id AS channel_company_id
  INTO v_conv
  FROM public.conversations c
  LEFT JOIN public.channel_config ch ON ch.id = c.channel_config_id
  WHERE c.id = p_conversation_id;

  IF v_conv IS NULL THEN
    RETURN jsonb_build_object('result','not_found');
  END IF;

  IF v_conv.conversation_company_id IS NOT NULL
     AND v_conv.channel_company_id IS NOT NULL
     AND v_conv.conversation_company_id <> v_conv.channel_company_id THEN
    RETURN jsonb_build_object('result','tenant_identity_conflict');
  END IF;

  v_resolved_company_id := COALESCE(
    v_conv.conversation_company_id,
    v_conv.channel_company_id
  );

  IF v_resolved_company_id IS NULL THEN
    RETURN jsonb_build_object('result','tenant_unresolved');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.company c
    WHERE c.id = v_resolved_company_id AND c.is_active = true
  ) THEN
    RETURN jsonb_build_object('result','tenant_forbidden');
  END IF;

  IF NOT public.is_company_member(v_resolved_company_id, p_initiated_by) THEN
    RETURN jsonb_build_object('result','tenant_forbidden');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_conversation_id::text,0));

  SELECT ce.id INTO v_eval_id
  FROM public.conversation_evaluation ce
  JOIN public.conversation_evaluation_attempt a ON a.id=ce.attempt_id
  WHERE a.conversation_id=p_conversation_id
    AND a.input_snapshot_hash=p_input_snapshot_hash
  LIMIT 1;
  IF v_eval_id IS NOT NULL THEN
    RETURN jsonb_build_object('result','already_evaluated','evaluation_id',v_eval_id);
  END IF;

  SELECT count(*) INTO v_running
  FROM public.conversation_evaluation_attempt
  WHERE conversation_id=p_conversation_id AND status='running';
  IF v_running>0 THEN
    RETURN jsonb_build_object('result','already_in_progress');
  END IF;

  INSERT INTO public.conversation_evaluation_attempt (
    conversation_id,evaluation_contract_version,input_snapshot_hash,status,
    pipeline_run_id,initiated_by,kb_snapshot_id,policy_snapshot_id,
    model_version,prompt_version,source_deployment,bundle_hash,grounding_manifest,company_id
  ) VALUES (
    p_conversation_id,p_contract_version,p_input_snapshot_hash,'running',
    gen_random_uuid(),p_initiated_by,p_kb_snapshot_id,p_policy_snapshot_id,
    p_model_version,p_prompt_version,p_source_deployment,p_bundle_hash,
    p_grounding_manifest,v_resolved_company_id
  ) RETURNING id INTO v_attempt_id;

  RETURN jsonb_build_object('result','initiated','attempt_id',v_attempt_id);
END
$function$;

REVOKE ALL ON FUNCTION public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text) TO service_role;

COMMIT;
