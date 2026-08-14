-- PR-7 feedback widget delivery atomic completion.
-- SOURCE ONLY. Do not apply without explicit Director authorization.

BEGIN;

CREATE OR REPLACE FUNCTION public.complete_widget_feedback_delivery_tx(
  p_feedback_request_id uuid,
  p_conversation_id uuid,
  p_company_id uuid,
  p_token_hash text,
  p_token_created_at timestamptz,
  p_token_expires_at timestamptz,
  p_sent_at timestamptz,
  p_feedback_link text,
  p_rating_type text,
  p_contract_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_fr record;
  v_existing_message_id uuid;
  v_message_id uuid;
BEGIN
  IF p_token_hash IS NULL
     OR length(p_token_hash) <> 64
     OR p_token_created_at IS NULL
     OR p_token_expires_at IS NULL
     OR p_sent_at IS NULL
     OR p_feedback_link IS NULL
     OR p_feedback_link = ''
     OR p_rating_type IS NULL
     OR p_rating_type = ''
     OR p_contract_version IS NULL
     OR p_contract_version = '' THEN
    RETURN jsonb_build_object('result', 'invalid_contract');
  END IF;

  SELECT
    fr.id,
    fr.status,
    fr.delivery_status,
    fr.conversation_id,
    fr.response_token_hash,
    fr.token_used_at,
    c.company_id
  INTO v_fr
  FROM public.feedback_request fr
  JOIN public.conversations c
    ON c.id = fr.conversation_id
  WHERE fr.id = p_feedback_request_id
  FOR UPDATE OF fr;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF v_fr.conversation_id IS DISTINCT FROM p_conversation_id
     OR v_fr.company_id IS DISTINCT FROM p_company_id THEN
    RETURN jsonb_build_object('result', 'scope_mismatch');
  END IF;

  IF v_fr.status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('result', 'request_not_pending');
  END IF;

  -- Idempotent replay after a successful completion.
  IF v_fr.delivery_status = 'sent' THEN
    SELECT m.id
      INTO v_existing_message_id
    FROM public.messages m
    WHERE m.conversation_id = p_conversation_id
      AND m.role = 'system'
      AND COALESCE(m.is_recalled, false) = false
      AND m.metadata @> jsonb_build_object(
        'feedback_request', true,
        'feedback_request_id', p_feedback_request_id::text
      )
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT 1;

    IF v_existing_message_id IS NOT NULL
       AND v_fr.response_token_hash = p_token_hash THEN
      RETURN jsonb_build_object(
        'result', 'already_sent',
        'message_id', v_existing_message_id
      );
    END IF;

    RETURN jsonb_build_object('result', 'already_sent_different_token');
  END IF;

  IF v_fr.delivery_status IS DISTINCT FROM 'in_progress' THEN
    RETURN jsonb_build_object('result', 'stale_claim');
  END IF;

  IF v_fr.token_used_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'token_already_used');
  END IF;

  -- Guard against any earlier partial/manual duplicate before inserting.
  SELECT m.id
    INTO v_existing_message_id
  FROM public.messages m
  WHERE m.conversation_id = p_conversation_id
    AND m.role = 'system'
    AND COALESCE(m.is_recalled, false) = false
    AND m.metadata @> jsonb_build_object(
      'feedback_request', true,
      'feedback_request_id', p_feedback_request_id::text
    )
  ORDER BY m.created_at ASC, m.id ASC
  LIMIT 1
  FOR UPDATE;

  IF v_existing_message_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'result', 'existing_delivery_message',
      'message_id', v_existing_message_id
    );
  END IF;

  INSERT INTO public.messages (
    conversation_id,
    role,
    content,
    status,
    is_recalled,
    metadata
  )
  VALUES (
    p_conversation_id,
    'system',
    'How was your support experience?',
    'delivered',
    false,
    jsonb_build_object(
      'feedback_request', true,
      'feedback_request_id', p_feedback_request_id::text,
      'feedback_link', p_feedback_link,
      'rating_type', p_rating_type,
      'contract_version', p_contract_version
    )
  )
  RETURNING id INTO v_message_id;

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

  RETURN jsonb_build_object(
    'result', 'success',
    'message_id', v_message_id
  );
END;
$function$;

ALTER FUNCTION public.complete_widget_feedback_delivery_tx(
  uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,text,text,text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.complete_widget_feedback_delivery_tx(
  uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,text,text,text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.complete_widget_feedback_delivery_tx(
  uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,text,text,text
) TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.complete_widget_feedback_delivery_tx(uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: authenticated cannot invoke complete_widget_feedback_delivery_tx';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.complete_widget_feedback_delivery_tx(uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: service_role execute missing';
  END IF;
END
$assert$;

COMMIT;
