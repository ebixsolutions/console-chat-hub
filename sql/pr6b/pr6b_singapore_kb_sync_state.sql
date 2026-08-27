-- PR-6B Singapore KB sync state coordination.
-- Product-ready verified-correction approval guard.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ce_kb_publish_state_eval_action
ON public.ce_kb_publish_state(evaluation_id, action);

CREATE OR REPLACE FUNCTION public.claim_pr6b_kb_sync_tx()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $f$
DECLARE
  v record;
  v_state_id uuid;
BEGIN
  SELECT
    l.id,
    l.evaluation_id,
    l.company_id,
    l.improved_result,
    l.payload
  INTO v
  FROM public.ce_training_link l
  WHERE l.link_kind='training_candidate'
    AND l.improved_state='received'
    AND l.remote_sync_state='synced'
    AND COALESCE(l.payload->>'decision','')='trained'
    AND jsonb_typeof(l.improved_result->'kb_update')='object'

    -- Product-ready guard:
    -- "trained" does not equal "approved to publish".
    AND jsonb_typeof(l.improved_result->'kb_update'->'approval')='object'
    AND COALESCE(l.improved_result->'kb_update'->'approval'->>'status','')='approved'
    AND COALESCE(l.improved_result->'kb_update'->'approval'->>'source','')='su_coachai_verified_correction'
    AND NULLIF(trim(COALESCE(l.improved_result->'kb_update'->'approval'->>'approved_by','')), '') IS NOT NULL
    AND NULLIF(trim(COALESCE(l.improved_result->'kb_update'->'approval'->>'approved_at','')), '') IS NOT NULL

    AND NOT EXISTS (
      SELECT 1
      FROM public.ce_kb_publish_state s
      WHERE s.evaluation_id=l.evaluation_id
        AND s.action='publish'
        AND s.state IN ('in_progress','published','failed')
    )
  ORDER BY l.created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','none');
  END IF;

  INSERT INTO public.ce_kb_publish_state(
    evaluation_id,
    company_id,
    kb_document_ref,
    action,
    state,
    requested_by,
    remote_sync_state,
    updated_at
  )
  VALUES(
    v.evaluation_id,
    v.company_id,
    COALESCE(v.improved_result->'kb_update'->>'document_id',''),
    'publish',
    'in_progress',
    '00000000-0000-0000-0000-000000000000'::uuid,
    'pending',
    now()
  )
  ON CONFLICT (evaluation_id,action)
  DO UPDATE SET
    state='in_progress',
    updated_at=now(),
    last_error=NULL
  RETURNING id INTO v_state_id;

  RETURN jsonb_build_object(
    'result','claimed',
    'training_link_id',v.id,
    'evaluation_id',v.evaluation_id,
    'company_id',v.company_id,
    'improved_result',v.improved_result,
    'payload',v.payload,
    'publish_state_id',v_state_id
  );
END
$f$;

CREATE OR REPLACE FUNCTION public.finish_pr6b_kb_sync_tx(
  p_training_link_id uuid,
  p_success boolean,
  p_remote_ref text,
  p_error text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $f$
DECLARE
  v record;
BEGIN
  SELECT id,evaluation_id,company_id
  INTO v
  FROM public.ce_training_link
  WHERE id=p_training_link_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','not_found');
  END IF;

  UPDATE public.ce_kb_publish_state
  SET
    state=CASE WHEN p_success THEN 'in_progress' ELSE 'failed' END,
    remote_sync_state=CASE WHEN p_success THEN 'pending' ELSE 'failed' END,
    remote_ref=COALESCE(p_remote_ref,remote_ref),
    last_error=left(p_error,500),
    updated_at=now()
  WHERE evaluation_id=v.evaluation_id
    AND action='publish';

  RETURN jsonb_build_object('result','success');
END
$f$;

ALTER FUNCTION public.claim_pr6b_kb_sync_tx() OWNER TO postgres;
ALTER FUNCTION public.finish_pr6b_kb_sync_tx(uuid,boolean,text,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_pr6b_kb_sync_tx()
FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_pr6b_kb_sync_tx(uuid,boolean,text,text)
FROM PUBLIC,anon,authenticated;

GRANT EXECUTE ON FUNCTION public.claim_pr6b_kb_sync_tx() TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_pr6b_kb_sync_tx(uuid,boolean,text,text) TO service_role;

COMMIT;
