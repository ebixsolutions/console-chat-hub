-- PR-7 feedback delivery coordination.
-- SOURCE ONLY. Do not apply without explicit Director authorization.

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_feedback_delivery_tx()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v record;
BEGIN
  UPDATE public.feedback_request
     SET delivery_status = 'pending',
         delivery_error_type = 'stale_delivery_claim_recovered',
         updated_at = now()
   WHERE status = 'pending'
     AND delivery_status = 'in_progress'
     AND updated_at < now() - interval '15 minutes';

  SELECT
    fr.id AS feedback_request_id,
    fr.conversation_id,
    fr.channel,
    fr.rating_type,
    c.company_id
  INTO v
  FROM public.feedback_request fr
  JOIN public.conversations c ON c.id = fr.conversation_id
  WHERE fr.status = 'pending'
    AND COALESCE(fr.delivery_status, 'pending') = 'pending'
    AND fr.scheduled_at IS NOT NULL
    AND fr.scheduled_at <= now()
    AND c.company_id IS NOT NULL
  ORDER BY fr.scheduled_at, fr.created_at
  FOR UPDATE OF fr SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'none');
  END IF;

  UPDATE public.feedback_request
     SET delivery_status = 'in_progress',
         delivery_error_type = NULL,
         updated_at = now()
   WHERE id = v.feedback_request_id;

  RETURN jsonb_build_object(
    'result', 'claimed',
    'feedback_request_id', v.feedback_request_id,
    'conversation_id', v.conversation_id,
    'company_id', v.company_id,
    'channel', v.channel,
    'rating_type', v.rating_type
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.finish_feedback_delivery_tx(
  p_feedback_request_id uuid,
  p_outcome text,
  p_delivery_error_type text,
  p_token_hash text,
  p_token_created_at timestamptz,
  p_token_expires_at timestamptz,
  p_sent_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v record;
BEGIN
  IF p_outcome NOT IN ('pending', 'sent', 'failed') THEN
    RETURN jsonb_build_object('result', 'invalid_outcome');
  END IF;

  SELECT id, status, delivery_status, response_token_hash, token_used_at
    INTO v
  FROM public.feedback_request
  WHERE id = p_feedback_request_id
  FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v.status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('result', 'request_not_pending');
  END IF;
  IF v.delivery_status IS DISTINCT FROM 'in_progress' THEN
    RETURN jsonb_build_object('result', 'stale_claim');
  END IF;

  IF p_outcome = 'sent' THEN
    IF p_token_hash IS NULL
       OR p_token_created_at IS NULL
       OR p_token_expires_at IS NULL
       OR p_sent_at IS NULL
       OR length(p_token_hash) <> 64 THEN
      RETURN jsonb_build_object('result', 'token_contract_invalid');
    END IF;

    IF v.token_used_at IS NOT NULL THEN
      RETURN jsonb_build_object('result', 'token_already_used');
    END IF;

    UPDATE public.feedback_request
       SET response_token_hash = p_token_hash,
           token_created_at = p_token_created_at,
           token_expires_at = p_token_expires_at,
           token_used_at = NULL,
           delivery_status = 'sent',
           delivery_error_type = NULL,
           sent_at = p_sent_at,
           updated_at = now()
     WHERE id = p_feedback_request_id;
  ELSE
    UPDATE public.feedback_request
       SET delivery_status = p_outcome,
           delivery_error_type = left(p_delivery_error_type, 120),
           updated_at = now()
     WHERE id = p_feedback_request_id;
  END IF;

  RETURN jsonb_build_object('result', 'success');
END;
$function$;

ALTER FUNCTION public.claim_feedback_delivery_tx() OWNER TO postgres;
ALTER FUNCTION public.finish_feedback_delivery_tx(
  uuid,text,text,text,timestamptz,timestamptz,timestamptz
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_feedback_delivery_tx()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_feedback_delivery_tx(
  uuid,text,text,text,timestamptz,timestamptz,timestamptz
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_feedback_delivery_tx() TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_feedback_delivery_tx(
  uuid,text,text,text,timestamptz,timestamptz,timestamptz
) TO service_role;

COMMIT;
