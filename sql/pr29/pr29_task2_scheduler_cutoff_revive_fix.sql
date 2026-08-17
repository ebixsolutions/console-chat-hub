-- PR29 Task 2 corrective migration:
-- 1) prevent automatic historical backlog evaluation after automation activation
-- 2) allow interactive/manual paths to revive cancelled/failed same-snapshot jobs
--
-- Production safety:
-- - does not enqueue any job
-- - does not call Vertex
-- - does not reactivate scheduler
-- - automation remains disabled until ce_activate_scheduler_v1 is explicitly called

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.ce_automation_runtime
  ADD COLUMN IF NOT EXISTS automation_started_at timestamptz;

-- Freeze the initial automation horizon now. Existing historical state before
-- this timestamp is not eligible for background sweep unless a later
-- evaluation-relevant change moves dirty_since/last_activity_at beyond it.
UPDATE public.ce_automation_runtime
SET automation_started_at = COALESCE(automation_started_at, now()),
    updated_at = now()
WHERE singleton = true
  AND automation_started_at IS NULL;

-- ---------------------------------------------------------------------------
-- Idempotent enqueue with controlled revive.
-- A cancelled/failed job for the same snapshot+fingerprint must not permanently
-- block CE dwell/manual/resolved/verified-correction. Background scheduler does
-- not revive terminal jobs automatically.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_enqueue_evaluation_v1(
  p_conversation_id uuid,
  p_snapshot_hash text,
  p_evaluation_fingerprint text,
  p_expected_revision bigint,
  p_source text,
  p_available_at timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_company uuid;
  v_state public.ce_evaluation_state;
  v_job public.ce_evaluation_job;
  v_job_id uuid;
  v_job_key text;
  v_priority integer;
  v_current_fingerprint text;
  v_interactive boolean;
BEGIN
  IF p_conversation_id IS NULL
     OR NULLIF(trim(COALESCE(p_snapshot_hash,'')), '') IS NULL
     OR COALESCE(p_evaluation_fingerprint,'') !~ '^[0-9a-f]{64}$'
     OR p_expected_revision IS NULL
     OR p_expected_revision < 0
     OR p_source NOT IN (
       'scheduler','ce_dwell','resolved','verified_correction','manual','max_age'
     ) THEN
    RETURN jsonb_build_object('result','invalid_input');
  END IF;

  v_current_fingerprint := public.ce_current_evaluation_fingerprint();
  IF v_current_fingerprint IS NULL THEN
    RETURN jsonb_build_object('result','methodology_not_configured');
  END IF;
  IF p_evaluation_fingerprint IS DISTINCT FROM v_current_fingerprint THEN
    RETURN jsonb_build_object('result','fingerprint_not_current');
  END IF;

  SELECT * INTO v_state
  FROM public.ce_evaluation_state
  WHERE conversation_id = p_conversation_id
  FOR UPDATE;

  IF v_state.conversation_id IS NULL THEN
    RETURN jsonb_build_object('result','state_not_initialized');
  END IF;
  IF v_state.revision IS DISTINCT FROM p_expected_revision THEN
    RETURN jsonb_build_object(
      'result','stale_revision',
      'current_revision',v_state.revision
    );
  END IF;

  v_company := public.ce_runtime_conversation_company(p_conversation_id);
  v_priority := CASE p_source
    WHEN 'manual' THEN 100
    WHEN 'verified_correction' THEN 90
    WHEN 'resolved' THEN 80
    WHEN 'ce_dwell' THEN 70
    WHEN 'max_age' THEN 60
    ELSE 50
  END;
  v_interactive := p_source IN (
    'manual','ce_dwell','resolved','verified_correction'
  );

  v_job_key := encode(
    extensions.digest(
      convert_to(
        p_conversation_id::text || '|' ||
        p_snapshot_hash || '|' ||
        p_evaluation_fingerprint,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.ce_evaluation_job (
    job_key,
    conversation_id,
    company_id,
    snapshot_hash,
    evaluation_fingerprint,
    expected_revision,
    source,
    priority,
    status,
    available_at,
    updated_at
  ) VALUES (
    v_job_key,
    p_conversation_id,
    v_company,
    p_snapshot_hash,
    p_evaluation_fingerprint,
    p_expected_revision,
    p_source,
    v_priority,
    'queued',
    COALESCE(p_available_at, now()),
    now()
  )
  ON CONFLICT (job_key) DO NOTHING
  RETURNING id INTO v_job_id;

  IF v_job_id IS NULL THEN
    SELECT * INTO v_job
    FROM public.ce_evaluation_job
    WHERE job_key = v_job_key
    FOR UPDATE;

    IF v_job.id IS NULL THEN
      RETURN jsonb_build_object('result','job_lookup_failed');
    END IF;

    IF v_interactive AND v_job.status IN ('cancelled','failed') THEN
      UPDATE public.ce_evaluation_job
      SET
        company_id = v_company,
        expected_revision = p_expected_revision,
        source = p_source,
        priority = v_priority,
        status = 'queued',
        available_at = COALESCE(p_available_at, now()),
        attempts = 0,
        lease_owner = NULL,
        lease_expires_at = NULL,
        started_at = NULL,
        finished_at = NULL,
        error_code = NULL,
        updated_at = now()
      WHERE id = v_job.id
      RETURNING id INTO v_job_id;
    ELSE
      RETURN jsonb_build_object(
        'result',
        CASE
          WHEN v_job.status = 'succeeded' THEN 'already_succeeded'
          WHEN v_job.status = 'running' THEN 'already_running'
          WHEN v_job.status = 'queued' THEN 'already_queued'
          ELSE 'terminal_job'
        END,
        'job_id',v_job.id,
        'job_key',v_job_key,
        'job_status',v_job.status
      );
    END IF;
  END IF;

  UPDATE public.ce_evaluation_state
  SET
    state = 'queued',
    company_id = v_company,
    current_snapshot_hash = p_snapshot_hash,
    current_evaluation_fingerprint = p_evaluation_fingerprint,
    queued_at = now(),
    last_error_code = NULL,
    updated_at = now()
  WHERE conversation_id = p_conversation_id
    AND revision = p_expected_revision;

  RETURN jsonb_build_object(
    'result','queued',
    'job_id',v_job_id,
    'job_key',v_job_key,
    'priority',v_priority
  );
END
$$;

REVOKE ALL ON FUNCTION public.ce_enqueue_evaluation_v1(
  uuid,text,text,bigint,text,timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_enqueue_evaluation_v1(
  uuid,text,text,bigint,text,timestamptz
) TO service_role;

-- ---------------------------------------------------------------------------
-- Background eligibility cutoff.
-- Historical never_evaluated / historical dirty state before automation_started_at
-- is excluded from hourly background sweep. Interactive/manual enqueue remains
-- available and bypasses this scheduler-only eligibility filter.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_scheduler_enqueue_due_v1()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cfg public.ce_automation_runtime;
  v_row record;
  v_enqueued integer := 0;
  v_seen integer := 0;
  v_source text;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ce-background-sweep',0));

  SELECT * INTO v_cfg
  FROM public.ce_automation_runtime
  WHERE singleton = true
  FOR UPDATE;

  IF NOT COALESCE(v_cfg.enabled,false) THEN
    RETURN jsonb_build_object('result','disabled','enqueued',0);
  END IF;

  IF v_cfg.automation_started_at IS NULL THEN
    RETURN jsonb_build_object('result','activation_cutoff_missing','enqueued',0);
  END IF;

  IF v_cfg.last_background_sweep_at IS NOT NULL
     AND v_cfg.last_background_sweep_at >
       now() - make_interval(mins => v_cfg.background_sweep_minutes) THEN
    RETURN jsonb_build_object('result','not_due','enqueued',0);
  END IF;

  UPDATE public.ce_automation_runtime
  SET last_background_sweep_at = now(), updated_at = now()
  WHERE singleton = true;

  FOR v_row IN
    SELECT s.*
    FROM public.ce_evaluation_state s
    WHERE s.state IN ('never_evaluated','dirty','failed','stale_version')
      AND public.ce_conversation_evaluable_v1(s.conversation_id)
      -- Hard activation horizon: background automation must only consume
      -- evaluation-relevant activity that happened after automation began.
      AND COALESCE(s.dirty_since,s.last_activity_at) >= v_cfg.automation_started_at
      AND (
        s.last_activity_at <= now() - make_interval(mins => v_cfg.debounce_minutes)
        OR (
          s.last_success_at IS NOT NULL
          AND s.last_success_at <= now() - make_interval(mins => v_cfg.max_age_minutes)
        )
      )
    ORDER BY
      COALESCE(s.last_success_at,'epoch'::timestamptz) ASC,
      COALESCE(s.dirty_since,s.last_activity_at) ASC,
      s.conversation_id
    LIMIT v_cfg.enqueue_batch_limit
  LOOP
    v_seen := v_seen + 1;
    v_source := CASE
      WHEN v_row.last_success_at IS NOT NULL
       AND v_row.last_success_at <= now() - make_interval(mins => v_cfg.max_age_minutes)
      THEN 'max_age'
      ELSE 'scheduler'
    END;

    v_result := public.ce_enqueue_current_snapshot_v1(
      v_row.conversation_id,
      v_source,
      now()
    );
    IF COALESCE(v_result->>'result','') = 'queued' THEN
      v_enqueued := v_enqueued + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'result','success',
    'considered',v_seen,
    'enqueued',v_enqueued
  );
END
$$;

REVOKE ALL ON FUNCTION public.ce_scheduler_enqueue_due_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_scheduler_enqueue_due_v1()
  TO service_role;

-- Scheduler activation preserves the first activation horizon. Re-enable after
-- a temporary stop must not reset the cutoff or sweep old historical backlog.
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
    automation_started_at=COALESCE(automation_started_at,now()),
    last_background_sweep_at=NULL,
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

  RETURN jsonb_build_object(
    'result','success',
    'enabled',true,
    'automation_started_at',
      (SELECT automation_started_at FROM public.ce_automation_runtime WHERE singleton=true)
  );
END
$$;

REVOKE ALL ON FUNCTION public.ce_activate_scheduler_v1(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_activate_scheduler_v1(text)
  TO service_role;

COMMIT;
