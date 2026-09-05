-- HF-2 Structured Warm Handoff + Feedback Automation closure
-- Production-safe with historical duplicate preservation.
-- Exactly-once scheduling is enforced inside the conversation row-locked
-- resolution transaction; historical feedback rows are never deleted/relinked.
DROP INDEX IF EXISTS public.uq_feedback_request_conversation_config;

-- Align persisted rating constraints with configured rating types.
ALTER TABLE public.feedback_request DROP CONSTRAINT IF EXISTS feedback_request_rating_check;
ALTER TABLE public.feedback_request ADD CONSTRAINT feedback_request_rating_check CHECK (
  rating IS NULL OR
  (rating_type = 'nps' AND rating BETWEEN 0 AND 10) OR
  (rating_type = 'ces' AND rating BETWEEN 1 AND 7) OR
  (rating_type IN ('stars_1_5','csat') AND rating BETWEEN 1 AND 5) OR
  (rating_type = 'thumbs' AND rating BETWEEN 0 AND 1) OR
  (rating_type = 'survey' AND rating BETWEEN 1 AND 5)
);

ALTER TABLE public.feedback_request DROP CONSTRAINT IF EXISTS feedback_request_delivery_error_type_check;
ALTER TABLE public.feedback_request ADD CONSTRAINT feedback_request_delivery_error_type_check CHECK (
  delivery_error_type IS NULL OR delivery_error_type = ANY (ARRAY[
    'resend_auth_error','resend_validation_error','resend_rate_limited','email_send_failed',
    'config_error','missing_recipient_email','provider_auth_error','provider_validation_error',
    'provider_rate_limited','provider_send_failed','invalid_claim_scope',
    'email_provider_not_configured','unsupported_feedback_channel','delivery_completion_failed'
  ]::text[])
);

-- Keep the existing authorization/ownership contract and make scheduling part of
-- the same transaction as the resolved transition. company scope is always
-- derived from the locked conversation row; feedback config is a global template.
CREATE OR REPLACE FUNCTION public.set_conversation_resolution_tx(
  p_conversation_id uuid,
  p_company_id uuid,
  p_actor_user_id uuid,
  p_actor_agent_id uuid,
  p_target_state text,
  p_reason text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv record;
  v_agent record;
  v_role text;
  v_now timestamptz := now();
  v_reason text;
  v_scheduled integer := 0;
BEGIN
  IF p_target_state NOT IN ('resolved','unresolved') THEN
    RETURN jsonb_build_object('result','invalid_target_state');
  END IF;

  SELECT id,user_id,status INTO v_agent
  FROM public.agent_profile
  WHERE id=p_actor_agent_id AND user_id=p_actor_user_id;
  IF NOT FOUND OR v_agent.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('result','actor_not_found');
  END IF;

  SELECT cm.role INTO v_role
  FROM public.company_membership cm
  JOIN public.company co ON co.id=cm.company_id AND co.is_active=true
  WHERE cm.user_id=p_actor_user_id AND cm.company_id=p_company_id AND cm.is_active=true
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','tenant_forbidden');
  END IF;

  SELECT id,status,assigned_agent_id,company_id,visitor_session_id
  INTO v_conv
  FROM public.conversations
  WHERE id=p_conversation_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF v_conv.company_id IS DISTINCT FROM p_company_id THEN
    RETURN jsonb_build_object('result','tenant_forbidden');
  END IF;
  IF COALESCE(v_role,'') NOT IN ('admin','supervisor')
     AND v_conv.assigned_agent_id IS DISTINCT FROM p_actor_agent_id THEN
    RETURN jsonb_build_object('result','not_conversation_owner');
  END IF;

  -- Idempotent repeat: do not create a second request.
  IF v_conv.status IS NOT DISTINCT FROM p_target_state THEN
    RETURN jsonb_build_object(
      'result','already_in_state','conversation_id',p_conversation_id,
      'status',p_target_state,'feedback_scheduled',0
    );
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_reason,'')),'');
  IF v_reason IS NULL THEN
    v_reason := CASE p_target_state
      WHEN 'resolved' THEN 'Resolve conversation'
      ELSE 'Mark conversation unresolved'
    END;
  ELSE
    v_reason := left(v_reason,1000);
  END IF;

  UPDATE public.conversations
  SET status=p_target_state,updated_at=v_now
  WHERE id=p_conversation_id;

  INSERT INTO public.conversation_status_log(
    conversation_id,old_status,new_status,changed_by,changed_by_type,reason
  ) VALUES (
    p_conversation_id,v_conv.status,p_target_state,p_actor_agent_id,'agent',v_reason
  );

  INSERT INTO public.audit_log(actor_id,actor_type,action,resource_type,resource_id,diff)
  VALUES (
    p_actor_agent_id,'agent',
    CASE p_target_state WHEN 'resolved' THEN 'resolve_conversation' ELSE 'mark_unresolved' END,
    'conversations',p_conversation_id,
    jsonb_build_object(
      'company_id',p_company_id,'old_status',v_conv.status,'new_status',p_target_state,
      'assigned_agent_id',v_conv.assigned_agent_id,'reason',v_reason
    )
  );

  IF p_target_state='resolved' THEN
    -- The conversation row is already locked FOR UPDATE above. Competing resolve
    -- calls for this conversation therefore serialize, making this NOT EXISTS
    -- check + INSERT atomic without rewriting historical duplicate feedback rows.
    INSERT INTO public.feedback_request(
      conversation_id,visitor_session_id,request_type,status,scheduled_at,channel,
      rating_type,config_version_id,delivery_status,created_at,updated_at
    )
    SELECT
      p_conversation_id,
      v_conv.visitor_session_id,
      CASE WHEN COALESCE(cfg.config->>'rating_type','stars_1_5')='nps' THEN 'nps'
           WHEN COALESCE(cfg.config->>'rating_type','stars_1_5')='survey' THEN 'custom'
           ELSE 'csat' END,
      'pending',
      v_now + make_interval(mins => GREATEST(COALESCE(cfg.delay_minutes,0),0)),
      CASE
        WHEN COALESCE(cfg.config->'channels_enabled','[]'::jsonb) ? 'website_widget' THEN 'website_widget'
        WHEN jsonb_array_length(COALESCE(cfg.config->'channels_enabled','[]'::jsonb)) > 0
          THEN cfg.config->'channels_enabled'->>0
        ELSE 'website_widget'
      END,
      COALESCE(NULLIF(cfg.config->>'rating_type',''),'stars_1_5'),
      cfg.id,
      'pending',v_now,v_now
    FROM public.feedback_automation_config cfg
    WHERE cfg.is_active IS TRUE
      AND cfg.trigger_event='conversation_resolved'
      AND NOT EXISTS (
        SELECT 1
        FROM public.feedback_request existing
        WHERE existing.conversation_id=p_conversation_id
          AND existing.config_version_id=cfg.id
      );
    GET DIAGNOSTICS v_scheduled = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'result','success','conversation_id',p_conversation_id,
    'old_status',v_conv.status,'new_status',p_target_state,
    'feedback_scheduled',v_scheduled
  );
