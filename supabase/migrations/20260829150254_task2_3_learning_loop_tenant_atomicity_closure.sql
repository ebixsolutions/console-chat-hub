-- Task 2.3 — AI Chatbot -> SU CoachAI -> KB learning loop closure.
-- Strengthen tenant lineage and saga state transitions without reopening Task 2.2.

DO $pre$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.ce_training_link l
    JOIN public.conversation_evaluation e ON e.id=l.evaluation_id
    WHERE l.company_id IS DISTINCT FROM e.company_id
  ) THEN RAISE EXCEPTION 'TASK2_3_TRAINING_LINK_TENANT_PRECONDITION'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.ce_kb_publish_state s
    JOIN public.conversation_evaluation e ON e.id=s.evaluation_id
    WHERE s.company_id IS DISTINCT FROM e.company_id
  ) THEN RAISE EXCEPTION 'TASK2_3_KB_STATE_TENANT_PRECONDITION'; END IF;
END
$pre$;

ALTER TABLE public.ce_training_link
  DROP CONSTRAINT IF EXISTS ce_training_link_evaluation_company_fkey;
ALTER TABLE public.ce_training_link
  ADD CONSTRAINT ce_training_link_evaluation_company_fkey
  FOREIGN KEY (evaluation_id, company_id)
  REFERENCES public.conversation_evaluation(id, company_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.ce_training_link
  VALIDATE CONSTRAINT ce_training_link_evaluation_company_fkey;

ALTER TABLE public.ce_kb_publish_state
  DROP CONSTRAINT IF EXISTS ce_kb_publish_state_evaluation_company_fkey;
ALTER TABLE public.ce_kb_publish_state
  ADD CONSTRAINT ce_kb_publish_state_evaluation_company_fkey
  FOREIGN KEY (evaluation_id, company_id)
  REFERENCES public.conversation_evaluation(id, company_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.ce_kb_publish_state
  VALIDATE CONSTRAINT ce_kb_publish_state_evaluation_company_fkey;

ALTER TABLE public.ce_kb_publish_state
  DROP CONSTRAINT IF EXISTS ce_kb_publish_state_document_ref_nonempty_check;
ALTER TABLE public.ce_kb_publish_state
  ADD CONSTRAINT ce_kb_publish_state_document_ref_nonempty_check
  CHECK (length(btrim(kb_document_ref)) > 0) NOT VALID;
ALTER TABLE public.ce_kb_publish_state
  VALIDATE CONSTRAINT ce_kb_publish_state_document_ref_nonempty_check;

CREATE OR REPLACE FUNCTION public.record_coachai_training_result_tx(
  p_contract_version text,
  p_evaluation_id uuid,
  p_company_id uuid,
  p_idempotency_key text,
  p_decision text,
  p_remote_ref text,
  p_result jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
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
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 1 OR length(p_idempotency_key) > 200 THEN
    RETURN jsonb_build_object('result','invalid_idempotency_key');
  END IF;
  IF p_remote_ref IS NOT NULL AND length(p_remote_ref) > 500 THEN
    RETURN jsonb_build_object('result','invalid_remote_ref');
  END IF;

  SELECT id,company_id,conversation_id,evaluation_contract_version
  INTO v_eval
  FROM public.conversation_evaluation
  WHERE id=p_evaluation_id
  FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','evaluation_not_found'); END IF;
  IF v_eval.company_id IS DISTINCT FROM p_company_id THEN
    RETURN jsonb_build_object('result','company_mismatch');
  END IF;

  SELECT id,status,delivery_idempotency_key,company_id
  INTO v_outbox
  FROM public.evaluation_training_outbox
  WHERE evaluation_id=p_evaluation_id AND company_id=p_company_id
  FOR UPDATE;
  IF NOT FOUND OR v_outbox.status IS DISTINCT FROM 'delivered' THEN
    RETURN jsonb_build_object('result','outbox_not_delivered');
  END IF;
  IF v_outbox.delivery_idempotency_key IS DISTINCT FROM p_idempotency_key THEN
    RETURN jsonb_build_object('result','idempotency_mismatch');
  END IF;

  v_payload:=jsonb_build_object(
    'contract_version',p_contract_version,
    'decision',p_decision,
    'idempotency_key',p_idempotency_key,
    'evaluation_contract_version',v_eval.evaluation_contract_version,
    'result',p_result
  );

  SELECT id,payload,improved_result,improved_state,remote_ref
  INTO v_existing
  FROM public.ce_training_link
  WHERE evaluation_id=p_evaluation_id
    AND company_id=p_company_id
    AND link_kind='training_candidate'
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.payload=v_payload
       AND v_existing.improved_result=p_result
       AND v_existing.remote_ref IS NOT DISTINCT FROM p_remote_ref
       AND v_existing.improved_state='received' THEN
      RETURN jsonb_build_object('result','idempotent','training_link_id',v_existing.id);
    END IF;
    RETURN jsonb_build_object('result','idempotency_mismatch');
  END IF;

  INSERT INTO public.ce_training_link(
    evaluation_id,company_id,link_kind,local_state,payload,improved_result,
    improved_state,remote_sync_state,remote_ref,updated_at
  ) VALUES(
    p_evaluation_id,p_company_id,'training_candidate','delivered',v_payload,p_result,
    'received','synced',p_remote_ref,now()
  ) RETURNING id INTO v_existing;

  RETURN jsonb_build_object('result','success','training_link_id',v_existing.id,'decision',p_decision);
END
$fn$;

CREATE OR REPLACE FUNCTION public.claim_pr6b_kb_sync_tx()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE v record; v_state_id uuid;
BEGIN
  SELECT l.id,l.evaluation_id,l.company_id,l.improved_result,l.payload
  INTO v
  FROM public.ce_training_link l
  JOIN public.conversation_evaluation e
    ON e.id=l.evaluation_id AND e.company_id=l.company_id
  WHERE l.link_kind='training_candidate'
    AND l.improved_state='received'
    AND l.remote_sync_state='synced'
    AND COALESCE(l.payload->>'decision','')='trained'
    AND jsonb_typeof(l.improved_result->'kb_update')='object'
    AND jsonb_typeof(l.improved_result->'kb_update'->'approval')='object'
    AND COALESCE(l.improved_result->'kb_update'->'approval'->>'status','')='approved'
    AND COALESCE(l.improved_result->'kb_update'->'approval'->>'source','')='su_coachai_verified_correction'
    AND NULLIF(trim(COALESCE(l.improved_result->'kb_update'->'approval'->>'approved_by','')),'') IS NOT NULL
    AND NULLIF(trim(COALESCE(l.improved_result->'kb_update'->'approval'->>'approved_at','')),'') IS NOT NULL
    AND NULLIF(trim(COALESCE(l.improved_result->'kb_update'->>'document_id','')),'') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.ce_kb_publish_state s
      WHERE s.evaluation_id=l.evaluation_id
        AND s.company_id=l.company_id
        AND s.action='publish'
        AND s.state IN ('in_progress','published','failed')
    )
  ORDER BY l.created_at
  FOR UPDATE OF l SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN jsonb_build_object('result','none'); END IF;

  INSERT INTO public.ce_kb_publish_state(
    evaluation_id,company_id,kb_document_ref,action,state,requested_by,
    remote_sync_state,updated_at
  ) VALUES(
    v.evaluation_id,v.company_id,v.improved_result->'kb_update'->>'document_id',
    'publish','in_progress','00000000-0000-0000-0000-000000000000'::uuid,
    'pending',now()
  )
  ON CONFLICT(evaluation_id,action) DO UPDATE
    SET company_id=EXCLUDED.company_id,
        kb_document_ref=EXCLUDED.kb_document_ref,
        state='in_progress',remote_sync_state='pending',remote_ref=NULL,
        updated_at=now(),last_error=NULL
  RETURNING id INTO v_state_id;

  RETURN jsonb_build_object(
    'result','claimed','training_link_id',v.id,'evaluation_id',v.evaluation_id,
    'company_id',v.company_id,'improved_result',v.improved_result,
    'payload',v.payload,'publish_state_id',v_state_id
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.finish_pr6b_kb_sync_tx(
  p_training_link_id uuid,
  p_success boolean,
  p_remote_ref text,
  p_error text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE v record; s record;
BEGIN
  SELECT id,evaluation_id,company_id,improved_state,remote_sync_state
  INTO v
  FROM public.ce_training_link
  WHERE id=p_training_link_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF v.improved_state <> 'received' OR v.remote_sync_state <> 'synced' THEN
    RETURN jsonb_build_object('result','training_link_not_ready');
  END IF;

  SELECT id,state,remote_sync_state,remote_ref
  INTO s
  FROM public.ce_kb_publish_state
  WHERE evaluation_id=v.evaluation_id
    AND company_id=v.company_id
    AND action='publish'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','publish_state_not_found'); END IF;

  IF p_success THEN
    IF p_remote_ref IS NULL OR length(btrim(p_remote_ref))=0 OR length(p_remote_ref)>500 THEN
      RETURN jsonb_build_object('result','remote_ref_invalid');
    END IF;
    IF s.remote_ref IS NOT NULL AND s.remote_ref IS DISTINCT FROM p_remote_ref THEN
      RETURN jsonb_build_object('result','remote_ref_mismatch');
    END IF;
    IF s.state='in_progress' AND s.remote_sync_state='pending' AND s.remote_ref IS NOT DISTINCT FROM p_remote_ref THEN
      RETURN jsonb_build_object('result','idempotent');
    END IF;
    IF s.state <> 'in_progress' OR s.remote_sync_state NOT IN ('pending') THEN
      RETURN jsonb_build_object('result','stale_state');
    END IF;
    UPDATE public.ce_kb_publish_state
       SET remote_sync_state='pending',remote_ref=p_remote_ref,last_error=NULL,updated_at=now()
     WHERE id=s.id;
  ELSE
    IF s.state='failed' AND s.remote_sync_state='failed' THEN
      RETURN jsonb_build_object('result','idempotent');
    END IF;
    IF s.state <> 'in_progress' THEN RETURN jsonb_build_object('result','stale_state'); END IF;
    UPDATE public.ce_kb_publish_state
       SET state='failed',remote_sync_state='failed',
           last_error=left(COALESCE(p_error,'kb_sync_failed'),500),updated_at=now()
     WHERE id=s.id;
  END IF;

  RETURN jsonb_build_object('result','success');
END
$fn$;

CREATE OR REPLACE FUNCTION public.claim_pr6b_kb_finalize_tx()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE v record;
BEGIN
  UPDATE public.ce_kb_publish_state
     SET remote_sync_state='pending',last_error='finalizer_stale_claim_recovered',updated_at=now()
   WHERE action='publish' AND state='in_progress' AND remote_sync_state='in_progress'
     AND updated_at<now()-interval '15 minutes';

  SELECT s.id AS publish_state_id,s.evaluation_id,s.company_id,
         s.kb_document_ref AS document_id,s.remote_ref AS operation_id,l.improved_result
  INTO v
  FROM public.ce_kb_publish_state s
  JOIN public.ce_training_link l
    ON l.evaluation_id=s.evaluation_id
   AND l.company_id=s.company_id
   AND l.link_kind='training_candidate'
  WHERE s.action='publish' AND s.state='in_progress'
    AND s.remote_sync_state='pending' AND s.remote_ref IS NOT NULL
    AND l.improved_state='received' AND l.remote_sync_state='synced'
  ORDER BY s.updated_at
  FOR UPDATE OF s SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN jsonb_build_object('result','none'); END IF;

  UPDATE public.ce_kb_publish_state
     SET remote_sync_state='in_progress',last_error=NULL,updated_at=now()
   WHERE id=v.publish_state_id;

  RETURN jsonb_build_object(
    'result','claimed','publish_state_id',v.publish_state_id,
    'evaluation_id',v.evaluation_id,'company_id',v.company_id,
    'document_id',v.document_id,'operation_id',v.operation_id,
    'improved_result',v.improved_result
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.finish_pr6b_kb_finalize_tx(
  p_publish_state_id uuid,
  p_outcome text,
  p_error text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE v record;
BEGIN
  IF p_outcome NOT IN ('pending','published','failed') THEN
    RETURN jsonb_build_object('result','invalid_outcome');
  END IF;

  SELECT id,state,remote_sync_state
  INTO v
  FROM public.ce_kb_publish_state
  WHERE id=p_publish_state_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;

  IF v.state='published' AND p_outcome='published' THEN
    RETURN jsonb_build_object('result','idempotent');
  END IF;
  IF v.state='failed' AND p_outcome='failed' THEN
    RETURN jsonb_build_object('result','idempotent');
  END IF;
  IF v.state<>'in_progress' OR v.remote_sync_state<>'in_progress' THEN
    RETURN jsonb_build_object('result','stale_state');
  END IF;

  UPDATE public.ce_kb_publish_state
     SET state=CASE WHEN p_outcome='published' THEN 'published'
                    WHEN p_outcome='failed' THEN 'failed' ELSE 'in_progress' END,
         remote_sync_state=CASE WHEN p_outcome='published' THEN 'synced'
                                WHEN p_outcome='failed' THEN 'failed' ELSE 'pending' END,
         last_error=CASE WHEN p_outcome='published' THEN NULL
                         ELSE left(COALESCE(p_error,''),500) END,
         updated_at=now()
   WHERE id=p_publish_state_id;

  RETURN jsonb_build_object('result','success','outcome',p_outcome);
END
$fn$;

REVOKE ALL ON FUNCTION public.record_coachai_training_result_tx(text,uuid,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_pr6b_kb_sync_tx() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_pr6b_kb_sync_tx(uuid,boolean,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_pr6b_kb_finalize_tx() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_pr6b_kb_finalize_tx(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_coachai_training_result_tx(text,uuid,uuid,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_pr6b_kb_sync_tx() TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_pr6b_kb_sync_tx(uuid,boolean,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_pr6b_kb_finalize_tx() TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_pr6b_kb_finalize_tx(uuid,text,text) TO service_role;

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.ce_training_link l
    JOIN public.conversation_evaluation e ON e.id=l.evaluation_id
    WHERE l.company_id IS DISTINCT FROM e.company_id
  ) OR EXISTS (
    SELECT 1 FROM public.ce_kb_publish_state s
    JOIN public.conversation_evaluation e ON e.id=s.evaluation_id
    WHERE s.company_id IS DISTINCT FROM e.company_id
  ) THEN RAISE EXCEPTION 'TASK2_3_POST_MIGRATION_TENANT_ASSERTION'; END IF;
END
$assert$;
