-- PR-6B — atomic SU CoachAI training-result ingest
-- SOURCE ONLY: do not apply without explicit Director authorization.

BEGIN;

CREATE OR REPLACE FUNCTION public.record_coachai_training_result_tx(
  p_contract_version text,
  p_evaluation_id uuid,
  p_company_id uuid,
  p_idempotency_key text,
  p_decision text,
  p_remote_ref text,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_eval record;
  v_outbox record;
  v_existing record;
  v_payload jsonb;
BEGIN
  IF p_contract_version IS DISTINCT FROM 'SU_COACHAI_TRAINING_RESULT_V1' THEN
    RETURN jsonb_build_object('result','contract_mismatch');
  END IF;
  IF p_decision NOT IN ('trained','not_trained','rejected') THEN
    RETURN jsonb_build_object('result','invalid_decision');
  END IF;
  IF p_result IS NULL OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('result','invalid_result');
  END IF;

  SELECT id, company_id, conversation_id, evaluation_contract_version
    INTO v_eval
  FROM public.conversation_evaluation
  WHERE id = p_evaluation_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','evaluation_not_found');
  END IF;
  IF v_eval.company_id IS NULL OR v_eval.company_id IS DISTINCT FROM p_company_id THEN
    RETURN jsonb_build_object('result','company_mismatch');
  END IF;

  SELECT id, status, delivery_idempotency_key, company_id
    INTO v_outbox
  FROM public.evaluation_training_outbox
  WHERE evaluation_id = p_evaluation_id
  FOR UPDATE;

  IF NOT FOUND OR v_outbox.status IS DISTINCT FROM 'delivered' THEN
    RETURN jsonb_build_object('result','outbox_not_delivered');
  END IF;
  IF v_outbox.company_id IS DISTINCT FROM p_company_id THEN
    RETURN jsonb_build_object('result','company_mismatch');
  END IF;
  IF v_outbox.delivery_idempotency_key IS DISTINCT FROM p_idempotency_key THEN
    RETURN jsonb_build_object('result','idempotency_mismatch');
  END IF;

  v_payload := jsonb_build_object(
    'contract_version', p_contract_version,
    'decision', p_decision,
    'idempotency_key', p_idempotency_key,
    'evaluation_contract_version', v_eval.evaluation_contract_version,
    'result', p_result
  );

  SELECT id, payload, improved_result, improved_state, remote_ref
    INTO v_existing
  FROM public.ce_training_link
  WHERE evaluation_id = p_evaluation_id
    AND link_kind = 'training_candidate'
  FOR UPDATE;

  IF FOUND THEN
    -- Same result is safe to replay. A different result for the same evaluation
    -- is never allowed to overwrite historical training truth.
    IF v_existing.payload = v_payload
       AND v_existing.improved_result = p_result
       AND v_existing.remote_ref IS NOT DISTINCT FROM p_remote_ref
       AND v_existing.improved_state = 'received' THEN
      RETURN jsonb_build_object('result','idempotent','training_link_id',v_existing.id);
    END IF;
    RETURN jsonb_build_object('result','idempotency_mismatch');
  END IF;

  INSERT INTO public.ce_training_link (
    evaluation_id,
    company_id,
    link_kind,
    local_state,
    payload,
    improved_result,
    improved_state,
    remote_sync_state,
    remote_ref,
    updated_at
  )
  VALUES (
    p_evaluation_id,
    p_company_id,
    'training_candidate',
    'delivered',
    v_payload,
    p_result,
    'received',
    'synced',
    p_remote_ref,
    now()
  )
  RETURNING id INTO v_existing;

  RETURN jsonb_build_object(
    'result','success',
    'training_link_id',v_existing.id,
    'decision',p_decision
  );
END;
$function$;

ALTER FUNCTION public.record_coachai_training_result_tx(
  text,uuid,uuid,text,text,text,jsonb
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.record_coachai_training_result_tx(
  text,uuid,uuid,text,text,text,jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_coachai_training_result_tx(
  text,uuid,uuid,text,text,text,jsonb
) FROM anon;
REVOKE ALL ON FUNCTION public.record_coachai_training_result_tx(
  text,uuid,uuid,text,text,text,jsonb
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_coachai_training_result_tx(
  text,uuid,uuid,text,text,text,jsonb
) TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.record_coachai_training_result_tx(text,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: authenticated execute must be denied';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.record_coachai_training_result_tx(text,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: service_role execute missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ce_training_link'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%evaluation_id%link_kind%'
  ) THEN
    RAISE EXCEPTION 'ASSERT: ce_training_link unique evaluation/link_kind required';
  END IF;
END
$assert$;

COMMIT;
