-- PR-7 config/profile RPC tenant isolation guard.
-- SOURCE ONLY. Do not apply to production without explicit Director authorization.
--
-- Scope:
--   rpc_update_widget_config
--   rpc_update_channel_config
--   rpc_update_feedback_config
--   rpc_update_agent_profile
--
-- Security:
--   - target-scoped company resolution
--   - active company required
--   - active company_membership required
--   - company-level admin/supervisor required for cross-resource config writes
--   - profile self-edit remains allowed; elevated cross-profile edit requires shared company
--   - PUBLIC/anon execute revoked; authenticated only

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_update_widget_config(
  p_widget_config_id uuid,
  p_name             text DEFAULT NULL,
  p_header_title     text DEFAULT NULL,
  p_welcome_message  text DEFAULT NULL,
  p_placeholder_text text DEFAULT NULL,
  p_primary_color    text DEFAULT NULL,
  p_logo_url         text DEFAULT NULL,
  p_is_active        boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_id      uuid;
  v_request_id    text := md5(clock_timestamp()::text || random()::text);
  v_company_id    uuid;
  v_company_count integer;
  v_name          text;
  v_header        text;
  v_welcome       text;
  v_placeholder   text;
  v_changed       text[] := ARRAY[]::text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  SELECT id INTO v_actor_id
  FROM public.agent_profile
  WHERE user_id = auth.uid() AND status = 'active'
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  SELECT count(DISTINCT cc.company_id), min(cc.company_id)
    INTO v_company_count, v_company_id
  FROM public.channel_config cc
  JOIN public.company c ON c.id = cc.company_id AND c.is_active = true
  WHERE cc.widget_config_id = p_widget_config_id
    AND cc.company_id IS NOT NULL;

  IF v_company_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNSCOPED_RESOURCE',
      'message_safe', 'Widget configuration is not bound to an active company.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  IF v_company_count <> 1 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'AMBIGUOUS_TENANT_SCOPE',
      'message_safe', 'Widget configuration has ambiguous company scope.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.company_membership cm
    WHERE cm.user_id = auth.uid()
      AND cm.company_id = v_company_id
      AND cm.is_active = true
      AND cm.role IN ('admin'::public.app_role, 'supervisor'::public.app_role)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN',
      'message_safe', 'Insufficient permissions.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  IF p_name IS NOT NULL THEN
    v_name := btrim(p_name);
    IF char_length(v_name) > 100 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid name.', 'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'name';
  END IF;

  IF p_header_title IS NOT NULL THEN
    v_header := btrim(p_header_title);
    IF char_length(v_header) > 100 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid header title.', 'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'header_title';
  END IF;

  IF p_welcome_message IS NOT NULL THEN
    v_welcome := btrim(p_welcome_message);
    IF char_length(v_welcome) > 500 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid welcome message.', 'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'welcome_message';
  END IF;

  IF p_placeholder_text IS NOT NULL THEN
    v_placeholder := btrim(p_placeholder_text);
    IF char_length(v_placeholder) > 200 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid placeholder text.', 'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'placeholder_text';
  END IF;

  IF p_primary_color IS NOT NULL THEN
    IF p_primary_color !~ '^#[0-9A-Fa-f]{6}$' THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid color value.', 'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'primary_color';
  END IF;

  IF p_logo_url IS NOT NULL THEN
    IF p_logo_url !~ '^https://' THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid logo URL.', 'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'logo_url';
  END IF;

  IF p_is_active IS NOT NULL THEN
    v_changed := v_changed || 'is_active';
  END IF;

  UPDATE public.widget_config SET
    name             = COALESCE(v_name, name),
    header_title     = COALESCE(v_header, header_title),
    welcome_message  = COALESCE(v_welcome, welcome_message),
    placeholder_text = COALESCE(v_placeholder, placeholder_text),
    primary_color    = COALESCE(p_primary_color, primary_color),
    logo_url         = COALESCE(p_logo_url, logo_url),
    is_active        = COALESCE(p_is_active, is_active),
    updated_at       = now()
  WHERE id = p_widget_config_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND',
      'message_safe', 'Record not found.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  INSERT INTO public.audit_log(action, actor_id, actor_type, resource_type, resource_id, diff)
  VALUES ('update_widget_config', v_actor_id, 'agent', 'widget_config', p_widget_config_id,
    jsonb_build_object(
      'severity', 'standard',
      'company_id', v_company_id,
      'fields_changed', to_jsonb(v_changed)
    ));

  RETURN jsonb_build_object('ok', true, 'request_id', v_request_id,
    'data', jsonb_build_object('updated_id', p_widget_config_id, 'company_id', v_company_id));

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL',
    'message_safe', 'Config update failed. Please try again.',
    'request_id', v_request_id, 'retryable', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_update_channel_config(
  p_channel_config_id uuid,
  p_is_active         boolean DEFAULT NULL,
  p_allowed_origins   text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_id      uuid;
  v_request_id    text := md5(clock_timestamp()::text || random()::text);
  v_company_id    uuid;
  v_channel_type  text;
  v_origin        text;
  v_norm          text;
  v_normalized    text[] := ARRAY[]::text[];
  v_changed       text[] := ARRAY[]::text[];
  v_origins_count integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  SELECT id INTO v_actor_id
  FROM public.agent_profile
  WHERE user_id = auth.uid() AND status = 'active'
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  SELECT cc.channel_type, cc.company_id
    INTO v_channel_type, v_company_id
  FROM public.channel_config cc
  WHERE cc.id = p_channel_config_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND',
      'message_safe', 'Record not found.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  IF v_company_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company c WHERE c.id = v_company_id AND c.is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNSCOPED_RESOURCE',
      'message_safe', 'Channel is not bound to an active company.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.company_membership cm
    WHERE cm.user_id = auth.uid()
      AND cm.company_id = v_company_id
      AND cm.is_active = true
      AND cm.role IN ('admin'::public.app_role, 'supervisor'::public.app_role)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN',
      'message_safe', 'Insufficient permissions.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  IF v_channel_type NOT IN ('website_widget', 'web_widget') THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_SUPPORTED',
      'message_safe', 'This channel type is not available in the current version.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  IF p_allowed_origins IS NOT NULL THEN
    FOREACH v_origin IN ARRAY p_allowed_origins LOOP
      IF v_origin IS NULL OR position(' ' in v_origin) > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
          'message_safe', 'Invalid origin format.', 'request_id', v_request_id, 'retryable', false);
      END IF;
      v_norm := lower(v_origin);
      IF right(v_norm, 1) = '/' THEN
        v_norm := left(v_norm, char_length(v_norm) - 1);
      END IF;
      IF v_norm ~ '^(javascript|data):' OR position('*' in v_norm) > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
          'message_safe', 'Invalid origin.', 'request_id', v_request_id, 'retryable', false);
      END IF;
      IF v_norm ~ '^https://[a-z0-9.-]+(:[0-9]+)?$' THEN
        NULL;
      ELSIF v_norm ~ '^http://localhost(:[0-9]+)?$' THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.channel_config
          WHERE id = p_channel_config_id
            AND allowed_origins IS NOT NULL
            AND v_norm = ANY(allowed_origins)
        ) THEN
          RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
            'message_safe', 'Invalid origin.', 'request_id', v_request_id, 'retryable', false);
        END IF;
      ELSE
        RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
          'message_safe', 'Invalid origin.', 'request_id', v_request_id, 'retryable', false);
      END IF;
      v_normalized := v_normalized || v_norm;
    END LOOP;
    v_changed := v_changed || 'allowed_origins';
    v_origins_count := COALESCE(array_length(v_normalized, 1), 0);
  END IF;

  IF p_is_active IS NOT NULL THEN
    v_changed := v_changed || 'is_active';
  END IF;

  UPDATE public.channel_config SET
    is_active       = COALESCE(p_is_active, is_active),
    allowed_origins = CASE WHEN p_allowed_origins IS NULL THEN allowed_origins ELSE v_normalized END,
    updated_at      = now()
  WHERE id = p_channel_config_id
    AND company_id = v_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'STALE_SCOPE',
      'message_safe', 'Channel scope changed. Please refresh and try again.',
      'request_id', v_request_id, 'retryable', true);
  END IF;

  INSERT INTO public.audit_log(action, actor_id, actor_type, resource_type, resource_id, diff)
  VALUES ('update_channel_config', v_actor_id, 'agent', 'channel_config', p_channel_config_id,
    jsonb_build_object(
      'severity', 'standard',
      'company_id', v_company_id,
      'fields_changed', to_jsonb(v_changed),
      'origins_count', v_origins_count
    ));

  RETURN jsonb_build_object('ok', true, 'request_id', v_request_id,
    'data', jsonb_build_object('updated_id', p_channel_config_id, 'company_id', v_company_id));

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL',
    'message_safe', 'Config update failed. Please try again.',
    'request_id', v_request_id, 'retryable', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_update_feedback_config(
  p_feedback_config_id uuid,
  p_is_active          boolean DEFAULT NULL,
  p_delay_minutes      integer DEFAULT NULL,
  p_config             jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_id   uuid;
  v_request_id text := md5(clock_timestamp()::text || random()::text);
  v_company_id uuid;
  v_changed    text[] := ARRAY[]::text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  SELECT id INTO v_actor_id
  FROM public.agent_profile
  WHERE user_id = auth.uid() AND status = 'active'
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  SELECT fac.company_id INTO v_company_id
  FROM public.feedback_automation_config fac
  WHERE fac.id = p_feedback_config_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND',
      'message_safe', 'Record not found.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  IF v_company_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company c WHERE c.id = v_company_id AND c.is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNSCOPED_RESOURCE',
      'message_safe', 'Feedback configuration is not bound to an active company.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.company_membership cm
    WHERE cm.user_id = auth.uid()
      AND cm.company_id = v_company_id
      AND cm.is_active = true
      AND cm.role IN ('admin'::public.app_role, 'supervisor'::public.app_role)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN',
      'message_safe', 'Insufficient permissions.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  IF p_delay_minutes IS NOT NULL THEN
    IF p_delay_minutes < 1440 OR p_delay_minutes > 43200 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Delay must be between 1 and 30 days.',
        'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'delay_minutes';
  END IF;
  IF p_is_active IS NOT NULL THEN v_changed := v_changed || 'is_active'; END IF;
  IF p_config IS NOT NULL THEN v_changed := v_changed || 'config'; END IF;

  UPDATE public.feedback_automation_config SET
    is_active     = COALESCE(p_is_active, is_active),
    delay_minutes = COALESCE(p_delay_minutes, delay_minutes),
    config        = COALESCE(p_config, config),
    updated_at    = now()
  WHERE id = p_feedback_config_id
    AND company_id = v_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'STALE_SCOPE',
      'message_safe', 'Feedback configuration scope changed. Please refresh and try again.',
      'request_id', v_request_id, 'retryable', true);
  END IF;

  INSERT INTO public.audit_log(action, actor_id, actor_type, resource_type, resource_id, diff)
  VALUES ('update_feedback_config', v_actor_id, 'agent', 'feedback_automation_config', p_feedback_config_id,
    jsonb_build_object(
      'severity', 'standard',
      'company_id', v_company_id,
      'fields_changed', to_jsonb(v_changed)
    ));

  RETURN jsonb_build_object('ok', true, 'request_id', v_request_id,
    'data', jsonb_build_object('updated_id', p_feedback_config_id, 'company_id', v_company_id));

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL',
    'message_safe', 'Config update failed. Please try again.',
    'request_id', v_request_id, 'retryable', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_update_agent_profile(
  p_agent_id     uuid,
  p_display_name text DEFAULT NULL,
  p_avatar_url   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_id      uuid;
  v_target_user   uuid;
  v_request_id    text := md5(clock_timestamp()::text || random()::text);
  v_display       text;
  v_changed       text[] := ARRAY[]::text[];
  v_self_edit     boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  SELECT id INTO v_actor_id
  FROM public.agent_profile
  WHERE user_id = auth.uid() AND status = 'active'
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  SELECT user_id INTO v_target_user
  FROM public.agent_profile
  WHERE id = p_agent_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND',
      'message_safe', 'Record not found.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  v_self_edit := (p_agent_id = v_actor_id);

  IF NOT v_self_edit THEN
    IF v_target_user IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.company_membership actor_cm
      JOIN public.company_membership target_cm
        ON target_cm.company_id = actor_cm.company_id
       AND target_cm.user_id = v_target_user
       AND target_cm.is_active = true
      JOIN public.company c
        ON c.id = actor_cm.company_id
       AND c.is_active = true
      WHERE actor_cm.user_id = auth.uid()
        AND actor_cm.is_active = true
        AND actor_cm.role IN ('admin'::public.app_role, 'supervisor'::public.app_role)
    ) THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN',
        'message_safe', 'Insufficient permissions.', 'request_id', v_request_id, 'retryable', false);
    END IF;
  END IF;

  IF p_display_name IS NOT NULL THEN
    v_display := btrim(regexp_replace(p_display_name, '[[:cntrl:]]', '', 'g'));
    IF char_length(v_display) = 0 OR char_length(v_display) > 100 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid display name.', 'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'display_name';
  END IF;

  IF p_avatar_url IS NOT NULL THEN
    IF p_avatar_url !~ '^https://' THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid avatar URL.', 'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'avatar_url';
  END IF;

  UPDATE public.agent_profile SET
    display_name = COALESCE(v_display, display_name),
    avatar_url   = COALESCE(p_avatar_url, avatar_url),
    updated_at   = now()
  WHERE id = p_agent_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND',
      'message_safe', 'Record not found.', 'request_id', v_request_id, 'retryable', false);
  END IF;

  INSERT INTO public.audit_log(action, actor_id, actor_type, resource_type, resource_id, diff)
  VALUES ('update_agent_profile', v_actor_id, 'agent', 'agent_profile', p_agent_id,
    jsonb_build_object(
      'severity', 'standard',
      'self_edit', v_self_edit,
      'fields_changed', to_jsonb(v_changed)
    ));

  RETURN jsonb_build_object('ok', true, 'request_id', v_request_id,
    'data', jsonb_build_object('updated_id', p_agent_id));

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL',
    'message_safe', 'Profile update failed. Please try again.',
    'request_id', v_request_id, 'retryable', true);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_update_widget_config(uuid,text,text,text,text,text,text,boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_update_channel_config(uuid,boolean,text[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_update_feedback_config(uuid,boolean,integer,jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_update_agent_profile(uuid,text,text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_update_widget_config(uuid,text,text,text,text,text,text,boolean)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_channel_config(uuid,boolean,text[])
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_feedback_config(uuid,boolean,integer,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_agent_profile(uuid,text,text)
  TO authenticated;

DO $assert$
BEGIN
  IF has_function_privilege('anon',
    'public.rpc_update_widget_config(uuid,text,text,text,text,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon',
    'public.rpc_update_channel_config(uuid,boolean,text[])', 'EXECUTE')
     OR has_function_privilege('anon',
    'public.rpc_update_feedback_config(uuid,boolean,integer,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon',
    'public.rpc_update_agent_profile(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT: anon must not execute protected config RPCs';
  END IF;

  IF NOT has_function_privilege('authenticated',
    'public.rpc_update_widget_config(uuid,text,text,text,text,text,text,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
    'public.rpc_update_channel_config(uuid,boolean,text[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
    'public.rpc_update_feedback_config(uuid,boolean,integer,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
    'public.rpc_update_agent_profile(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT: authenticated execute missing';
  END IF;
END
$assert$;

COMMIT;
