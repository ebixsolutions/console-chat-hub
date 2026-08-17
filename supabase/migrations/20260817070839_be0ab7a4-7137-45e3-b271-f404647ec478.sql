SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- Automation-only attempt initiation. These are service-role only and require a
-- currently-running queue job whose server-derived company matches conversation.
-- No caller-controlled tenant is accepted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_automation_initiate_local_v1(
  p_job_id uuid,
  p_contract_version text,
  p_input_snapshot_hash text,
  p_bundle_hash text,
  p_model_version text,
  p_prompt_version text,
  p_source_deployment text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.ce_evaluation_job;
  v_attempt uuid;
  v_eval uuid;
  v_running integer;
BEGIN
  SELECT * INTO v_job
  FROM public.ce_evaluation_job
  WHERE id=p_job_id AND status='running'
  FOR UPDATE;
  IF v_job.id IS NULL THEN RETURN jsonb_build_object('result','job_not_running'); END IF;
  IF v_job.company_id IS NOT NULL THEN RETURN jsonb_build_object('result','canonical_required'); END IF;
  IF NOT public.ce_conversation_evaluable_v1(v_job.conversation_id) THEN
    RETURN jsonb_build_object('result','conversation_not_evaluable');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ce-local:'||v_job.conversation_id::text,0));

  SELECT e.id INTO v_eval
  FROM public.ce_local_evaluation e
  WHERE e.conversation_id=v_job.conversation_id
    AND e.input_snapshot_hash=p_input_snapshot_hash
    AND e.evaluation_fingerprint=v_job.evaluation_fingerprint
  ORDER BY e.created_at DESC
  LIMIT 1;
  IF v_eval IS NOT NULL THEN
    RETURN jsonb_build_object('result','already_evaluated','evaluation_id',v_eval);
  END IF;

  SELECT count(*) INTO v_running
  FROM public.ce_local_evaluation_attempt
  WHERE conversation_id=v_job.conversation_id AND status='running';
  IF v_running>0 THEN RETURN jsonb_build_object('result','already_in_progress'); END IF;

  INSERT INTO public.ce_local_evaluation_attempt(
    conversation_id,evaluation_contract_version,input_snapshot_hash,bundle_hash,
    status,initiated_by,initiated_by_kind,model_version,prompt_version,
    source_deployment,evaluation_fingerprint
  ) VALUES (
    v_job.conversation_id,p_contract_version,p_input_snapshot_hash,p_bundle_hash,
    'running','00000000-0000-0000-0000-000000000001'::uuid,'automation',
    p_model_version,p_prompt_version,p_source_deployment,v_job.evaluation_fingerprint
  )
  RETURNING id INTO v_attempt;

  RETURN jsonb_build_object('result','initiated','attempt_id',v_attempt);
END
$$;

REVOKE ALL ON FUNCTION public.ce_automation_initiate_local_v1(
  uuid,text,text,text,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_automation_initiate_local_v1(
  uuid,text,text,text,text,text,text
) TO service_role;

CREATE OR REPLACE FUNCTION public.ce_automation_initiate_canonical_v1(
  p_job_id uuid,
  p_contract_version text,
  p_input_snapshot_hash text,
  p_bundle_hash text,
  p_kb_snapshot_id text,
  p_policy_snapshot_id text,
  p_grounding_manifest jsonb,
  p_model_version text,
  p_prompt_version text,
  p_source_deployment text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.ce_evaluation_job;
  v_company uuid;
  v_attempt uuid;
  v_eval uuid;
  v_running integer;
BEGIN
  SELECT * INTO v_job
  FROM public.ce_evaluation_job
  WHERE id=p_job_id AND status='running'
  FOR UPDATE;
  IF v_job.id IS NULL THEN RETURN jsonb_build_object('result','job_not_running'); END IF;

  v_company := public.ce_runtime_conversation_company(v_job.conversation_id);
  IF v_company IS NULL OR v_job.company_id IS DISTINCT FROM v_company THEN
    RETURN jsonb_build_object('result','tenant_mismatch');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_job.conversation_id::text,0));

  SELECT e.id INTO v_eval
  FROM public.conversation_evaluation e
  WHERE e.conversation_id=v_job.conversation_id
    AND e.input_snapshot_hash=p_input_snapshot_hash
    AND e.evaluation_fingerprint=v_job.evaluation_fingerprint
  ORDER BY e.created_at DESC
  LIMIT 1;
  IF v_eval IS NOT NULL THEN
    RETURN jsonb_build_object('result','already_evaluated','evaluation_id',v_eval);
  END IF;

  SELECT count(*) INTO v_running
  FROM public.conversation_evaluation_attempt
  WHERE conversation_id=v_job.conversation_id AND status='running';
  IF v_running>0 THEN RETURN jsonb_build_object('result','already_in_progress'); END IF;

  INSERT INTO public.conversation_evaluation_attempt(
    conversation_id,evaluation_contract_version,input_snapshot_hash,status,
    pipeline_run_id,initiated_by,initiated_by_kind,kb_snapshot_id,
    policy_snapshot_id,model_version,prompt_version,source_deployment,
    bundle_hash,grounding_manifest,company_id,evaluation_fingerprint
  ) VALUES (
    v_job.conversation_id,p_contract_version,p_input_snapshot_hash,'running',
    gen_random_uuid(),'00000000-0000-0000-0000-000000000001'::uuid,'automation',
    p_kb_snapshot_id,p_policy_snapshot_id,p_model_version,p_prompt_version,
    p_source_deployment,p_bundle_hash,p_grounding_manifest,v_company,
    v_job.evaluation_fingerprint
  )
  RETURNING id INTO v_attempt;

  RETURN jsonb_build_object('result','initiated','attempt_id',v_attempt);
END
$$;

REVOKE ALL ON FUNCTION public.ce_automation_initiate_canonical_v1(
  uuid,text,text,text,text,text,jsonb,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_automation_initiate_canonical_v1(
  uuid,text,text,text,text,text,jsonb,text,text,text
) TO service_role;

-- Copy attempt fingerprint into newly inserted evaluation rows, including
-- existing manual completion RPCs when their attempt carries one.
CREATE OR REPLACE FUNCTION public.ce_copy_evaluation_fingerprint_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.evaluation_fingerprint IS NULL THEN
    IF TG_TABLE_NAME='conversation_evaluation' THEN
      SELECT a.evaluation_fingerprint INTO NEW.evaluation_fingerprint
      FROM public.conversation_evaluation_attempt a
      WHERE a.id=NEW.attempt_id;
    ELSE
      SELECT a.evaluation_fingerprint INTO NEW.evaluation_fingerprint
      FROM public.ce_local_evaluation_attempt a
      WHERE a.id=NEW.attempt_id;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_ce_copy_fingerprint_canonical ON public.conversation_evaluation;
CREATE TRIGGER trg_ce_copy_fingerprint_canonical
BEFORE INSERT ON public.conversation_evaluation
FOR EACH ROW EXECUTE FUNCTION public.ce_copy_evaluation_fingerprint_v1();

DROP TRIGGER IF EXISTS trg_ce_copy_fingerprint_local ON public.ce_local_evaluation;
CREATE TRIGGER trg_ce_copy_fingerprint_local
BEFORE INSERT ON public.ce_local_evaluation
FOR EACH ROW EXECUTE FUNCTION public.ce_copy_evaluation_fingerprint_v1();

-- ---------------------------------------------------------------------------
-- Worker auth + Vault + scheduler activation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_verify_worker_token_v1(
  p_token text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    r.enabled
    AND r.worker_token_hash IS NOT NULL
    AND r.worker_token_hash =
      encode(extensions.digest(convert_to(COALESCE(p_token,''),'UTF8'),'sha256'),'hex')
  FROM public.ce_automation_runtime r
  WHERE r.singleton=true
$$;

REVOKE ALL ON FUNCTION public.ce_verify_worker_token_v1(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_verify_worker_token_v1(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ce_scheduler_http_tick_v1()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cfg public.ce_automation_runtime;
  v_token text;
  v_request_id bigint;
BEGIN
  SELECT * INTO v_cfg
  FROM public.ce_automation_runtime
  WHERE singleton=true;

  IF NOT COALESCE(v_cfg.enabled,false)
     OR NULLIF(trim(COALESCE(v_cfg.worker_url,'')),'') IS NULL
     OR v_cfg.worker_secret_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ds.decrypted_secret INTO v_token
  FROM vault.decrypted_secrets ds
  WHERE ds.id=v_cfg.worker_secret_id;

  IF NULLIF(COALESCE(v_token,''),'') IS NULL THEN RETURN NULL; END IF;

  SELECT net.http_post(
    url := v_cfg.worker_url,
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'X-CE-Worker-Token',v_token
    ),
    body := '{"source":"cron"}'::jsonb,
    timeout_milliseconds := 5000
  ) INTO v_request_id;

  RETURN v_request_id;
END
$$;

REVOKE ALL ON FUNCTION public.ce_scheduler_http_tick_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_scheduler_http_tick_v1()
  TO service_role;

CREATE OR REPLACE FUNCTION public.ce_activate_scheduler_v1(
  p_worker_url text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_token text;
  v_hash text;
  v_secret_id uuid;
BEGIN
  IF p_worker_url !~ '^https://[A-Za-z0-9.-]+/functions/v1/ce-evaluation-worker$' THEN
    RETURN jsonb_build_object('result','invalid_worker_url');
  END IF;

  v_token := encode(extensions.gen_random_bytes(32),'hex');
  v_hash := encode(
    extensions.digest(convert_to(v_token,'UTF8'),'sha256'),
    'hex'
  );

  SELECT worker_secret_id INTO v_secret_id
  FROM public.ce_automation_runtime
  WHERE singleton=true
  FOR UPDATE;

  IF v_secret_id IS NULL THEN
    v_secret_id := vault.create_secret(
      v_token,
      'ce_worker_token',
      'PR29 Task 2 CE scheduler worker token',
      NULL
    );
  ELSE
    PERFORM vault.update_secret(
      v_secret_id,
      v_token,
      'ce_worker_token',
      'PR29 Task 2 CE scheduler worker token',
      NULL
    );
  END IF;

  UPDATE public.ce_automation_runtime
  SET
    enabled=true,
    worker_url=p_worker_url,
    worker_secret_id=v_secret_id,
    worker_token_hash=v_hash,
    updated_at=now()
  WHERE singleton=true;

  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname='ce-evaluation-worker-minute';

  PERFORM cron.schedule(
    'ce-evaluation-worker-minute',
    '* * * * *',
    'select public.ce_scheduler_http_tick_v1();'
  );

  RETURN jsonb_build_object('result','success','enabled',true);
END
$$;

REVOKE ALL ON FUNCTION public.ce_activate_scheduler_v1(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_activate_scheduler_v1(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ce_deactivate_scheduler_v1()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname='ce-evaluation-worker-minute';

  UPDATE public.ce_automation_runtime
  SET enabled=false, updated_at=now()
  WHERE singleton=true;

  RETURN jsonb_build_object('result','success','enabled',false);
END
$$;

REVOKE ALL ON FUNCTION public.ce_deactivate_scheduler_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_deactivate_scheduler_v1()
  TO service_role;