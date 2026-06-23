-- L6 Config RPCs: 4 SECURITY DEFINER functions in public.*
-- No structural DDL. No new tables/columns/types.

-- =====================================================================
-- 1) rpc_update_widget_config
-- =====================================================================
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
SET search_path = public
AS $$
DECLARE
  v_actor_id      uuid;
  v_request_id    text := md5(clock_timestamp()::text || random()::text);
  v_name          text;
  v_header        text;
  v_welcome       text;
  v_placeholder   text;
  v_changed       text[] := ARRAY[]::text[];
BEGIN
  -- STEP 1: Resolve actor
  SELECT id INTO v_actor_id FROM public.agent_profile WHERE user_id = auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  -- STEP 2: Permission (admin OR supervisor)
  IF NOT (
    public.has_role(auth.uid(), 'admin'::public.app_role) OR
    public.has_role(auth.uid(), 'supervisor'::public.app_role)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN',
      'message_safe', 'Insufficient permissions.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  -- STEP 3: Validate
  IF p_name IS NOT NULL THEN
    v_name := btrim(p_name);
    IF char_length(v_name) > 100 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid name.',
        'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'name';
  END IF;
  IF p_header_title IS NOT NULL THEN
    v_header := btrim(p_header_title);
    IF char_length(v_header) > 100 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid header title.',
        'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'header_title';
  END IF;
  IF p_welcome_message IS NOT NULL THEN
    v_welcome := btrim(p_welcome_message);
    IF char_length(v_welcome) > 500 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid welcome message.',
        'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'welcome_message';
  END IF;
  IF p_placeholder_text IS NOT NULL THEN
    v_placeholder := btrim(p_placeholder_text);
    IF char_length(v_placeholder) > 200 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid placeholder text.',
        'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'placeholder_text';
  END IF;
  IF p_primary_color IS NOT NULL THEN
    IF p_primary_color !~ '^#[0-9A-Fa-f]{6}$' THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid color value.',
        'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'primary_color';
  END IF;
  IF p_logo_url IS NOT NULL THEN
    IF p_logo_url !~ '^https://' THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid logo URL.',
        'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'logo_url';
  END IF;
  IF p_is_active IS NOT NULL THEN
    v_changed := v_changed || 'is_active';
  END IF;

  -- STEP 4: UPDATE
  UPDATE public.widget_config SET
    name             = COALESCE(v_name, name),
    header_title     = COALESCE(v_header, header_title),
    welcome_message  = COALESCE(v_welcome, welcome_message),
    placeholder_text = COALESCE(v_placeholder, placeholder_text),
    primary_color    = COALESCE(p_primary_color, primary_color),
    logo_url         = COALESCE(p_logo_url, logo_url),
    is_active        = COALESCE(p_is_active, is_active),
    updated_at       = NOW()
  WHERE id = p_widget_config_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND',
      'message_safe', 'Record not found.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  -- STEP 5: Audit
  INSERT INTO public.audit_log (action, actor_id, actor_type, resource_type, resource_id, diff)
  VALUES ('update_widget_config', v_actor_id, 'agent', 'widget_config', p_widget_config_id,
    jsonb_build_object('severity', 'standard', 'fields_changed', to_jsonb(v_changed)));

  RETURN jsonb_build_object('ok', true, 'request_id', v_request_id,
    'data', jsonb_build_object('updated_id', p_widget_config_id));

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL',
    'message_safe', 'Config update failed. Please try again.',
    'request_id', v_request_id, 'retryable', true);
END;
$$;