END
$function$;

-- Atomic worker claim. Stale token_generated claims are reclaimable after five minutes.
CREATE OR REPLACE FUNCTION public.claim_feedback_delivery_tx()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v record; v_now timestamptz := now();
BEGIN
  SELECT fr.id,fr.conversation_id,c.company_id,fr.channel,fr.rating_type
  INTO v
  FROM public.feedback_request fr
  JOIN public.conversations c ON c.id=fr.conversation_id
  WHERE fr.status='pending'
    AND COALESCE(fr.scheduled_at,fr.created_at) <= v_now
    AND (
      fr.delivery_status='pending' OR
      (fr.delivery_status='token_generated' AND fr.response_token_hash IS NULL
       AND fr.updated_at < v_now - interval '5 minutes')
    )
  ORDER BY COALESCE(fr.scheduled_at,fr.created_at),fr.created_at,fr.id
  FOR UPDATE OF fr SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN jsonb_build_object('result','none'); END IF;

  UPDATE public.feedback_request
  SET delivery_status='token_generated',delivery_error_type=NULL,updated_at=v_now
  WHERE id=v.id;

  RETURN jsonb_build_object(
    'result','claimed','feedback_request_id',v.id,'conversation_id',v.conversation_id,
    'company_id',v.company_id,'channel',v.channel,'rating_type',v.rating_type
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.finish_feedback_delivery_tx(
  p_feedback_request_id uuid,
  p_outcome text,
  p_delivery_error_type text DEFAULT NULL,
  p_token_hash text DEFAULT NULL,
  p_token_created_at timestamptz DEFAULT NULL,
  p_token_expires_at timestamptz DEFAULT NULL,
  p_sent_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v public.feedback_request%ROWTYPE; v_now timestamptz:=now();
BEGIN
  SELECT * INTO v FROM public.feedback_request WHERE id=p_feedback_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF v.status <> 'pending' THEN RETURN jsonb_build_object('result','request_not_pending'); END IF;
  IF v.delivery_status='sent' THEN RETURN jsonb_build_object('result','already_sent'); END IF;
  IF v.delivery_status <> 'token_generated' THEN RETURN jsonb_build_object('result','stale_claim'); END IF;

  IF p_outcome='failed' THEN
    UPDATE public.feedback_request SET delivery_status='delivery_failed',
      delivery_error_type=p_delivery_error_type,updated_at=v_now WHERE id=v.id;
  ELSIF p_outcome='pending' THEN
    UPDATE public.feedback_request SET delivery_status='pending',
      delivery_error_type=p_delivery_error_type,
      scheduled_at=GREATEST(COALESCE(scheduled_at,v_now),v_now + interval '1 hour'),
      updated_at=v_now WHERE id=v.id;
  ELSIF p_outcome='sent' THEN
    UPDATE public.feedback_request SET delivery_status='sent',response_token_hash=p_token_hash,
      token_created_at=p_token_created_at,token_expires_at=p_token_expires_at,
      sent_at=p_sent_at,delivery_error_type=NULL,updated_at=v_now WHERE id=v.id;
  ELSE
    RETURN jsonb_build_object('result','invalid_outcome');
  END IF;
  RETURN jsonb_build_object('result','success');
END
$function$;

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
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v record;
BEGIN
  SELECT fr.*,c.company_id AS canonical_company_id
  INTO v
  FROM public.feedback_request fr
  JOIN public.conversations c ON c.id=fr.conversation_id
  WHERE fr.id=p_feedback_request_id
  FOR UPDATE OF fr;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF v.conversation_id IS DISTINCT FROM p_conversation_id
     OR v.canonical_company_id IS DISTINCT FROM p_company_id THEN
    RETURN jsonb_build_object('result','tenant_scope_mismatch');
  END IF;
  IF v.status <> 'pending' THEN RETURN jsonb_build_object('result','request_not_pending'); END IF;
  IF v.delivery_status='sent' OR v.sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('result','already_sent');
  END IF;
  IF v.delivery_status <> 'token_generated' THEN RETURN jsonb_build_object('result','stale_claim'); END IF;
  IF p_token_hash IS NULL OR length(p_token_hash)<>64 OR p_token_expires_at<=p_token_created_at THEN
    RETURN jsonb_build_object('result','invalid_token_state');
  END IF;

  INSERT INTO public.messages(conversation_id,role,content,content_type,status,metadata)
  VALUES (
    p_conversation_id,'assistant',
    'Please rate your recent support experience: ' || p_feedback_link,
    'text','delivered',
    jsonb_build_object(
      'response_route','feedback_request','feedback_request_id',p_feedback_request_id,
      'rating_type',p_rating_type,'contract_version',p_contract_version
    )
  );

  UPDATE public.feedback_request
  SET response_token_hash=p_token_hash,token_created_at=p_token_created_at,
      token_expires_at=p_token_expires_at,sent_at=p_sent_at,
      delivery_status='sent',delivery_error_type=NULL,updated_at=now()
  WHERE id=p_feedback_request_id;

  RETURN jsonb_build_object('result','success');
END
$function$;

-- Token-only public submission, atomically one response. No caller tenant identifiers.
CREATE OR REPLACE FUNCTION public.submit_feedback_response_tx(
  p_token_hash text,
  p_rating integer,
  p_feedback_text text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v public.feedback_request%ROWTYPE; v_now timestamptz:=now(); v_text text;
BEGIN
  SELECT * INTO v FROM public.feedback_request
  WHERE response_token_hash=p_token_hash FOR UPDATE;
  IF NOT FOUND OR v.status<>'pending' OR v.token_used_at IS NOT NULL
     OR v.token_expires_at IS NULL OR v.token_expires_at < v_now
     OR v.delivery_status<>'sent' THEN
    RETURN jsonb_build_object('result','invalid_or_expired_token');
  END IF;

  IF NOT (
    (v.rating_type='nps' AND p_rating BETWEEN 0 AND 10) OR
    (v.rating_type='ces' AND p_rating BETWEEN 1 AND 7) OR
    (v.rating_type IN ('stars_1_5','csat','survey') AND p_rating BETWEEN 1 AND 5) OR
    (v.rating_type='thumbs' AND p_rating BETWEEN 0 AND 1)
  ) THEN RETURN jsonb_build_object('result','invalid_rating'); END IF;

  v_text := NULLIF(btrim(COALESCE(p_feedback_text,'')),'');
  IF v_text IS NOT NULL THEN v_text := left(v_text,2000); END IF;

  UPDATE public.feedback_request
  SET rating=p_rating,feedback_text=v_text,responded_at=v_now,status='responded',
      token_used_at=v_now,updated_at=v_now
  WHERE id=v.id;

  RETURN jsonb_build_object('result','success','feedback_request_id',v.id);
END
$function$;

REVOKE ALL ON FUNCTION public.claim_feedback_delivery_tx() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_feedback_delivery_tx(uuid,text,text,text,timestamptz,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_widget_feedback_delivery_tx(uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_feedback_response_tx(text,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_feedback_delivery_tx() TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_feedback_delivery_tx(uuid,text,text,text,timestamptz,timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_widget_feedback_delivery_tx(uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_feedback_response_tx(text,integer,text) TO service_role;
