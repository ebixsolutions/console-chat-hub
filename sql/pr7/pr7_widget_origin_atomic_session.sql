-- PR-7 Website Widget origin + atomic session creation.
-- SOURCE ONLY. Do not apply to production without explicit Director authorization.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_widget_session_tx(
  p_channel_id uuid,
  p_session_token text,
  p_visitor_fingerprint text,
  p_visitor_metadata jsonb,
  p_page_url text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_channel record;
  v_session_id uuid;
  v_conversation_id uuid;
BEGIN
  IF p_channel_id IS NULL
     OR p_session_token IS NULL
     OR length(p_session_token) < 32
     OR length(p_session_token) > 256 THEN
    RETURN jsonb_build_object('result', 'invalid_input');
  END IF;

  SELECT id, company_id, is_active, channel_type
    INTO v_channel
  FROM public.channel_config
  WHERE id = p_channel_id
  FOR SHARE;

  IF NOT FOUND
     OR v_channel.is_active IS DISTINCT FROM true
     OR v_channel.channel_type IS DISTINCT FROM 'web_widget' THEN
    RETURN jsonb_build_object('result', 'channel_not_found');
  END IF;

  IF v_channel.company_id IS NULL THEN
    RETURN jsonb_build_object('result', 'channel_company_unresolved');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.company c
    WHERE c.id = v_channel.company_id
      AND c.is_active = true
  ) THEN
    RETURN jsonb_build_object('result', 'company_inactive');
  END IF;

  INSERT INTO public.visitor_session(
    session_token,
    channel_config_id,
    visitor_fingerprint,
    visitor_metadata,
    last_seen_at
  )
  VALUES (
    p_session_token,
    p_channel_id,
    NULLIF(left(p_visitor_fingerprint, 512), ''),
    COALESCE(p_visitor_metadata, '{}'::jsonb),
    now()
  )
  RETURNING id INTO v_session_id;

  INSERT INTO public.conversations(
    visitor_session_id,
    channel_config_id,
    company_id,
    status
  )
  VALUES (
    v_session_id,
    p_channel_id,
    v_channel.company_id,
    'open'
  )
  RETURNING id INTO v_conversation_id;

  INSERT INTO public.widget_session_event(
    visitor_session_id,
    event_type,
    event_data,
    page_url
  )
  VALUES (
    v_session_id,
    'widget_open',
    jsonb_build_object('conversation_id', v_conversation_id),
    left(p_page_url, 2048)
  );

  RETURN jsonb_build_object(
    'result', 'success',
    'session_id', v_session_id,
    'conversation_id', v_conversation_id
  );
END;
$function$;

ALTER FUNCTION public.create_widget_session_tx(
  uuid,text,text,jsonb,text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_widget_session_tx(
  uuid,text,text,jsonb,text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_widget_session_tx(
  uuid,text,text,jsonb,text
) TO service_role;

COMMIT;