-- =====================================================================
-- 2) rpc_update_channel_config
-- =====================================================================
CREATE OR REPLACE FUNCTION public.rpc_update_channel_config(
  p_channel_config_id uuid,
  p_is_active         boolean DEFAULT NULL,
  p_allowed_origins   text[]  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id     uuid;
  v_request_id   text := md5(clock_timestamp()::text || random()::text);
  v_channel_type text;
  v_origin       text;
  v_norm         text;
  v_normalized   text[] := ARRAY[]::text[];
  v_changed      text[] := ARRAY[]::text[];
  v_origins_count int := 0;
BEGIN
  SELECT id INTO v_actor_id FROM public.agent_profile WHERE user_id = auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'admin'::public.app_role) OR
    public.has_role(auth.uid(), 'supervisor'::public.app_role)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN',
      'message_safe', 'Insufficient permissions.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  -- channel_type from existing record
  SELECT channel_type INTO v_channel_type
    FROM public.channel_config WHERE id = p_channel_config_id;
  IF v_channel_type IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND',
      'message_safe', 'Record not found.',
      'request_id', v_request_id, 'retryable', false);
  END IF;
  IF v_channel_type <> 'website_widget' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_SUPPORTED',
      'message_safe', 'This channel type is not available in the current version.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  -- Normalize allowed_origins
  IF p_allowed_origins IS NOT NULL THEN
    FOREACH v_origin IN ARRAY p_allowed_origins LOOP
      IF v_origin IS NULL OR position(' ' in v_origin) > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
          'message_safe', 'Invalid origin format.',
          'request_id', v_request_id, 'retryable', false);
      END IF;
      v_norm := lower(v_origin);
      IF right(v_norm, 1) = '/' THEN
        v_norm := left(v_norm, char_length(v_norm) - 1);
      END IF;
      -- Reject javascript:/data: schemes
      IF v_norm ~ '^(javascript|data):' THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
          'message_safe', 'Invalid origin scheme.',
          'request_id', v_request_id, 'retryable', false);
      END IF;
      -- Reject wildcard
      IF position('*' in v_norm) > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
          'message_safe', 'Wildcard origins are not allowed.',
          'request_id', v_request_id, 'retryable', false);
      END IF;
      -- Must be https://host or http://localhost:port (if already in existing)
      IF v_norm ~ '^https://[a-z0-9.-]+(:[0-9]+)?$' THEN
        NULL;
      ELSIF v_norm ~ '^http://localhost(:[0-9]+)?$' THEN
        -- allow only if already present in existing data
        IF NOT EXISTS (
          SELECT 1 FROM public.channel_config
          WHERE id = p_channel_config_id
            AND allowed_origins IS NOT NULL
            AND v_norm = ANY (allowed_origins)
        ) THEN
          RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
            'message_safe', 'Invalid origin.',
            'request_id', v_request_id, 'retryable', false);
        END IF;
      ELSE
        -- Reject bare host / path / query / hash / other schemes
        RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
          'message_safe', 'Invalid origin.',
          'request_id', v_request_id, 'retryable', false);
      END IF;
      v_normalized := v_normalized || v_norm;
    END LOOP;
    v_changed := v_changed || 'allowed_origins';
    v_origins_count := array_length(v_normalized, 1);
  END IF;

  IF p_is_active IS NOT NULL THEN
    v_changed := v_changed || 'is_active';
  END IF;

  UPDATE public.channel_config SET
    is_active       = COALESCE(p_is_active, is_active),
    allowed_origins = CASE WHEN p_allowed_origins IS NULL THEN allowed_origins ELSE v_normalized END,
    updated_at      = NOW()
  WHERE id = p_channel_config_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND',
      'message_safe', 'Record not found.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  INSERT INTO public.audit_log (action, actor_id, actor_type, resource_type, resource_id, diff)
  VALUES ('update_channel_config', v_actor_id, 'agent', 'channel_config', p_channel_config_id,
    jsonb_build_object(
      'severity', 'standard',
      'fields_changed', to_jsonb(v_changed),
      'origins_count', v_origins_count
    ));

  RETURN jsonb_build_object('ok', true, 'request_id', v_request_id,
    'data', jsonb_build_object('updated_id', p_channel_config_id));

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL',
    'message_safe', 'Config update failed. Please try again.',
    'request_id', v_request_id, 'retryable', true);
END;
$$;

