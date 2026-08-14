-- PR7 Workflow 3 / Task 3.3 — tenant ownership consistency closure
-- SOURCE-ONLY. No production apply without explicit authorization.
BEGIN;
SET LOCAL lock_timeout='10s';

CREATE OR REPLACE FUNCTION public.pr7_guard_conversation_tenant_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_channel_company uuid;
  v_visitor_channel uuid;
  v_visitor_company uuid;
BEGIN
  IF NEW.channel_config_id IS NOT NULL THEN
    SELECT company_id INTO v_channel_company
    FROM public.channel_config
    WHERE id=NEW.channel_config_id;
    IF NOT FOUND OR v_channel_company IS NULL THEN
      RAISE EXCEPTION 'TENANT_LINEAGE_CHANNEL_UNRESOLVED';
    END IF;
    IF NEW.company_id IS NULL OR NEW.company_id<>v_channel_company THEN
      RAISE EXCEPTION 'TENANT_LINEAGE_CONVERSATION_CHANNEL_MISMATCH';
    END IF;
  END IF;

  IF NEW.visitor_session_id IS NOT NULL THEN
    SELECT vs.channel_config_id, ch.company_id
      INTO v_visitor_channel,v_visitor_company
    FROM public.visitor_session vs
    LEFT JOIN public.channel_config ch ON ch.id=vs.channel_config_id
    WHERE vs.id=NEW.visitor_session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'TENANT_LINEAGE_VISITOR_SESSION_MISSING';
    END IF;

    IF NEW.channel_config_id IS NOT NULL
       AND v_visitor_channel IS NOT NULL
       AND NEW.channel_config_id<>v_visitor_channel THEN
      RAISE EXCEPTION 'TENANT_LINEAGE_CONVERSATION_VISITOR_CHANNEL_MISMATCH';
    END IF;

    IF v_visitor_company IS NOT NULL
       AND NEW.company_id IS DISTINCT FROM v_visitor_company THEN
      RAISE EXCEPTION 'TENANT_LINEAGE_CONVERSATION_VISITOR_COMPANY_MISMATCH';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.pr7_guard_feedback_tenant_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_conv_session uuid;
BEGIN
  SELECT visitor_session_id INTO v_conv_session
  FROM public.conversations
  WHERE id=NEW.conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_LINEAGE_FEEDBACK_CONVERSATION_MISSING';
  END IF;

  IF NEW.visitor_session_id IS NOT NULL
     AND v_conv_session IS DISTINCT FROM NEW.visitor_session_id THEN
    RAISE EXCEPTION 'TENANT_LINEAGE_FEEDBACK_VISITOR_MISMATCH';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pr7_conversation_tenant_lineage ON public.conversations;
CREATE TRIGGER trg_pr7_conversation_tenant_lineage
BEFORE INSERT OR UPDATE OF company_id,channel_config_id,visitor_session_id
ON public.conversations
FOR EACH ROW EXECUTE FUNCTION public.pr7_guard_conversation_tenant_lineage();

DROP TRIGGER IF EXISTS trg_pr7_feedback_tenant_lineage ON public.feedback_request;
CREATE TRIGGER trg_pr7_feedback_tenant_lineage
BEFORE INSERT OR UPDATE OF conversation_id,visitor_session_id
ON public.feedback_request
FOR EACH ROW EXECUTE FUNCTION public.pr7_guard_feedback_tenant_lineage();

ALTER FUNCTION public.pr7_guard_conversation_tenant_lineage() OWNER TO postgres;
ALTER FUNCTION public.pr7_guard_feedback_tenant_lineage() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.pr7_guard_conversation_tenant_lineage() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pr7_guard_feedback_tenant_lineage() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pr7_guard_conversation_tenant_lineage() TO service_role;
GRANT EXECUTE ON FUNCTION public.pr7_guard_feedback_tenant_lineage() TO service_role;

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.channel_config ch ON ch.id=c.channel_config_id
    WHERE c.company_id IS DISTINCT FROM ch.company_id
  ) THEN
    RAISE EXCEPTION 'ASSERT: conversation/channel company mismatch exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.visitor_session vs ON vs.id=c.visitor_session_id
    WHERE c.channel_config_id IS NOT NULL
      AND vs.channel_config_id IS NOT NULL
      AND c.channel_config_id<>vs.channel_config_id
  ) THEN
    RAISE EXCEPTION 'ASSERT: conversation/visitor channel mismatch exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.feedback_request fr
    JOIN public.conversations c ON c.id=fr.conversation_id
    WHERE fr.visitor_session_id IS NOT NULL
      AND c.visitor_session_id IS DISTINCT FROM fr.visitor_session_id
  ) THEN
    RAISE EXCEPTION 'ASSERT: feedback/conversation visitor mismatch exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.upstream_call_log u
    JOIN public.conversations c ON c.id=u.conversation_id
    WHERE u.company_id IS DISTINCT FROM c.company_id
  ) THEN
    RAISE EXCEPTION 'ASSERT: upstream/conversation company mismatch exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversation_evaluation e
    JOIN public.conversations c ON c.id=e.conversation_id
    WHERE e.company_id IS DISTINCT FROM c.company_id
  ) OR EXISTS (
    SELECT 1
    FROM public.conversation_evaluation_attempt a
    JOIN public.conversations c ON c.id=a.conversation_id
    WHERE a.company_id IS DISTINCT FROM c.company_id
  ) THEN
    RAISE EXCEPTION 'ASSERT: CE/conversation company mismatch exists';
  END IF;
END
$assert$;

COMMIT;
