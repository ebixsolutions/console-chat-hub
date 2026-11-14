-- PROPOSAL ONLY. Fresh after-function identity and unchanged C2 guard required.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('C3-F13-F14-handoff-projection'));
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.c3_enrich_handoff_from_memory_tg()'::regprocedure)) IS DISTINCT FROM 'd35510ba36aa9cd2e4131fc58eeb27b9' OR md5(pg_get_functiondef('public.c2_populate_handoff_package_tg()'::regprocedure)) IS DISTINCT FROM 'dd75815a825051d7c42d7f9480b6fc0b' THEN RAISE EXCEPTION 'Later change: rollback refused'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.c3_enrich_handoff_from_memory_tg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_outer jsonb;
  v_package jsonb;
  v_memory record;
  v_company_id uuid;
BEGIN
  IF NEW.handoff_type IS DISTINCT FROM 'ai_to_agent' OR NEW.ai_summary IS NULL THEN RETURN NEW; END IF;
  BEGIN v_outer := NEW.ai_summary::jsonb; EXCEPTION WHEN others THEN RETURN NEW; END;
  IF v_outer->>'schema_version' IS DISTINCT FROM 'c2-handoff-1.0.0' THEN RETURN NEW; END IF;
  v_package := v_outer->'structured_package';
  SELECT c.company_id INTO v_company_id FROM public.conversations c WHERE c.id=NEW.conversation_id;
  SELECT m.memory, m.markdown_projection, m.source_message_id, m.commerce_state_revision
    INTO v_memory FROM public.conversation_memory_state m
   WHERE m.conversation_id=NEW.conversation_id AND m.company_id=v_company_id;
  IF NOT FOUND OR v_memory.memory->>'conversation_id' IS DISTINCT FROM NEW.conversation_id::text
     OR v_memory.memory->>'company_id' IS DISTINCT FROM v_company_id::text
     OR v_memory.source_message_id IS DISTINCT FROM (v_package->>'generated_from_source_message_id')::uuid
  THEN RETURN NEW; END IF;
  IF v_package->>'commerce_state_revision' IS NOT NULL
     AND v_memory.commerce_state_revision IS DISTINCT FROM (v_package->>'commerce_state_revision')::bigint THEN RETURN NEW; END IF;
  v_package := jsonb_set(v_package,'{customer_preferences}',coalesce(v_memory.memory->'customer_preferences','[]'::jsonb),true);
  IF jsonb_array_length(coalesce(v_package->'open_questions','[]'::jsonb))=0 THEN
    v_package := jsonb_set(v_package,'{open_questions}',coalesce(v_memory.memory->'open_questions','[]'::jsonb),true);
  END IF;
  IF jsonb_array_length(coalesce(v_package->'pending_actions','[]'::jsonb))=0 THEN
    v_package := jsonb_set(v_package,'{pending_actions}',coalesce(v_memory.memory->'pending_actions','[]'::jsonb),true);
  END IF;
  v_package := jsonb_set(v_package,'{conversation_memory_lineage}',jsonb_build_object(
    'version',v_memory.memory->>'version','memory_revision',v_memory.memory->'memory_revision',
    'source_message_id',v_memory.source_message_id,'commerce_state_revision',v_memory.commerce_state_revision
  ),true);
  NEW.ai_summary := jsonb_set(v_outer,'{structured_package}',v_package,true)::text;
  RETURN NEW;
END;
$function$;

COMMIT;
