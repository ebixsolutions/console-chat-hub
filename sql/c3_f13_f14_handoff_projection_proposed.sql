-- PROPOSAL ONLY. No production application authorized by F13/F14 source scope.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('C3-F13-F14-handoff-projection'));
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.c3_enrich_handoff_from_memory_tg()'::regprocedure))
      IS DISTINCT FROM 'a44aa47ee66fd7ec5b79b4c8731816c2'
 OR md5(pg_get_functiondef('public.c2_populate_handoff_package_tg()'::regprocedure))
      IS DISTINCT FROM 'dd75815a825051d7c42d7f9480b6fc0b' THEN
   RAISE EXCEPTION 'C3 F13/F14 live baseline drift; no change applied';
 END IF;
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
  v_field text;
  v_fact_lines text;
  v_corrections text;
  v_pending text;
BEGIN
  IF NEW.handoff_type IS DISTINCT FROM 'ai_to_agent' OR NEW.ai_summary IS NULL THEN RETURN NEW; END IF;
  BEGIN v_outer := NEW.ai_summary::jsonb; EXCEPTION WHEN others THEN RETURN NEW; END;
  IF v_outer->>'schema_version' IS DISTINCT FROM 'c2-handoff-1.0.0' THEN RETURN NEW; END IF;
  v_package := v_outer->'structured_package';
  IF v_package->>'schema_version' IS DISTINCT FROM 'c2-handoff-1.0.0'
     OR v_package->>'conversation_id' IS DISTINCT FROM NEW.conversation_id::text THEN RETURN NEW; END IF;
  SELECT c.company_id INTO v_company_id FROM public.conversations c WHERE c.id=NEW.conversation_id;
  SELECT m.memory, m.markdown_projection, m.source_message_id, m.commerce_state_revision, m.revision
    INTO v_memory FROM public.conversation_memory_state m
   WHERE m.conversation_id=NEW.conversation_id AND m.company_id=v_company_id FOR SHARE;
  IF NOT FOUND OR v_memory.memory->>'conversation_id' IS DISTINCT FROM NEW.conversation_id::text
     OR v_memory.memory->>'company_id' IS DISTINCT FROM v_company_id::text
     OR v_memory.source_message_id IS DISTINCT FROM (v_package->>'generated_from_source_message_id')::uuid
  THEN RETURN NEW; END IF;
  IF v_package->>'commerce_state_revision' IS NOT NULL
     AND v_memory.commerce_state_revision IS DISTINCT FROM (v_package->>'commerce_state_revision')::bigint THEN RETURN NEW; END IF;
  IF v_package->>'company_id' IS DISTINCT FROM v_company_id::text
     OR v_memory.memory->>'source_message_id' IS DISTINCT FROM v_memory.source_message_id::text
     OR v_memory.memory->>'memory_revision' IS DISTINCT FROM v_memory.revision::text
     OR v_memory.memory->>'commerce_state_revision' IS DISTINCT FROM v_memory.commerce_state_revision::text
     OR NOT EXISTS (SELECT 1 FROM public.conversation_commerce_state c
       WHERE c.conversation_id=NEW.conversation_id AND c.company_id=v_company_id
         AND c.revision=v_memory.commerce_state_revision)
     OR NOT EXISTS (SELECT 1 FROM public.messages s WHERE s.id=v_memory.source_message_id
       AND s.conversation_id=NEW.conversation_id AND s.role='visitor')
     OR jsonb_typeof(v_memory.memory->'current_customer_facts') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_memory.memory->'current_customer_facts') f
       WHERE f->>'authority' NOT IN ('customer','canonical_commerce')
         OR f->>'authority' IS NULL OR NOT (f ? 'value')
         OR NOT EXISTS (SELECT 1 FROM public.messages s WHERE s.id::text=f->>'source_message_id'
           AND s.conversation_id=NEW.conversation_id AND s.role='visitor'))
  THEN RETURN NEW; END IF;
  -- Same committed snapshot. Customer assertions never become merchant/KB facts.
  FOREACH v_field IN ARRAY ARRAY['customer_preferences','open_questions','pending_actions',
      'current_customer_facts','latest_corrections','question_lifecycle'] LOOP
    v_package := jsonb_set(v_package,ARRAY[v_field],coalesce(v_memory.memory->v_field,'[]'::jsonb),true);
  END LOOP;
  v_package := jsonb_set(v_package,'{current_customer_goal}',coalesce(v_memory.memory->'current_goal','null'::jsonb),true);
  v_package := jsonb_set(v_package,'{historical_customer_facts}',coalesce(v_memory.memory->'historical_facts','[]'::jsonb),true);
  v_package := jsonb_set(v_package,'{superseded_customer_facts}',coalesce(v_memory.memory->'cancelled_or_superseded','[]'::jsonb),true);
  v_package := jsonb_set(v_package,'{confirmed_facts}',coalesce(v_package->'confirmed_facts','[]'::jsonb) ||
    (SELECT coalesce(jsonb_agg(f || jsonb_build_object('source','canonical_customer_memory','verification','customer_provided_not_merchant_verified')),'[]'::jsonb)
       FROM jsonb_array_elements(v_memory.memory->'current_customer_facts') f),true);
  v_package := jsonb_set(v_package,'{conversation_memory_lineage}',jsonb_build_object(
    'version',v_memory.memory->>'version','memory_revision',v_memory.memory->'memory_revision',
    'source_message_id',v_memory.source_message_id,'commerce_state_revision',v_memory.commerce_state_revision
  ),true);
  SELECT string_agg('- ' || (f->>'key') || ': ' || (f->'value')::text ||
    ' [customer-provided; source ' || (f->>'source_message_id') || ']',E'\n' ORDER BY n)
    INTO v_fact_lines FROM jsonb_array_elements(v_package->'current_customer_facts') WITH ORDINALITY x(f,n);
  SELECT string_agg('- ' || x,E'\n' ORDER BY n) INTO v_corrections
    FROM jsonb_array_elements_text(v_package->'latest_corrections') WITH ORDINALITY y(x,n);
  SELECT string_agg('- ' || x,E'\n' ORDER BY n) INTO v_pending
    FROM jsonb_array_elements_text(v_package->'open_questions' || v_package->'pending_actions') WITH ORDINALITY y(x,n);
  v_package := jsonb_set(v_package,'{recommended_next_human_action}',to_jsonb(CASE
    WHEN jsonb_array_length(coalesce(v_package->'safety_or_professional_requirements','[]'::jsonb))>0
      THEN 'Address the recorded safety/professional requirements before progressing the request.'
    WHEN v_pending IS NOT NULL THEN 'Resolve the recorded outstanding follow-up: ' || v_pending
    ELSE 'Review the latest customer-provided requirements and verify any unknown merchant or transaction facts before the next authorized action.'
  END),true);
  v_outer := jsonb_set(v_outer,'{summary_markdown}',to_jsonb(concat_ws(E'\n',
    '### Customer Goal',coalesce(v_package->>'current_customer_goal','Unknown'),
    '### Customer-provided Current Facts (not merchant verification)',coalesce(v_fact_lines,'- Unknown'),
    '### Latest Corrections',coalesce(v_corrections,'- None'),
    '### Outstanding Follow-up',coalesce(v_pending,'- None'),
    '### Transaction State',(v_package->'transaction_state')::text,
    '### Safety / Professional Requirements',(v_package->'safety_or_professional_requirements')::text,
    '### Handoff Reason',NEW.handoff_reason,
    '### Recommended Next Action',v_package->>'recommended_next_human_action')),true);
  NEW.ai_summary := jsonb_set(v_outer,'{structured_package}',v_package,true)::text;
  RETURN NEW;
END;
$function$

COMMIT;
