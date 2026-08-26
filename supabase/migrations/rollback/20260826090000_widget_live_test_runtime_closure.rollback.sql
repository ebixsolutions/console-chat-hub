-- Exact rollback to the pre-Task-1.1 production definitions captured read-only on 2026-08-26.

CREATE OR REPLACE FUNCTION public._ce_enforce_conversation_company()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$ BEGIN IF NEW.company_id IS NULL THEN SELECT cc.company_id INTO NEW.company_id FROM public.channel_config cc WHERE cc.id = NEW.channel_config_id; END IF; IF NEW.company_id IS NULL THEN RAISE EXCEPTION 'TENANT_UNRESOLVED: conversation requires company_id (channel_config %)', NEW.channel_config_id USING ERRCODE = 'check_violation'; END IF; IF TG_OP = 'UPDATE' AND OLD.company_id IS NOT NULL AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN RAISE EXCEPTION 'TENANT_REASSIGNMENT: conversation company_id cannot change from % to %', OLD.company_id, NEW.company_id USING ERRCODE = 'check_violation'; END IF; IF NEW.channel_config_id IS NOT NULL THEN IF EXISTS (SELECT 1 FROM public.channel_config cc WHERE cc.id = NEW.channel_config_id AND cc.company_id IS NOT NULL AND cc.company_id IS DISTINCT FROM NEW.company_id) THEN RAISE EXCEPTION 'TENANT_CHANNEL_MISMATCH: conversation.company_id % vs channel_config.company_id', NEW.company_id USING ERRCODE = 'check_violation'; END IF; END IF; RETURN NEW; END $function$;

CREATE OR REPLACE FUNCTION public.ce_mark_evaluation_dirty(p_conversation_id uuid, p_activity_at timestamp with time zone DEFAULT now())
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_company uuid;
BEGIN
  IF p_conversation_id IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = p_conversation_id) THEN RETURN; END IF;
  v_company := public.ce_runtime_conversation_company(p_conversation_id);
  INSERT INTO public.ce_evaluation_state (conversation_id,company_id,state,revision,dirty_since,last_activity_at,updated_at)
  VALUES (p_conversation_id,v_company,'never_evaluated',1,now(),COALESCE(p_activity_at, now()),now())
  ON CONFLICT (conversation_id) DO UPDATE SET
    company_id = EXCLUDED.company_id,
    revision = public.ce_evaluation_state.revision + 1,
    state = CASE WHEN public.ce_evaluation_state.last_success_evaluation_id IS NULL THEN 'never_evaluated' ELSE 'dirty' END,
    dirty_since = COALESCE(public.ce_evaluation_state.dirty_since, now()),
    last_activity_at = GREATEST(COALESCE(public.ce_evaluation_state.last_activity_at, '-infinity'::timestamptz),COALESCE(EXCLUDED.last_activity_at, now())),
    queued_at = NULL,
    evaluating_started_at = NULL,
    last_error_code = NULL,
    updated_at = now();
END
$function$;

CREATE OR REPLACE FUNCTION public.ce_conversation_evaluable_v1(p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;
