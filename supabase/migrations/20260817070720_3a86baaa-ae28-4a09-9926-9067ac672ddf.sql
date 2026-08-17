SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- Priority triggers: resolved and verified human correction.
-- These only enqueue. Worker execution is bounded by the queue concurrency gate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_resolved_priority_trigger_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (
    NEW.status IS DISTINCT FROM OLD.status
    AND lower(COALESCE(NEW.status,'')) = 'resolved'
  ) OR (
    NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
    AND NEW.resolved_at IS NOT NULL
  ) THEN
    PERFORM public.ce_mark_evaluation_dirty(NEW.id, now());
    PERFORM public.ce_enqueue_current_snapshot_v1(NEW.id, 'resolved', now());
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_ce_resolved_priority ON public.conversations;
CREATE TRIGGER trg_ce_resolved_priority
AFTER UPDATE OF status, resolved_at ON public.conversations
FOR EACH ROW EXECUTE FUNCTION public.ce_resolved_priority_trigger_v1();

CREATE OR REPLACE FUNCTION public.ce_verified_correction_priority_trigger_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_verified boolean;
  v_became_verified boolean;
BEGIN
  v_verified :=
    lower(COALESCE(NEW.role,'')) IN ('agent','human','human_agent','supervisor')
    AND NEW.sender_id IS NOT NULL
    AND NEW.sender_identity_verified_at IS NOT NULL
    AND NOT COALESCE(NEW.is_recalled,false)
    AND COALESCE(NEW.content,'') IS DISTINCT FROM '__THINKING__';

  v_became_verified := TG_OP = 'INSERT'
    OR OLD.sender_identity_verified_at IS DISTINCT FROM NEW.sender_identity_verified_at
    OR OLD.sender_id IS DISTINCT FROM NEW.sender_id
    OR OLD.content IS DISTINCT FROM NEW.content
    OR COALESCE(OLD.is_recalled,false) IS DISTINCT FROM COALESCE(NEW.is_recalled,false);

  IF v_verified AND v_became_verified THEN
    -- Task 1 dirty trigger is alphabetically earlier; refresh defensively only
    -- when it did not already make this state dirty.
    IF EXISTS (
      SELECT 1 FROM public.ce_evaluation_state s
      WHERE s.conversation_id = NEW.conversation_id
        AND s.state = 'up_to_date'
    ) THEN
      PERFORM public.ce_mark_evaluation_dirty(NEW.conversation_id, now());
    END IF;
    PERFORM public.ce_enqueue_current_snapshot_v1(
      NEW.conversation_id,
      'verified_correction',
      now()
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_zz_ce_verified_correction_priority ON public.messages;
CREATE TRIGGER trg_zz_ce_verified_correction_priority
AFTER INSERT OR UPDATE OF
  content,
  role,
  is_recalled,
  sender_id,
  sender_identity_verified_at
ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.ce_verified_correction_priority_trigger_v1();

-- ---------------------------------------------------------------------------
-- Hourly background sweep. The worker ticks every minute; this function itself
-- enqueues normal dirty conversations at most once per configured sweep interval.
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
      AND (
        s.last_activity_at <= now() - make_interval(mins => v_cfg.debounce_minutes)
        OR COALESCE(s.last_success_at,s.dirty_since,s.last_activity_at) <=
           now() - make_interval(mins => v_cfg.max_age_minutes)
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

-- ---------------------------------------------------------------------------
-- Fair-share claim. Claims are serialized by advisory lock, which makes global
-- and per-company concurrency assertions race-safe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_reap_expired_jobs_v1()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.ce_evaluation_job j
  SET
    status = CASE WHEN j.attempts >= j.max_attempts THEN 'failed' ELSE 'queued' END,
    available_at = CASE
      WHEN j.attempts >= j.max_attempts THEN j.available_at
      ELSE now() + make_interval(mins => LEAST(30, (2 ^ GREATEST(j.attempts,1))::integer))
    END,
    lease_owner = NULL,
    lease_expires_at = NULL,
    finished_at = CASE WHEN j.attempts >= j.max_attempts THEN now() ELSE NULL END,
    error_code = 'lease_expired',
    updated_at = now()
  WHERE j.status = 'running'
    AND j.lease_expires_at < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION public.ce_reap_expired_jobs_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_reap_expired_jobs_v1()
  TO service_role;

CREATE OR REPLACE FUNCTION public.ce_claim_evaluation_jobs_v1(
  p_worker_id text,
  p_limit integer DEFAULT 3
) RETURNS SETOF public.ce_evaluation_job
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cfg public.ce_automation_runtime;
  v_running integer;
  v_slots integer;
  v_ids uuid[];
BEGIN
  IF NULLIF(trim(COALESCE(p_worker_id,'')), '') IS NULL THEN RETURN; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ce-job-claim',0));
  PERFORM public.ce_reap_expired_jobs_v1();

  SELECT * INTO v_cfg
  FROM public.ce_automation_runtime
  WHERE singleton=true;

  IF NOT COALESCE(v_cfg.enabled,false) THEN RETURN; END IF;

  SELECT count(*) INTO v_running
  FROM public.ce_evaluation_job
  WHERE status='running';

  v_slots := LEAST(
    GREATEST(COALESCE(p_limit,1),1),
    GREATEST(v_cfg.global_concurrency - v_running,0)
  );
  IF v_slots <= 0 THEN RETURN; END IF;

  WITH running_buckets AS (
    SELECT
      COALESCE(company_id::text,'__preactivation__') bucket,
      count(*) n
    FROM public.ce_evaluation_job
    WHERE status='running'
    GROUP BY 1
  ),
  ranked AS (
    SELECT
      j.id,
      COALESCE(j.company_id::text,'__preactivation__') bucket,
      row_number() OVER (
        PARTITION BY COALESCE(j.company_id::text,'__preactivation__')
        ORDER BY j.priority DESC, j.available_at, j.created_at, j.id
      ) rn,
      j.priority,
      j.available_at,
      j.created_at
    FROM public.ce_evaluation_job j
    LEFT JOIN running_buckets rb
      ON rb.bucket = COALESCE(j.company_id::text,'__preactivation__')
    WHERE j.status='queued'
      AND j.available_at <= now()
      AND COALESCE(rb.n,0) < v_cfg.per_company_concurrency
  )
  SELECT array_agg(id ORDER BY priority DESC, available_at, created_at, id)
  INTO v_ids
  FROM (
    SELECT *
    FROM ranked
    WHERE rn <= v_cfg.per_company_concurrency
    ORDER BY priority DESC, available_at, created_at, id
    LIMIT v_slots
  ) q;

  IF v_ids IS NULL OR cardinality(v_ids)=0 THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.ce_evaluation_job j
  SET
    status='running',
    lease_owner=p_worker_id,
    lease_expires_at=now()+interval '10 minutes',
    started_at=COALESCE(j.started_at,now()),
    attempts=j.attempts+1,
    error_code=NULL,
    updated_at=now()
  WHERE j.id=ANY(v_ids)
    AND j.status='queued'
  RETURNING j.*;
END
$$;

REVOKE ALL ON FUNCTION public.ce_claim_evaluation_jobs_v1(text,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_claim_evaluation_jobs_v1(text,integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ce_claim_specific_job_v1(
  p_job_id uuid,
  p_worker_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cfg public.ce_automation_runtime;
  v_job public.ce_evaluation_job;
  v_global integer;
  v_bucket_running integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ce-job-claim',0));
  PERFORM public.ce_reap_expired_jobs_v1();

  SELECT * INTO v_cfg FROM public.ce_automation_runtime WHERE singleton=true;
  IF NOT COALESCE(v_cfg.enabled,false) THEN
    RETURN jsonb_build_object('result','disabled');
  END IF;

  SELECT * INTO v_job
  FROM public.ce_evaluation_job
  WHERE id=p_job_id
  FOR UPDATE;

  IF v_job.id IS NULL THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF v_job.status='running' THEN
    RETURN jsonb_build_object('result','already_running','job_id',v_job.id);
  END IF;
  IF v_job.status<>'queued' OR v_job.available_at>now() THEN
    RETURN jsonb_build_object('result','not_claimable','status',v_job.status);
  END IF;

  SELECT count(*) INTO v_global
  FROM public.ce_evaluation_job WHERE status='running';
  IF v_global >= v_cfg.global_concurrency THEN
    RETURN jsonb_build_object('result','global_busy');
  END IF;

  SELECT count(*) INTO v_bucket_running
  FROM public.ce_evaluation_job j
  WHERE j.status='running'
    AND COALESCE(j.company_id::text,'__preactivation__') =
        COALESCE(v_job.company_id::text,'__preactivation__');
  IF v_bucket_running >= v_cfg.per_company_concurrency THEN
    RETURN jsonb_build_object('result','company_busy');
  END IF;

  UPDATE public.ce_evaluation_job
  SET
    status='running',
    lease_owner=p_worker_id,
    lease_expires_at=now()+interval '10 minutes',
    started_at=COALESCE(started_at,now()),
    attempts=attempts+1,
    error_code=NULL,
    updated_at=now()
  WHERE id=p_job_id;

  RETURN jsonb_build_object('result','claimed','job_id',p_job_id);
END
$$;

REVOKE ALL ON FUNCTION public.ce_claim_specific_job_v1(uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_claim_specific_job_v1(uuid,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ce_complete_job_v1(
  p_job_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.ce_evaluation_job
  SET status='succeeded',
      lease_owner=NULL,
      lease_expires_at=NULL,
      finished_at=now(),
      error_code=NULL,
      updated_at=now()
  WHERE id=p_job_id AND status='running';

  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_running'); END IF;
  RETURN jsonb_build_object('result','success');
END
$$;

REVOKE ALL ON FUNCTION public.ce_complete_job_v1(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_complete_job_v1(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ce_fail_job_v1(
  p_job_id uuid,
  p_error_code text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.ce_evaluation_job;
BEGIN
  SELECT * INTO v_job
  FROM public.ce_evaluation_job
  WHERE id=p_job_id
  FOR UPDATE;

  IF v_job.id IS NULL THEN RETURN jsonb_build_object('result','not_found'); END IF;

  UPDATE public.ce_evaluation_job
  SET
    status=CASE WHEN v_job.attempts>=v_job.max_attempts THEN 'failed' ELSE 'queued' END,
    available_at=CASE
      WHEN v_job.attempts>=v_job.max_attempts THEN available_at
      ELSE now()+make_interval(mins=>LEAST(30,(2 ^ GREATEST(v_job.attempts,1))::integer))
    END,
    lease_owner=NULL,
    lease_expires_at=NULL,
    finished_at=CASE WHEN v_job.attempts>=v_job.max_attempts THEN now() ELSE NULL END,
    error_code=left(COALESCE(p_error_code,'unknown'),120),
    updated_at=now()
  WHERE id=p_job_id;

  UPDATE public.ce_evaluation_state
  SET
    state=CASE
      WHEN v_job.attempts>=v_job.max_attempts THEN 'failed'
      ELSE 'dirty'
    END,
    last_error_code=left(COALESCE(p_error_code,'unknown'),120),
    queued_at=NULL,
    evaluating_started_at=NULL,
    updated_at=now()
  WHERE conversation_id=v_job.conversation_id
    AND revision=v_job.expected_revision;

  RETURN jsonb_build_object(
    'result',CASE WHEN v_job.attempts>=v_job.max_attempts THEN 'failed' ELSE 'retry_queued' END
  );
END
$$;

REVOKE ALL ON FUNCTION public.ce_fail_job_v1(uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_fail_job_v1(uuid,text)
  TO service_role;