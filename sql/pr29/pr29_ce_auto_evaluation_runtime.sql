-- PR29 Task 2 — Automatic CE runtime + scheduler + fair-share queue.
-- SOURCE PACKAGE ONLY. Apply to production Supabase only after GitHub source commit.
--
-- Frozen policy:
--   background debounce       10 minutes
--   active max-age ceiling   120 minutes
--   background sweep         60 minutes
--   cron worker tick          1 minute
--   global concurrency        3
--   per-company concurrency   1
--   CE row dwell              3 seconds (frontend)
--   methodology activation does NOT automatically backfill unchanged history

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Runtime policy/config
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ce_automation_runtime (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  worker_url text,
  worker_secret_id uuid,
  worker_token_hash text CHECK (worker_token_hash IS NULL OR worker_token_hash ~ '^[0-9a-f]{64}$'),
  debounce_minutes integer NOT NULL DEFAULT 10 CHECK (debounce_minutes BETWEEN 1 AND 120),
  max_age_minutes integer NOT NULL DEFAULT 120 CHECK (max_age_minutes BETWEEN 30 AND 1440),
  background_sweep_minutes integer NOT NULL DEFAULT 60 CHECK (background_sweep_minutes BETWEEN 5 AND 1440),
  global_concurrency integer NOT NULL DEFAULT 3 CHECK (global_concurrency BETWEEN 1 AND 20),
  per_company_concurrency integer NOT NULL DEFAULT 1 CHECK (per_company_concurrency BETWEEN 1 AND 10),
  enqueue_batch_limit integer NOT NULL DEFAULT 100 CHECK (enqueue_batch_limit BETWEEN 1 AND 1000),
  last_background_sweep_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ce_automation_runtime(singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.ce_automation_runtime ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ce_automation_runtime FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ce_automation_runtime TO service_role;

-- ---------------------------------------------------------------------------
-- Attempt provenance + fingerprint-aware uniqueness.
-- Legacy history is retained; no rows are deleted.
-- ---------------------------------------------------------------------------
ALTER TABLE public.conversation_evaluation_attempt
  ADD COLUMN IF NOT EXISTS initiated_by_kind text NOT NULL DEFAULT 'user'
  CHECK (initiated_by_kind IN ('user','automation'));
ALTER TABLE public.ce_local_evaluation_attempt
  ADD COLUMN IF NOT EXISTS initiated_by_kind text NOT NULL DEFAULT 'user'
  CHECK (initiated_by_kind IN ('user','automation'));

ALTER TABLE public.conversation_evaluation_attempt
  ADD COLUMN IF NOT EXISTS evaluation_fingerprint text;
ALTER TABLE public.ce_local_evaluation_attempt
  ADD COLUMN IF NOT EXISTS evaluation_fingerprint text;

ALTER TABLE public.conversation_evaluation
  ADD COLUMN IF NOT EXISTS evaluation_fingerprint text;
ALTER TABLE public.ce_local_evaluation
  ADD COLUMN IF NOT EXISTS evaluation_fingerprint text;

-- Local old uniqueness prevented same snapshot from being evaluated under a new methodology.
ALTER TABLE public.ce_local_evaluation_attempt
  DROP CONSTRAINT IF EXISTS ce_local_evaluation_attempt_conversation_id_input_snapshot__key;

CREATE UNIQUE INDEX IF NOT EXISTS ce_local_attempt_snapshot_fingerprint_uidx
  ON public.ce_local_evaluation_attempt(
    conversation_id,
    input_snapshot_hash,
    evaluation_fingerprint
  )
  WHERE evaluation_fingerprint IS NOT NULL;

-- Canonical evaluation old uniqueness omitted methodology fingerprint.
ALTER TABLE public.conversation_evaluation
  DROP CONSTRAINT IF EXISTS conversation_evaluation_conversation_id_evaluation_contract_key;

CREATE UNIQUE INDEX IF NOT EXISTS ce_canonical_snapshot_fingerprint_uidx
  ON public.conversation_evaluation(
    conversation_id,
    evaluation_contract_version,
    input_snapshot_hash,
    evaluation_fingerprint
  )
  WHERE evaluation_fingerprint IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Trigger snapshot. This is the queue/idempotency content fingerprint.
-- It intentionally includes recalled/verified state so any evaluation-relevant
-- transition changes the hash. The evaluator's own input_snapshot_hash remains
-- separately persisted for audit/replay.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_trigger_snapshot_hash_v1(
  p_conversation_id uuid
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT encode(
    extensions.digest(
      convert_to(
        COALESCE(
          string_agg(
            m.id::text || '|' ||
            lower(COALESCE(m.role,'')) || '|' ||
            COALESCE(m.content,'') || '|' ||
            COALESCE(m.is_recalled,false)::text || '|' ||
            COALESCE(m.sender_id::text,'') || '|' ||
            COALESCE(m.sender_identity_verified_at::text,''),
            E'\n'
            ORDER BY m.created_at, m.id
          ),
          ''
        ) || E'\n',
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
  FROM public.messages m
  WHERE m.conversation_id = p_conversation_id
    AND COALESCE(m.content,'') IS DISTINCT FROM '__THINKING__'
$$;

REVOKE ALL ON FUNCTION public.ce_trigger_snapshot_hash_v1(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_trigger_snapshot_hash_v1(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ce_conversation_evaluable_v1(
  p_conversation_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    count(*) FILTER (
      WHERE NOT COALESCE(m.is_recalled,false)
        AND lower(m.role) IN ('visitor','customer','user')
    ) > 0
    AND
    count(*) FILTER (
      WHERE NOT COALESCE(m.is_recalled,false)
        AND lower(m.role) IN ('assistant','ai','bot')
    ) > 0
  FROM public.messages m
  WHERE m.conversation_id = p_conversation_id
    AND COALESCE(m.content,'') IS DISTINCT FROM '__THINKING__'
$$;

REVOKE ALL ON FUNCTION public.ce_conversation_evaluable_v1(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_conversation_evaluable_v1(uuid)
  TO service_role;

-- Align Task 1 bootstrap states to the queue trigger hash without calling LLM.
UPDATE public.ce_evaluation_state s
SET
  current_snapshot_hash = public.ce_trigger_snapshot_hash_v1(s.conversation_id),
  last_success_snapshot_hash = CASE
    WHEN s.state = 'up_to_date'
      THEN public.ce_trigger_snapshot_hash_v1(s.conversation_id)
    ELSE s.last_success_snapshot_hash
  END,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- Enqueue current snapshot. Same snapshot + same methodology is a no-op.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_enqueue_current_snapshot_v1(
  p_conversation_id uuid,
  p_source text,
  p_available_at timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state public.ce_evaluation_state;
  v_hash text;
  v_fingerprint text;
  v_result jsonb;
BEGIN
  IF p_source NOT IN (
    'scheduler','ce_dwell','resolved','verified_correction','manual','max_age'
  ) THEN
    RETURN jsonb_build_object('result','invalid_source');
  END IF;

  IF NOT public.ce_conversation_evaluable_v1(p_conversation_id) THEN
    RETURN jsonb_build_object('result','conversation_not_evaluable');
  END IF;

  v_fingerprint := public.ce_current_evaluation_fingerprint();
  IF v_fingerprint IS NULL THEN
    RETURN jsonb_build_object('result','methodology_not_configured');
  END IF;

  SELECT * INTO v_state
  FROM public.ce_evaluation_state
  WHERE conversation_id = p_conversation_id
  FOR UPDATE;

  IF v_state.conversation_id IS NULL THEN
    RETURN jsonb_build_object('result','state_not_initialized');
  END IF;

  v_hash := public.ce_trigger_snapshot_hash_v1(p_conversation_id);

  IF v_state.last_success_snapshot_hash IS NOT DISTINCT FROM v_hash
     AND v_state.last_success_fingerprint IS NOT DISTINCT FROM v_fingerprint
     AND v_state.state = 'up_to_date' THEN
    RETURN jsonb_build_object(
      'result','up_to_date',
      'snapshot_hash',v_hash,
      'evaluation_fingerprint',v_fingerprint
    );
  END IF;

  v_result := public.ce_enqueue_evaluation_v1(
    p_conversation_id,
    v_hash,
    v_fingerprint,
    v_state.revision,
    p_source,
    COALESCE(p_available_at,now())
  );

  RETURN v_result || jsonb_build_object(
    'snapshot_hash',v_hash,
    'evaluation_fingerprint',v_fingerprint,
    'expected_revision',v_state.revision
  );
END
$$;

REVOKE ALL ON FUNCTION public.ce_enqueue_current_snapshot_v1(uuid,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_enqueue_current_snapshot_v1(uuid,text,timestamptz)
  TO service_role;

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

COMMIT;
