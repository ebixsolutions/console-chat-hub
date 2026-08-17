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