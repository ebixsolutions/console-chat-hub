-- PR-6B Singapore KB publish finalizer coordination.
-- SOURCE ONLY. Do not apply without explicit Director authorization.
BEGIN;

CREATE OR REPLACE FUNCTION public.claim_pr6b_kb_finalize_tx()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v record;
BEGIN
  -- Recover an abandoned finalizer claim. Remote publish operation and RAG
  -- validation are idempotent reads; retry is safe.
  UPDATE public.ce_kb_publish_state
     SET remote_sync_state = 'pending',
         last_error = 'finalizer_stale_claim_recovered',
         updated_at = now()
   WHERE action = 'publish'
     AND state = 'in_progress'
     AND remote_sync_state = 'in_progress'
     AND updated_at < now() - interval '15 minutes';

  SELECT
    s.id AS publish_state_id,
    s.evaluation_id,
    s.company_id,
    s.kb_document_ref AS document_id,
    s.remote_ref AS operation_id,
    l.improved_result
  INTO v
  FROM public.ce_kb_publish_state s
  JOIN public.ce_training_link l
    ON l.evaluation_id = s.evaluation_id
   AND l.link_kind = 'training_candidate'
  WHERE s.action = 'publish'
    AND s.state = 'in_progress'
    AND s.remote_sync_state = 'pending'
    AND s.remote_ref IS NOT NULL
    AND l.improved_state = 'received'
    AND l.remote_sync_state = 'synced'
  ORDER BY s.updated_at
  FOR UPDATE OF s SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'none');
  END IF;

  UPDATE public.ce_kb_publish_state
     SET remote_sync_state = 'in_progress',
         last_error = NULL,
         updated_at = now()
   WHERE id = v.publish_state_id;

  RETURN jsonb_build_object(
    'result', 'claimed',
    'publish_state_id', v.publish_state_id,
    'evaluation_id', v.evaluation_id,
    'company_id', v.company_id,
    'document_id', v.document_id,
    'operation_id', v.operation_id,
    'improved_result', v.improved_result
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.finish_pr6b_kb_finalize_tx(
  p_publish_state_id uuid,
  p_outcome text,
  p_error text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v record;
BEGIN
  IF p_outcome NOT IN ('pending', 'published', 'failed') THEN
    RETURN jsonb_build_object('result', 'invalid_outcome');
  END IF;

  SELECT id, state, remote_sync_state
    INTO v
  FROM public.ce_kb_publish_state
  WHERE id = p_publish_state_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v.state = 'published' AND p_outcome = 'published' THEN
    RETURN jsonb_build_object('result', 'idempotent');
  END IF;
  IF v.state <> 'in_progress' OR v.remote_sync_state <> 'in_progress' THEN
    RETURN jsonb_build_object('result', 'stale_state');
  END IF;

  UPDATE public.ce_kb_publish_state
     SET state = CASE
           WHEN p_outcome = 'published' THEN 'published'
           WHEN p_outcome = 'failed' THEN 'failed'
           ELSE 'in_progress'
         END,
         remote_sync_state = CASE
           WHEN p_outcome = 'published' THEN 'synced'
           WHEN p_outcome = 'failed' THEN 'failed'
           ELSE 'pending'
         END,
         last_error = CASE WHEN p_outcome = 'published' THEN NULL ELSE left(p_error, 500) END,
         updated_at = now()
   WHERE id = p_publish_state_id;

  RETURN jsonb_build_object('result', 'success', 'outcome', p_outcome);
END;
$function$;

ALTER FUNCTION public.claim_pr6b_kb_finalize_tx() OWNER TO postgres;
ALTER FUNCTION public.finish_pr6b_kb_finalize_tx(uuid,text,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_pr6b_kb_finalize_tx()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_pr6b_kb_finalize_tx(uuid,text,text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_pr6b_kb_finalize_tx() TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_pr6b_kb_finalize_tx(uuid,text,text) TO service_role;

COMMIT;
