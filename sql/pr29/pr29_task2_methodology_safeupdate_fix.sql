-- PR29 Task 2 production blocker fix — safeupdate-compatible methodology activation.
-- Replaces only public.ce_activate_evaluation_methodology_v1.
-- Does NOT enqueue, backfill, call LLM, modify customer data, or rerun Task 1 bootstrap.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

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
    -- Supabase safeupdate rejects a WHERE-less UPDATE even when intentional.
    -- This predicate is idempotent and only touches rows whose fingerprint
    -- actually needs to change.
    UPDATE public.ce_evaluation_state s
    SET
      current_evaluation_fingerprint = v_fingerprint,
      updated_at = now()
    WHERE s.current_evaluation_fingerprint IS DISTINCT FROM v_fingerprint;
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

COMMIT;
