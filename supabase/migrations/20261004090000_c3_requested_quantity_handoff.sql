-- Scoped F0/F4 projection repair; existing authorization, lineage and trigger bindings unchanged.
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
  v_kb_facts jsonb;
  v_citations jsonb;
  v_state_text text;
  v_corrections_text text;
  v_pending_text text;
  v_summary text;
  v_next_action text;
  v_booking jsonb;
  v_entity_group text;
  v_entities jsonb;
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
  v_package := jsonb_set(v_package,'{open_questions}',coalesce(v_memory.memory->'open_questions','[]'::jsonb),true);
  v_package := jsonb_set(v_package,'{pending_actions}',coalesce(v_memory.memory->'pending_actions','[]'::jsonb),true);
  v_package := jsonb_set(v_package,'{current_customer_goal}',coalesce(v_memory.memory->'current_goal','null'::jsonb),true);
  v_package := jsonb_set(v_package,'{current_customer_facts}',coalesce(v_memory.memory->'current_customer_facts','[]'::jsonb),true);
  v_package := jsonb_set(v_package,'{historical_customer_facts}',coalesce(v_memory.memory->'historical_facts','[]'::jsonb),true);
  v_package := jsonb_set(v_package,'{question_lifecycle}',coalesce(v_memory.memory->'question_lifecycle','[]'::jsonb),true);
  v_package := jsonb_set(v_package,'{conversation_memory_lineage}',jsonb_build_object(
    'version',v_memory.memory->>'version','memory_revision',v_memory.memory->'memory_revision',
    'source_message_id',v_memory.source_message_id,'commerce_state_revision',v_memory.commerce_state_revision
  ),true);
  -- Only persisted, B2-committed structured KB facts with matching citations.
  -- Never promote transcript text, customer assumptions, or historical answers.
  WITH eligible AS (
    SELECT m.id, m.created_at, m.metadata, f.fact
    FROM public.messages m
    CROSS JOIN LATERAL jsonb_array_elements(CASE
      WHEN jsonb_typeof(m.metadata->'authoritative_kb_facts')='array'
      THEN m.metadata->'authoritative_kb_facts' ELSE '[]'::jsonb END) f(fact)
    WHERE m.conversation_id=NEW.conversation_id AND m.role='assistant'
      AND NOT coalesce(m.is_recalled,false)
      AND m.metadata->>'control_commit'='ai'
      AND m.metadata->>'b2_gate_contract'='executeB2PersistenceGate:allow_after_revalidation'
      AND m.metadata->>'b2_expected_company_id'=v_company_id::text
      AND m.metadata->'citation_lineage'->>'authority_decision'='USE_CURRENT_KB'
      AND m.metadata->'citation_lineage'->>'evidence_state'='current'
      AND f.fact->>'authority'='CURRENT_KB'
      AND f.fact->>'currentness_at_answer'='current'
      AND f.fact->>'tenant_id'=m.metadata->'reference_authority'->'provenance'->>'tenant_id'
      AND f.fact->>'document_id'=m.metadata->'citation_lineage'->>'selected_document_id'
      AND m.metadata->'citation_lineage'->'evidence_chunk_ids' ? (f.fact->>'chunk_id')
      AND f.fact->>'source_message_id'=m.metadata->>'source_message_id'
      AND EXISTS (SELECT 1 FROM public.messages s WHERE s.conversation_id=NEW.conversation_id
        AND s.role='visitor' AND s.id::text=f.fact->>'source_message_id')
  ), latest AS (
    SELECT DISTINCT ON (fact->>'model',fact->>'field') fact, metadata,created_at,id
    FROM eligible ORDER BY fact->>'model',fact->>'field',created_at DESC,id DESC
  ), bounded AS (SELECT * FROM latest ORDER BY created_at DESC,id DESC LIMIT 30)
  SELECT coalesce(jsonb_agg(fact),'[]'::jsonb),
    coalesce((SELECT jsonb_agg(DISTINCT c.citation) FROM bounded b
      CROSS JOIN LATERAL jsonb_array_elements(b.metadata->'citations') c(citation)
      WHERE c.citation->>'document_id'=b.fact->>'document_id'
        AND c.citation->>'chunk_id'=b.fact->>'chunk_id'),'[]'::jsonb)
    INTO v_kb_facts,v_citations FROM bounded;
  v_package := jsonb_set(v_package,'{current_authoritative_kb_facts}',v_kb_facts,true);
  v_package := jsonb_set(v_package,'{citations}',v_citations,true);
  -- Project only customer-requested quantity. Preserve canonical container count separately.
  FOR v_entity_group IN SELECT unnest(ARRAY['active_entities','deferred_entities','cancelled_entities']) LOOP
    SELECT coalesce(jsonb_agg(CASE WHEN e->'attributes'->>'quantity_basis'='system_default'
      THEN jsonb_set(jsonb_set(e,'{container_quantity}',e->'quantity',true),'{quantity}','null'::jsonb,true)
      ELSE e END),'[]'::jsonb) INTO v_entities
    FROM jsonb_array_elements(coalesce(v_package->v_entity_group,'[]'::jsonb)) e;
    v_package := jsonb_set(v_package,ARRAY[v_entity_group],v_entities,true);
  END LOOP;
  -- One final authority feeds both machine and human views. R1 text remains separate.
  v_package := jsonb_set(v_package,'{latest_corrections}',coalesce(v_memory.memory->'latest_corrections','[]'::jsonb),true);
  SELECT string_agg('- ' || group_name || ': ' ||
    coalesce(entity->'attributes'->>'product_name',entity->>'model',entity->>'category','Item') ||
    ', ' || CASE WHEN entity->'attributes'->>'quantity_basis'='system_default' THEN 'quantity not yet confirmed' ELSE coalesce(entity->>'quantity','0') || ' ' || coalesce(entity->'attributes'->>'unit','units') END ||
    CASE WHEN entity->'attributes'->>'requested_date' IS NOT NULL THEN ', requested date ' || (entity->'attributes'->>'requested_date') ELSE '' END,
    E'\n' ORDER BY group_name,entity->>'entity_id') INTO v_state_text
  FROM (SELECT 'Active' AS group_name,e AS entity FROM jsonb_array_elements(coalesce(v_package->'active_entities','[]'::jsonb)) e
    UNION ALL SELECT 'Deferred',e FROM jsonb_array_elements(coalesce(v_package->'deferred_entities','[]'::jsonb)) e
    UNION ALL SELECT 'Cancelled',e FROM jsonb_array_elements(coalesce(v_package->'cancelled_entities','[]'::jsonb)) e) entities;
  SELECT string_agg('- ' || correction,E'\n' ORDER BY n) INTO v_corrections_text
    FROM jsonb_array_elements_text(coalesce(v_package->'latest_corrections','[]'::jsonb)) WITH ORDINALITY x(correction,n);
  SELECT string_agg('- ' || item,E'\n' ORDER BY item) INTO v_pending_text
    FROM (SELECT DISTINCT item FROM jsonb_array_elements_text(coalesce(v_package->'open_questions','[]'::jsonb) || coalesce(v_package->'pending_actions','[]'::jsonb)) x(item)) pending;
  -- The final package owns next-action priority; never reuse a pre-enrichment fallback.
  IF jsonb_array_length(coalesce(v_package->'safety_or_professional_requirements','[]'::jsonb))>0 THEN
    SELECT 'Address the safety/professional requirement: ' || string_agg(item,'; ' ORDER BY n)
      INTO v_next_action FROM jsonb_array_elements_text(v_package->'safety_or_professional_requirements') WITH ORDINALITY x(item,n);
  ELSIF jsonb_array_length(coalesce(v_package->'pending_actions','[]'::jsonb))>0 THEN
    SELECT e INTO v_booking FROM jsonb_array_elements(coalesce(v_package->'active_entities','[]'::jsonb)) e
      WHERE e->'attributes'->'capabilities'->>'requires_booking'='true'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_package->'pending_actions') x(action)
          WHERE position(coalesce(e->'attributes'->>'product_name',e->>'model',e->>'category') IN action)>0
            AND action ILIKE '%staff confirmation%')
      ORDER BY e->>'entity_id' LIMIT 1;
    IF v_booking IS NOT NULL THEN
      v_next_action := 'Confirm the requested ' || coalesce(v_booking->'attributes'->>'product_name',v_booking->>'model',v_booking->>'category') ||
        ' details with staff (' || coalesce(v_booking->>'quantity','0') || ' ' || coalesce(v_booking->'attributes'->>'unit','sessions') ||
        CASE WHEN v_booking->'attributes'->>'requested_date' IS NOT NULL THEN ', requested date ' || (v_booking->'attributes'->>'requested_date') ELSE '' END ||
        ') before marking the booking confirmed.';
    ELSE
      SELECT 'Confirm: ' || string_agg(item,'; ' ORDER BY n) INTO v_next_action
        FROM jsonb_array_elements_text(v_package->'pending_actions') WITH ORDINALITY x(item,n);
    END IF;
  ELSIF jsonb_array_length(coalesce(v_package->'open_questions','[]'::jsonb))>0 THEN
    SELECT 'Resolve the outstanding question: ' || string_agg(item,'; ' ORDER BY n) INTO v_next_action
      FROM jsonb_array_elements_text(v_package->'open_questions') WITH ORDINALITY x(item,n);
  ELSE
    SELECT e INTO v_booking FROM jsonb_array_elements(coalesce(v_package->'active_entities','[]'::jsonb)) e
      WHERE e->'attributes'->'capabilities'->>'requires_booking'='true' AND e->>'status' IS DISTINCT FROM 'confirmed'
      ORDER BY e->>'entity_id' LIMIT 1;
    IF v_booking IS NOT NULL THEN
      v_next_action := 'Confirm the requested ' || coalesce(v_booking->'attributes'->>'product_name',v_booking->>'model',v_booking->>'category') ||
        ' booking details with staff before marking the booking confirmed.';
    ELSIF v_package->'transaction_state'->>'quotation'='draft' OR v_package->'transaction_state'->>'order' IN ('draft','pending')
      OR v_package->'transaction_state'->>'payment'='pending' THEN
      v_next_action := 'Verify the pending transaction details and customer authorization before progressing any quotation, order or payment.';
    ELSE
      v_next_action := 'Review the current request and confirm the next authorized action.';
    END IF;
  END IF;
  v_package := jsonb_set(v_package,'{recommended_next_human_action}',to_jsonb(v_next_action),true);
  v_summary := concat_ws(E'\n',
    '### Customer Goal',coalesce(v_package->>'current_customer_goal','No business request captured before handoff.'),'',
    '### Current State',coalesce(v_state_text,'- —'),
    '- Quotation: ' || coalesce(v_package->'transaction_state'->>'quotation','unknown'),
    '- Order: ' || coalesce(v_package->'transaction_state'->>'order','unknown'),
    '- Payment: ' || coalesce(v_package->'transaction_state'->>'payment','unknown'),
    '- Delivery: ' || coalesce(v_package->'transaction_state'->>'delivery','unknown'),
    '- Installation: ' || coalesce(v_package->'transaction_state'->>'installation','unknown'),'',
    '### Latest Correction',coalesce(v_corrections_text,'- —'),'',
    '### Pending',coalesce(v_pending_text,'- —'),'',
    '### Handoff Reason',v_package->>'handoff_reason','',
    '### Handoff Request',v_package->>'handoff_request_text','',
    '### Recommended Next Action',v_package->>'recommended_next_human_action');
  NEW.ai_summary := jsonb_set(jsonb_set(v_outer,'{structured_package}',v_package,true),'{summary_markdown}',to_jsonb(v_summary),true)::text;
  RETURN NEW;
END;
$function$
