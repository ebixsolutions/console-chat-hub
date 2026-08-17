-- PR29 Task 1 — Conversation Evaluation freshness + idempotent queue foundation
-- SOURCE PACKAGE ONLY. Applying this file to production Supabase requires separate Director authorization.
-- Canonical owner: AI Chatbot. SU CoachAI remains downstream.
--
-- Frozen architecture implemented here:
--   * evaluation-relevant message allowlist marks a conversation dirty
--   * monotonically increasing revision protects against in-flight races
--   * deterministic job key = SHA256(conversation_id + snapshot_hash + evaluation_fingerprint)
--   * evaluation_fingerprint is composite:
--       contract_version + prompt_hash + scoring_config_hash + evaluator_schema_hash
--   * methodology activation does NOT automatically queue/backfill old conversations
--   * completed evaluations remain audit history; freshness is current|superseded
--   * source/tenant are server-derived; no caller-supplied company scope
--
-- Task 2 will add scheduler/debounce/dwell/fair-share worker and CE UI refresh.
-- Task 3 will add SU CoachAI delta API + frozen training-consumption gate.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Evaluation methodology: platform single source of truth.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ce_evaluation_methodology (
  evaluation_fingerprint text PRIMARY KEY
    CHECK (evaluation_fingerprint ~ '^[0-9a-f]{64}$'),
  evaluation_contract_version text NOT NULL CHECK (length(trim(evaluation_contract_version)) > 0),
  evaluator_prompt_version text NOT NULL CHECK (length(trim(evaluator_prompt_version)) > 0),
  prompt_hash text NOT NULL CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  scoring_config_hash text NOT NULL CHECK (scoring_config_hash ~ '^[0-9a-f]{64}$'),
  evaluator_schema_hash text NOT NULL CHECK (evaluator_schema_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('candidate','current','retired')),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ce_evaluation_methodology_one_current_idx
  ON public.ce_evaluation_methodology ((status))
  WHERE status = 'current';

ALTER TABLE public.ce_evaluation_methodology ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ce_evaluation_methodology FROM PUBLIC, anon;
GRANT SELECT ON public.ce_evaluation_methodology TO authenticated;
GRANT ALL ON public.ce_evaluation_methodology TO service_role;

DROP POLICY IF EXISTS ce_evaluation_methodology_staff_read ON public.ce_evaluation_methodology;
CREATE POLICY ce_evaluation_methodology_staff_read
  ON public.ce_evaluation_methodology
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. Per-conversation freshness state.
-- company_id is server-derived. NULL is allowed only for existing conversation-
-- local/pre-activation records where canonical company identity is not yet bound.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ce_evaluation_state (
  conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  company_id uuid NULL,
  state text NOT NULL DEFAULT 'never_evaluated'
    CHECK (state IN (
      'never_evaluated',
      'up_to_date',
      'dirty',
      'queued',
      'evaluating',
      'failed',
      'stale_version'
    )),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  current_snapshot_hash text,
  current_evaluation_fingerprint text,
  last_success_evaluation_id uuid,
  last_success_source text
    CHECK (last_success_source IS NULL OR last_success_source IN ('canonical','conversation_local')),
  last_success_snapshot_hash text,
  last_success_fingerprint text,
  last_success_at timestamptz,
  dirty_since timestamptz,
  last_activity_at timestamptz,
  queued_at timestamptz,
  evaluating_started_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ce_evaluation_state_company_state_idx
  ON public.ce_evaluation_state (company_id, state, last_activity_at);
CREATE INDEX IF NOT EXISTS ce_evaluation_state_dirty_idx
  ON public.ce_evaluation_state (dirty_since, last_activity_at)
  WHERE state IN ('never_evaluated','dirty','failed','stale_version');

ALTER TABLE public.ce_evaluation_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ce_evaluation_state FROM PUBLIC, anon;
GRANT SELECT ON public.ce_evaluation_state TO authenticated;
GRANT ALL ON public.ce_evaluation_state TO service_role;

DROP POLICY IF EXISTS ce_evaluation_state_staff_read ON public.ce_evaluation_state;
CREATE POLICY ce_evaluation_state_staff_read
  ON public.ce_evaluation_state
  FOR SELECT TO authenticated
  USING (
    public.is_staff(auth.uid())
    AND (
      company_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.company_membership cm
        WHERE cm.company_id = ce_evaluation_state.company_id
          AND cm.user_id = auth.uid()
          AND cm.is_active = true
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Idempotent evaluation jobs.
-- Internal queue rows are service-role only. Task 2 will implement claim/worker.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ce_evaluation_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key text NOT NULL UNIQUE CHECK (job_key ~ '^[0-9a-f]{64}$'),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  company_id uuid NULL,
  snapshot_hash text NOT NULL CHECK (length(trim(snapshot_hash)) > 0),
  evaluation_fingerprint text NOT NULL CHECK (evaluation_fingerprint ~ '^[0-9a-f]{64}$'),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  source text NOT NULL CHECK (source IN (
    'scheduler',
    'ce_dwell',
    'resolved',
    'verified_correction',
    'manual',
    'max_age'
  )),
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  lease_owner text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, snapshot_hash, evaluation_fingerprint)
);

CREATE INDEX IF NOT EXISTS ce_evaluation_job_ready_idx
  ON public.ce_evaluation_job (status, available_at, priority DESC, created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS ce_evaluation_job_company_running_idx
  ON public.ce_evaluation_job (company_id, status)
  WHERE status = 'running';

ALTER TABLE public.ce_evaluation_job ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ce_evaluation_job FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ce_evaluation_job TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Add additive provenance/freshness fields to canonical and local history.
-- Existing rows are retained. Legacy rows may have NULL fingerprint until they
-- are re-evaluated by the new methodology; no automatic LLM backfill occurs.
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.conversation_evaluation_attempt
  ADD COLUMN IF NOT EXISTS evaluation_fingerprint text;
ALTER TABLE IF EXISTS public.conversation_evaluation
  ADD COLUMN IF NOT EXISTS evaluation_fingerprint text;
ALTER TABLE IF EXISTS public.conversation_evaluation
  ADD COLUMN IF NOT EXISTS freshness text NOT NULL DEFAULT 'current';

ALTER TABLE IF EXISTS public.ce_local_evaluation_attempt
  ADD COLUMN IF NOT EXISTS evaluation_fingerprint text;
ALTER TABLE IF EXISTS public.ce_local_evaluation
  ADD COLUMN IF NOT EXISTS evaluation_fingerprint text;
ALTER TABLE IF EXISTS public.ce_local_evaluation
  ADD COLUMN IF NOT EXISTS freshness text NOT NULL DEFAULT 'current';

DO $$
BEGIN
  IF to_regclass('public.conversation_evaluation') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'conversation_evaluation_freshness_check'
         AND conrelid = 'public.conversation_evaluation'::regclass
     ) THEN
    ALTER TABLE public.conversation_evaluation
      ADD CONSTRAINT conversation_evaluation_freshness_check
      CHECK (freshness IN ('current','superseded'));
  END IF;

  IF to_regclass('public.ce_local_evaluation') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'ce_local_evaluation_freshness_check'
         AND conrelid = 'public.ce_local_evaluation'::regclass
     ) THEN
    ALTER TABLE public.ce_local_evaluation
      ADD CONSTRAINT ce_local_evaluation_freshness_check
      CHECK (freshness IN ('current','superseded'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS conversation_evaluation_current_idx
  ON public.conversation_evaluation (conversation_id, created_at DESC)
  WHERE freshness = 'current';
CREATE INDEX IF NOT EXISTS ce_local_evaluation_current_idx
  ON public.ce_local_evaluation (conversation_id, created_at DESC)
  WHERE freshness = 'current';

-- ---------------------------------------------------------------------------
-- 5. Server-derived company resolution.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_runtime_conversation_company(
  p_conversation_id uuid
) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(c.company_id, cc.company_id)
  FROM public.conversations c
  LEFT JOIN public.channel_config cc ON cc.id = c.channel_config_id
  WHERE c.id = p_conversation_id
$$;

REVOKE ALL ON FUNCTION public.ce_runtime_conversation_company(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_runtime_conversation_company(uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Dirty marking helper + explicit evaluation-relevant message allowlist.
-- Only content/role/recall/verified-human identity/conversation binding changes
-- affect evaluation freshness. Metadata/tag/assignment changes do not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_mark_evaluation_dirty(
  p_conversation_id uuid,
  p_activity_at timestamptz DEFAULT now()
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_company uuid;
BEGIN
  IF p_conversation_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversations c WHERE c.id = p_conversation_id
  ) THEN
    RETURN;
  END IF;

  v_company := public.ce_runtime_conversation_company(p_conversation_id);

  INSERT INTO public.ce_evaluation_state (
    conversation_id,
    company_id,
    state,
    revision,
    dirty_since,
    last_activity_at,
    updated_at
  ) VALUES (
    p_conversation_id,
    v_company,
    'never_evaluated',
    1,
    now(),
    COALESCE(p_activity_at, now()),
    now()
  )
  ON CONFLICT (conversation_id) DO UPDATE
  SET
    company_id = EXCLUDED.company_id,
    revision = public.ce_evaluation_state.revision + 1,
    state = CASE
      WHEN public.ce_evaluation_state.last_success_evaluation_id IS NULL
        THEN 'never_evaluated'
      ELSE 'dirty'
    END,
    dirty_since = COALESCE(public.ce_evaluation_state.dirty_since, now()),
    last_activity_at = GREATEST(
      COALESCE(public.ce_evaluation_state.last_activity_at, '-infinity'::timestamptz),
      COALESCE(EXCLUDED.last_activity_at, now())
    ),
    queued_at = NULL,
    evaluating_started_at = NULL,
    last_error_code = NULL,
    updated_at = now();
END
$$;

REVOKE ALL ON FUNCTION public.ce_mark_evaluation_dirty(uuid,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_mark_evaluation_dirty(uuid,timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ce_message_evaluation_dirty_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_relevant boolean := false;
  v_new_relevant boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_old_relevant := COALESCE(OLD.content, '') IS DISTINCT FROM '__THINKING__';
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_new_relevant := COALESCE(NEW.content, '') IS DISTINCT FROM '__THINKING__';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new_relevant THEN
      PERFORM public.ce_mark_evaluation_dirty(NEW.conversation_id, now());
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_old_relevant THEN
      PERFORM public.ce_mark_evaluation_dirty(OLD.conversation_id, now());
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE allowlist. Deliberately excludes metadata, tags, assignments, and
  -- other non-evaluation fields.
  IF (
       OLD.conversation_id IS DISTINCT FROM NEW.conversation_id
    OR OLD.content IS DISTINCT FROM NEW.content
    OR OLD.role IS DISTINCT FROM NEW.role
    OR COALESCE(OLD.is_recalled,false) IS DISTINCT FROM COALESCE(NEW.is_recalled,false)
    OR OLD.sender_id IS DISTINCT FROM NEW.sender_id
    OR OLD.sender_identity_verified_at IS DISTINCT FROM NEW.sender_identity_verified_at
  ) THEN
    IF v_old_relevant THEN
      PERFORM public.ce_mark_evaluation_dirty(OLD.conversation_id, now());
    END IF;
    IF v_new_relevant
       AND (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NOT v_old_relevant) THEN
      PERFORM public.ce_mark_evaluation_dirty(NEW.conversation_id, now());
    ELSIF v_new_relevant AND NEW.conversation_id IS NOT DISTINCT FROM OLD.conversation_id THEN
      -- Same conversation changed: touch exactly once.
      IF NOT v_old_relevant THEN
        NULL;
      ELSE
        -- old path already touched it
        NULL;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.ce_message_evaluation_dirty_trigger()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_message_evaluation_dirty_trigger()
  TO service_role;

DROP TRIGGER IF EXISTS trg_ce_message_evaluation_dirty ON public.messages;
CREATE TRIGGER trg_ce_message_evaluation_dirty
AFTER INSERT OR DELETE OR UPDATE OF
  conversation_id,
  content,
  role,
  is_recalled,
  sender_id,
  sender_identity_verified_at
ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.ce_message_evaluation_dirty_trigger();

-- ---------------------------------------------------------------------------
-- 7. Composite methodology activation.
-- This is the ONLY path that creates a current fingerprint. It never starts
-- evaluation jobs and defaults to NOT marking old evaluations stale.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_activate_evaluation_methodology_v1(
  p_contract_version text,
  p_prompt_version text,
  p_prompt_hash text,
  p_scoring_config_hash text,
  p_evaluator_schema_hash text,
  p_mark_existing_stale boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_fingerprint text;
BEGIN
  IF NULLIF(trim(COALESCE(p_contract_version,'')), '') IS NULL
     OR NULLIF(trim(COALESCE(p_prompt_version,'')), '') IS NULL
     OR COALESCE(p_prompt_hash,'') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_scoring_config_hash,'') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_evaluator_schema_hash,'') !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result','invalid_methodology');
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(
        p_contract_version || '|' ||
        p_prompt_hash || '|' ||
        p_scoring_config_hash || '|' ||
        p_evaluator_schema_hash,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ce-evaluation-methodology-current', 0)
  );

  UPDATE public.ce_evaluation_methodology
  SET status = 'retired', updated_at = now()
  WHERE status = 'current'
    AND evaluation_fingerprint <> v_fingerprint;

  INSERT INTO public.ce_evaluation_methodology (
    evaluation_fingerprint,
    evaluation_contract_version,
    evaluator_prompt_version,
    prompt_hash,
    scoring_config_hash,
    evaluator_schema_hash,
    status,
    activated_at,
    updated_at
  ) VALUES (
    v_fingerprint,
    trim(p_contract_version),
    trim(p_prompt_version),
    p_prompt_hash,
    p_scoring_config_hash,
    p_evaluator_schema_hash,
    'current',
    now(),
    now()
  )
  ON CONFLICT (evaluation_fingerprint) DO UPDATE
  SET
    evaluation_contract_version = EXCLUDED.evaluation_contract_version,
    evaluator_prompt_version = EXCLUDED.evaluator_prompt_version,
    prompt_hash = EXCLUDED.prompt_hash,
    scoring_config_hash = EXCLUDED.scoring_config_hash,
    evaluator_schema_hash = EXCLUDED.evaluator_schema_hash,
    status = 'current',
    activated_at = COALESCE(public.ce_evaluation_methodology.activated_at, now()),
    updated_at = now();

  -- Explicit policy only. This marks state but never enqueues or calls an LLM.
  IF p_mark_existing_stale THEN
    UPDATE public.ce_evaluation_state s
    SET
      state = CASE
        WHEN s.last_success_evaluation_id IS NULL THEN 'never_evaluated'
        ELSE 'stale_version'
      END,
      current_evaluation_fingerprint = v_fingerprint,
      dirty_since = CASE
        WHEN s.last_success_evaluation_id IS NULL THEN s.dirty_since
        ELSE COALESCE(s.dirty_since, now())
      END,
      updated_at = now()
    WHERE s.last_success_fingerprint IS DISTINCT FROM v_fingerprint;
  ELSE
    UPDATE public.ce_evaluation_state
    SET current_evaluation_fingerprint = v_fingerprint,
        updated_at = now();
  END IF;

  RETURN jsonb_build_object(
    'result','success',
    'evaluation_fingerprint',v_fingerprint,
    'mark_existing_stale',p_mark_existing_stale
  );
END
$$;

REVOKE ALL ON FUNCTION public.ce_activate_evaluation_methodology_v1(
  text,text,text,text,text,boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_activate_evaluation_methodology_v1(
  text,text,text,text,text,boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.ce_current_evaluation_fingerprint()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.evaluation_fingerprint
  FROM public.ce_evaluation_methodology m
  WHERE m.status = 'current'
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.ce_current_evaluation_fingerprint()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_current_evaluation_fingerprint()
  TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Queue RPC: server-only, snapshot+fingerprint idempotent, revision-safe.
-- Task 2 will decide WHEN to call this RPC.
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
  v_job_id uuid;
  v_job_key text;
  v_priority integer;
  v_current_fingerprint text;
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
    SELECT id INTO v_job_id
    FROM public.ce_evaluation_job
    WHERE job_key = v_job_key;

    RETURN jsonb_build_object(
      'result','already_queued',
      'job_id',v_job_id,
      'job_key',v_job_key
    );
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
-- 9. Evaluation freshness finalizer.
-- If the conversation revision changed while an evaluation was running, the
-- result remains a valid audit result but is marked superseded. The state stays
-- dirty so Task 2 can enqueue the newest snapshot.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_finalize_evaluation_freshness_v1(
  p_conversation_id uuid,
  p_evaluation_id uuid,
  p_evaluation_source text,
  p_snapshot_hash text,
  p_evaluation_fingerprint text,
  p_expected_revision bigint,
  p_success_at timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state public.ce_evaluation_state;
  v_is_current boolean;
  v_exists boolean := false;
BEGIN
  IF p_evaluation_source NOT IN ('canonical','conversation_local')
     OR p_conversation_id IS NULL
     OR p_evaluation_id IS NULL
     OR NULLIF(trim(COALESCE(p_snapshot_hash,'')), '') IS NULL
     OR COALESCE(p_evaluation_fingerprint,'') !~ '^[0-9a-f]{64}$'
     OR p_expected_revision IS NULL
     OR p_expected_revision < 0 THEN
    RETURN jsonb_build_object('result','invalid_input');
  END IF;

  IF p_evaluation_source = 'canonical' THEN
    SELECT EXISTS(
      SELECT 1
      FROM public.conversation_evaluation e
      WHERE e.id = p_evaluation_id
        AND e.conversation_id = p_conversation_id
    ) INTO v_exists;
  ELSE
    SELECT EXISTS(
      SELECT 1
      FROM public.ce_local_evaluation e
      WHERE e.id = p_evaluation_id
        AND e.conversation_id = p_conversation_id
    ) INTO v_exists;
  END IF;

  IF NOT v_exists THEN
    RETURN jsonb_build_object('result','evaluation_not_found');
  END IF;

  SELECT * INTO v_state
  FROM public.ce_evaluation_state
  WHERE conversation_id = p_conversation_id
  FOR UPDATE;

  IF v_state.conversation_id IS NULL THEN
    RETURN jsonb_build_object('result','state_not_initialized');
  END IF;

  v_is_current := v_state.revision = p_expected_revision;

  IF v_is_current THEN
    -- A current evaluation supersedes every older result for this conversation,
    -- regardless of local/canonical source. History rows stay intact.
    UPDATE public.conversation_evaluation
      SET freshness = 'superseded'
      WHERE conversation_id = p_conversation_id
        AND id <> p_evaluation_id
        AND freshness = 'current';

    UPDATE public.ce_local_evaluation
      SET freshness = 'superseded'
      WHERE conversation_id = p_conversation_id
        AND id <> p_evaluation_id
        AND freshness = 'current';

    IF p_evaluation_source = 'canonical' THEN
      UPDATE public.conversation_evaluation
      SET evaluation_fingerprint = p_evaluation_fingerprint,
          freshness = 'current'
      WHERE id = p_evaluation_id;
    ELSE
      UPDATE public.ce_local_evaluation
      SET evaluation_fingerprint = p_evaluation_fingerprint,
          freshness = 'current'
      WHERE id = p_evaluation_id;
    END IF;

    UPDATE public.ce_evaluation_state
    SET
      state = 'up_to_date',
      current_snapshot_hash = p_snapshot_hash,
      current_evaluation_fingerprint = p_evaluation_fingerprint,
      last_success_evaluation_id = p_evaluation_id,
      last_success_source = p_evaluation_source,
      last_success_snapshot_hash = p_snapshot_hash,
      last_success_fingerprint = p_evaluation_fingerprint,
      last_success_at = COALESCE(p_success_at, now()),
      dirty_since = NULL,
      queued_at = NULL,
      evaluating_started_at = NULL,
      last_error_code = NULL,
      updated_at = now()
    WHERE conversation_id = p_conversation_id;

    RETURN jsonb_build_object('result','current');
  END IF;

  -- Race: a newer evaluation-relevant change arrived while the run was active.
  IF p_evaluation_source = 'canonical' THEN
    UPDATE public.conversation_evaluation
    SET evaluation_fingerprint = p_evaluation_fingerprint,
        freshness = 'superseded'
    WHERE id = p_evaluation_id;
  ELSE
    UPDATE public.ce_local_evaluation
    SET evaluation_fingerprint = p_evaluation_fingerprint,
        freshness = 'superseded'
    WHERE id = p_evaluation_id;
  END IF;

  UPDATE public.ce_evaluation_state
  SET
    state = 'dirty',
    last_success_evaluation_id = p_evaluation_id,
    last_success_source = p_evaluation_source,
    last_success_snapshot_hash = p_snapshot_hash,
    last_success_fingerprint = p_evaluation_fingerprint,
    last_success_at = COALESCE(p_success_at, now()),
    dirty_since = COALESCE(dirty_since, now()),
    queued_at = NULL,
    evaluating_started_at = NULL,
    updated_at = now()
  WHERE conversation_id = p_conversation_id;

  RETURN jsonb_build_object(
    'result','superseded',
    'current_revision',v_state.revision,
    'evaluated_revision',p_expected_revision
  );
END
$$;

REVOKE ALL ON FUNCTION public.ce_finalize_evaluation_freshness_v1(
  uuid,uuid,text,text,text,bigint,timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_finalize_evaluation_freshness_v1(
  uuid,uuid,text,text,text,bigint,timestamptz
) TO service_role;

-- ---------------------------------------------------------------------------
-- 10. One-time state bootstrap. No LLM calls. No queue jobs.
-- Existing evaluation is treated as up-to-date only when no later message exists.
-- ---------------------------------------------------------------------------
WITH all_evaluations AS (
  SELECT
    e.id,
    e.conversation_id,
    'canonical'::text AS source,
    e.input_snapshot_hash,
    e.evaluation_fingerprint,
    e.created_at
  FROM public.conversation_evaluation e
  UNION ALL
  SELECT
    e.id,
    e.conversation_id,
    'conversation_local'::text AS source,
    e.input_snapshot_hash,
    e.evaluation_fingerprint,
    e.created_at
  FROM public.ce_local_evaluation e
),
latest_eval AS (
  SELECT DISTINCT ON (conversation_id)
    id,
    conversation_id,
    source,
    input_snapshot_hash,
    evaluation_fingerprint,
    created_at
  FROM all_evaluations
  ORDER BY conversation_id, created_at DESC, id DESC
),
last_activity AS (
  SELECT
    m.conversation_id,
    max(m.created_at) FILTER (
      WHERE COALESCE(m.content,'') IS DISTINCT FROM '__THINKING__'
    ) AS last_activity_at
  FROM public.messages m
  GROUP BY m.conversation_id
)
INSERT INTO public.ce_evaluation_state (
  conversation_id,
  company_id,
  state,
  revision,
  current_snapshot_hash,
  current_evaluation_fingerprint,
  last_success_evaluation_id,
  last_success_source,
  last_success_snapshot_hash,
  last_success_fingerprint,
  last_success_at,
  dirty_since,
  last_activity_at,
  updated_at
)
SELECT
  c.id,
  COALESCE(c.company_id, cc.company_id),
  CASE
    WHEN le.id IS NULL THEN 'never_evaluated'
    WHEN la.last_activity_at IS NOT NULL AND la.last_activity_at > le.created_at THEN 'dirty'
    ELSE 'up_to_date'
  END,
  0,
  CASE
    WHEN le.id IS NOT NULL
      AND NOT (la.last_activity_at IS NOT NULL AND la.last_activity_at > le.created_at)
      THEN le.input_snapshot_hash
    ELSE NULL
  END,
  NULL,
  le.id,
  le.source,
  le.input_snapshot_hash,
  le.evaluation_fingerprint,
  le.created_at,
  CASE
    WHEN le.id IS NULL THEN COALESCE(la.last_activity_at, c.created_at)
    WHEN la.last_activity_at IS NOT NULL AND la.last_activity_at > le.created_at
      THEN la.last_activity_at
    ELSE NULL
  END,
  la.last_activity_at,
  now()
FROM public.conversations c
LEFT JOIN public.channel_config cc ON cc.id = c.channel_config_id
LEFT JOIN latest_eval le ON le.conversation_id = c.id
LEFT JOIN last_activity la ON la.conversation_id = c.id
ON CONFLICT (conversation_id) DO NOTHING;

COMMIT;