-- =====================================================================
-- 3) rpc_update_feedback_config
-- =====================================================================
CREATE OR REPLACE FUNCTION public.rpc_update_feedback_config(
  p_feedback_config_id uuid,
  p_is_active          boolean DEFAULT NULL,
  p_delay_minutes      integer DEFAULT NULL,
  p_config             jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id   uuid;
  v_request_id text := md5(clock_timestamp()::text || random()::text);
  v_changed    text[] := ARRAY[]::text[];
BEGIN
  SELECT id INTO v_actor_id FROM public.agent_profile WHERE user_id = auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'admin'::public.app_role) OR
    public.has_role(auth.uid(), 'supervisor'::public.app_role)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN',
      'message_safe', 'Insufficient permissions.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  IF p_delay_minutes IS NOT NULL THEN
    IF p_delay_minutes < 1440 OR p_delay_minutes > 43200 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Delay must be between 1 and 30 days.',
        'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'delay_minutes';
  END IF;
  IF p_is_active IS NOT NULL THEN
    v_changed := v_changed || 'is_active';
  END IF;
  IF p_config IS NOT NULL THEN
    v_changed := v_changed || 'config';
  END IF;

  -- Note: trigger_event is NOT in the UPDATE SET clause (preserved, deferred to L6b)
  UPDATE public.feedback_automation_config SET
    is_active     = COALESCE(p_is_active, is_active),
    delay_minutes = COALESCE(p_delay_minutes, delay_minutes),
    config        = COALESCE(p_config, config),
    updated_at    = NOW()
  WHERE id = p_feedback_config_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND',
      'message_safe', 'Record not found.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  INSERT INTO public.audit_log (action, actor_id, actor_type, resource_type, resource_id, diff)
  VALUES ('update_feedback_config', v_actor_id, 'agent', 'feedback_automation_config', p_feedback_config_id,
    jsonb_build_object('severity', 'standard', 'fields_changed', to_jsonb(v_changed)));

  RETURN jsonb_build_object('ok', true, 'request_id', v_request_id,
    'data', jsonb_build_object('updated_id', p_feedback_config_id));

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL',
    'message_safe', 'Config update failed. Please try again.',
    'request_id', v_request_id, 'retryable', true);
END;
$$;

-- =====================================================================
-- 4) rpc_update_agent_profile (role-split; safe fields only)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.rpc_update_agent_profile(
  p_agent_id     uuid,
  p_display_name text DEFAULT NULL,
  p_avatar_url   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id    uuid;
  v_request_id  text := md5(clock_timestamp()::text || random()::text);
  v_is_elevated boolean;
  v_display     text;
  v_changed     text[] := ARRAY[]::text[];
BEGIN
  SELECT id INTO v_actor_id FROM public.agent_profile WHERE user_id = auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'UNAUTHORIZED',
      'message_safe', 'Authentication required.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  v_is_elevated := (
    public.has_role(auth.uid(), 'admin'::public.app_role) OR
    public.has_role(auth.uid(), 'supervisor'::public.app_role)
  );

  -- Agent can only update OWN profile
  IF NOT v_is_elevated THEN
    IF p_agent_id <> v_actor_id THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'FORBIDDEN',
        'message_safe', 'Insufficient permissions.',
        'request_id', v_request_id, 'retryable', false);
    END IF;
  END IF;

  IF p_display_name IS NOT NULL THEN
    v_display := btrim(regexp_replace(p_display_name, '[[:cntrl:]]', '', 'g'));
    IF char_length(v_display) = 0 OR char_length(v_display) > 100 THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid display name.',
        'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'display_name';
  END IF;
  IF p_avatar_url IS NOT NULL THEN
    IF p_avatar_url !~ '^https://' THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'VALIDATION_ERROR',
        'message_safe', 'Invalid avatar URL.',
        'request_id', v_request_id, 'retryable', false);
    END IF;
    v_changed := v_changed || 'avatar_url';
  END IF;

  -- Note: role / status / user_id / email NOT in the UPDATE SET clause (preserved)
  UPDATE public.agent_profile SET
    display_name = COALESCE(v_display, display_name),
    avatar_url   = COALESCE(p_avatar_url, avatar_url),
    updated_at   = NOW()
  WHERE id = p_agent_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND',
      'message_safe', 'Record not found.',
      'request_id', v_request_id, 'retryable', false);
  END IF;

  INSERT INTO public.audit_log (action, actor_id, actor_type, resource_type, resource_id, diff)
  VALUES ('update_agent_profile', v_actor_id, 'agent', 'agent_profile', p_agent_id,
    jsonb_build_object('severity', 'standard', 'fields_changed', to_jsonb(v_changed)));

  RETURN jsonb_build_object('ok', true, 'request_id', v_request_id,
    'data', jsonb_build_object('updated_id', p_agent_id));

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error_code', 'INTERNAL',
    'message_safe', 'Profile update failed. Please try again.',
    'request_id', v_request_id, 'retryable', true);
END;
$$;