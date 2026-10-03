-- SOURCE ONLY. Requires new exact candidate deployment authorization.
-- Preserve c2 owner/security/trigger binding, commit_ai_reply_tx, RLS and ledger.
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
  -- One final authority feeds both machine and human views. R1 text remains separate.
  v_package := jsonb_set(v_package,'{latest_corrections}',coalesce(v_memory.memory->'latest_corrections','[]'::jsonb),true);
  SELECT string_agg('- ' || group_name || ': ' ||
    coalesce(entity->'attributes'->>'product_name',entity->>'model',entity->>'category','Item') ||
    ', ' || coalesce(entity->>'quantity','0') || ' ' || coalesce(entity->'attributes'->>'unit','units') ||
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
$function$;

REVOKE ALL ON FUNCTION public.c3_enrich_handoff_from_memory_tg()
  FROM PUBLIC, anon, authenticated, service_role;

-- Extend the existing Memory authority only for post-delivery question reconciliation.
CREATE OR REPLACE FUNCTION public.c3_commit_conversation_memory_tx(
  p_conversation_id uuid,
  p_company_id uuid,
  p_source_message_id uuid,
  p_expected_commerce_revision bigint,
  p_expected_memory_revision bigint,
  p_memory jsonb,
  p_markdown_projection text,
  p_updated_from_turn bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_conversation_company uuid;
  v_latest_source_id uuid;
  v_source record;
  v_commerce_revision bigint;
  v_existing public.conversation_memory_state%rowtype;
  v_receipt public.conversation_memory_state_event%rowtype;
  v_hash text;
  v_revision bigint;
  v_reply public.messages%rowtype;
BEGIN
  IF p_conversation_id IS NULL OR p_company_id IS NULL OR p_source_message_id IS NULL
     OR p_expected_memory_revision IS NULL OR p_expected_memory_revision < 0
     OR p_updated_from_turn IS NULL OR p_updated_from_turn < 0
     OR p_memory IS NULL OR jsonb_typeof(p_memory) IS DISTINCT FROM 'object'
     OR p_memory->>'version' IS DISTINCT FROM 'conversation-memory-1.0.0'
     OR p_markdown_projection IS NULL OR octet_length(p_markdown_projection) > 32768
     OR octet_length(p_memory::text) > 65536 THEN
    RETURN jsonb_build_object('result','invalid_input');
  END IF;

  SELECT c.company_id INTO v_conversation_company
  FROM public.conversations c WHERE c.id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','conversation_not_found'); END IF;
  IF v_conversation_company IS NULL THEN RETURN jsonb_build_object('result','conversation_company_unresolved'); END IF;
  IF v_conversation_company IS DISTINCT FROM p_company_id THEN RETURN jsonb_build_object('result','tenant_mismatch'); END IF;

  SELECT m.conversation_id, m.role, m.is_recalled, m.created_at INTO v_source
  FROM public.messages m WHERE m.id = p_source_message_id FOR SHARE;
  IF NOT FOUND OR v_source.conversation_id IS DISTINCT FROM p_conversation_id
     OR lower(coalesce(v_source.role,'')) NOT IN ('visitor','customer','user')
     OR coalesce(v_source.is_recalled,false) THEN
    RETURN jsonb_build_object('result','source_message_invalid');
  END IF;
  SELECT m.id INTO v_latest_source_id FROM public.messages m
  WHERE m.conversation_id = p_conversation_id
    AND lower(m.role) IN ('visitor','customer','user')
    AND coalesce(m.is_recalled,false) = false AND m.content <> '__THINKING__'
  ORDER BY m.created_at DESC, m.id DESC LIMIT 1;
  IF v_latest_source_id IS DISTINCT FROM p_source_message_id THEN
    RETURN jsonb_build_object('result','superseded_source');
  END IF;

  SELECT s.revision INTO v_commerce_revision
  FROM public.conversation_commerce_state s
  WHERE s.conversation_id = p_conversation_id AND s.company_id = p_company_id FOR SHARE;
  IF FOUND THEN
    IF p_expected_commerce_revision IS NULL OR v_commerce_revision IS DISTINCT FROM p_expected_commerce_revision THEN
      RETURN jsonb_build_object('result','stale_commerce_revision','current_revision',v_commerce_revision);
    END IF;
  ELSIF p_expected_commerce_revision IS NOT NULL THEN
    RETURN jsonb_build_object('result','stale_commerce_revision','current_revision',NULL);
  END IF;

  IF p_memory->>'conversation_id' IS DISTINCT FROM p_conversation_id::text
     OR p_memory->>'company_id' IS DISTINCT FROM p_company_id::text
     OR p_memory->>'source_message_id' IS DISTINCT FROM p_source_message_id::text
     OR (CASE WHEN p_expected_commerce_revision IS NULL
          THEN p_memory->>'commerce_state_revision' IS NOT NULL
          ELSE (p_memory->>'commerce_state_revision')::bigint IS DISTINCT FROM p_expected_commerce_revision END)
     OR (p_memory->>'memory_revision')::bigint IS DISTINCT FROM p_expected_memory_revision + 1
     OR (p_memory->>'updated_from_turn')::bigint IS DISTINCT FROM p_updated_from_turn THEN
    RETURN jsonb_build_object('result','lineage_invalid');
  END IF;
  v_hash := encode(extensions.digest(p_memory::text, 'sha256'), 'hex');

  SELECT * INTO v_receipt FROM public.conversation_memory_state_event e
  WHERE e.source_message_id = p_source_message_id;
  IF FOUND THEN
    IF v_receipt.conversation_id IS DISTINCT FROM p_conversation_id
       OR v_receipt.company_id IS DISTINCT FROM p_company_id THEN
      RETURN jsonb_build_object('result','source_message_replay_conflict','applied_revision',v_receipt.applied_revision);
    END IF;
    IF v_receipt.memory_hash IS DISTINCT FROM v_hash THEN
      -- Same-source finalisation is restricted to the lifecycle of an actual B2-committed reply.
      -- All business semantics, source/tenant/Commerce lineage and original idempotency stay fixed.
      SELECT * INTO v_existing FROM public.conversation_memory_state
        WHERE conversation_id=p_conversation_id AND company_id=p_company_id FOR UPDATE;
      IF NOT FOUND OR v_existing.source_message_id IS DISTINCT FROM p_source_message_id
         OR v_existing.revision IS DISTINCT FROM p_expected_memory_revision
         OR v_existing.memory_hash IS DISTINCT FROM v_receipt.memory_hash
         OR (p_memory - ARRAY['memory_revision','question_lifecycle','open_questions','pending_actions','handoff_relevant_state'])
            IS DISTINCT FROM (v_existing.memory - ARRAY['memory_revision','question_lifecycle','open_questions','pending_actions','handoff_relevant_state'])
         OR ((p_memory->'handoff_relevant_state') - ARRAY['open_questions','pending_actions'])
            IS DISTINCT FROM ((v_existing.memory->'handoff_relevant_state') - ARRAY['open_questions','pending_actions'])
         OR jsonb_typeof(p_memory->'question_lifecycle') IS DISTINCT FROM 'array'
         OR jsonb_typeof(p_memory->'open_questions') IS DISTINCT FROM 'array'
         OR jsonb_typeof(p_memory->'pending_actions') IS DISTINCT FROM 'array' THEN
        RETURN jsonb_build_object('result','source_message_replay_conflict','applied_revision',v_receipt.applied_revision);
      END IF;
      SELECT m.* INTO v_reply FROM public.messages m
        WHERE m.conversation_id=p_conversation_id AND m.role='assistant'
          AND NOT coalesce(m.is_recalled,false)
          AND m.metadata->>'source_message_id'=p_source_message_id::text
          AND m.metadata->>'control_commit'='ai'
          AND m.metadata->>'b2_gate_contract'='executeB2PersistenceGate:allow_after_revalidation'
          AND m.metadata->>'b2_expected_company_id'=p_company_id::text
          AND (m.metadata->>'b2_expected_revision')::bigint = coalesce(p_expected_commerce_revision,0)
        ORDER BY m.created_at DESC,m.id DESC LIMIT 1;
      IF NOT FOUND OR coalesce((v_reply.metadata->>'recap_read_only')::boolean,false)
         OR v_reply.metadata->>'transaction_mutation'='NONE' THEN
        RETURN jsonb_build_object('result','delivered_reply_required');
      END IF;
      -- Only a source-bound item can be added/changed; previously closed items cannot resurrect.
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') q
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v_existing.memory->'question_lifecycle','[]'::jsonb)) old WHERE old=q)
          AND ((q->>'source_message_id' IS DISTINCT FROM p_source_message_id::text AND NOT (q->>'status'='superseded' AND q->>'resolution'='later scoped assessment request' AND q->>'resolution_source_message_id'=p_source_message_id::text AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') current WHERE current->>'source_message_id'=p_source_message_id::text AND current->>'entity_id'=q->>'entity_id' AND current->>'resolution'='professional/site confirmation pending' AND current->>'resolution_source_message_id'=v_reply.id::text)))
            OR (q->>'source_message_id'=p_source_message_id::text AND q->>'resolution_source_message_id' IS DISTINCT FROM v_reply.id::text)
            OR q->>'status' NOT IN ('resolved','pending','superseded')
            OR NOT EXISTS(SELECT 1 FROM public.messages src WHERE src.id=p_source_message_id AND src.conversation_id=p_conversation_id AND src.role='visitor')))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_existing.memory->'question_lifecycle','[]'::jsonb)) old
          WHERE old->>'source_message_id' IS DISTINCT FROM p_source_message_id::text
            AND NOT (p_memory->'question_lifecycle' @> jsonb_build_array(old))
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') q WHERE q->>'source_message_id'=old->>'source_message_id' AND q->>'status'='superseded' AND old->>'status'='pending' AND q->>'resolution'='later scoped assessment request' AND q->>'resolution_source_message_id'=p_source_message_id::text AND (q-ARRAY['status','resolution','resolution_source_message_id'])=(old-ARRAY['status','resolution','resolution_source_message_id'])))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_existing.memory->'question_lifecycle','[]'::jsonb)) old
          JOIN jsonb_array_elements(p_memory->'question_lifecycle') q ON q->>'source_message_id'=old->>'source_message_id'
          WHERE old->>'status'='resolved' AND q IS DISTINCT FROM old)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_memory->'open_questions') question
          WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') q WHERE q->>'status'='pending' AND q->>'text'=question))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_memory->'pending_actions') action
          WHERE NOT coalesce(v_existing.memory->'pending_actions','[]'::jsonb) ? action
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') q WHERE q->>'status'='pending' AND q->>'resolution' LIKE '%professional%' AND q->>'text'=action))
        OR p_memory->'handoff_relevant_state'->'open_questions' IS DISTINCT FROM
          (SELECT coalesce(jsonb_agg(value),'[]'::jsonb) FROM (SELECT value FROM jsonb_array_elements(p_memory->'open_questions') LIMIT 6) x)
        OR p_memory->'handoff_relevant_state'->'pending_actions' IS DISTINCT FROM
          (SELECT coalesce(jsonb_agg(value),'[]'::jsonb) FROM (SELECT value FROM jsonb_array_elements(p_memory->'pending_actions') LIMIT 6) x) THEN
        RETURN jsonb_build_object('result','lifecycle_reply_binding_invalid');
      END IF;
      v_revision := v_existing.revision+1;
      UPDATE public.conversation_memory_state SET revision=v_revision,memory=p_memory,
        markdown_projection=p_markdown_projection,memory_hash=v_hash,updated_at=now()
        WHERE conversation_id=p_conversation_id AND company_id=p_company_id AND revision=p_expected_memory_revision;
      UPDATE public.conversation_memory_state_event SET applied_revision=v_revision,memory_hash=v_hash
        WHERE source_message_id=p_source_message_id AND memory_hash=v_receipt.memory_hash;
      RETURN jsonb_build_object('result','success','idempotent',false,'applied_revision',v_revision,'current_revision',v_revision,'memory_hash',v_hash);
    END IF;
    RETURN jsonb_build_object('result','success','idempotent',true,'applied_revision',v_receipt.applied_revision,
      'current_revision',(SELECT revision FROM public.conversation_memory_state WHERE conversation_id=p_conversation_id),
      'memory_hash',v_hash);
  END IF;

  SELECT * INTO v_existing FROM public.conversation_memory_state s
  WHERE s.conversation_id = p_conversation_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.company_id IS DISTINCT FROM p_company_id THEN RETURN jsonb_build_object('result','tenant_mismatch'); END IF;
    IF v_existing.revision IS DISTINCT FROM p_expected_memory_revision THEN
      RETURN jsonb_build_object('result','revision_conflict','actual_revision',v_existing.revision);
    END IF;
    v_revision := v_existing.revision + 1;
    UPDATE public.conversation_memory_state SET
      revision=v_revision, source_message_id=p_source_message_id,
      commerce_state_revision=p_expected_commerce_revision, memory=p_memory,
      markdown_projection=p_markdown_projection, memory_hash=v_hash,
      updated_from_turn=p_updated_from_turn, updated_at=now()
    WHERE conversation_id=p_conversation_id;
  ELSE
    IF p_expected_memory_revision <> 0 THEN
      RETURN jsonb_build_object('result','revision_conflict','actual_revision',0);
    END IF;
    v_revision := 1;
    INSERT INTO public.conversation_memory_state(
      conversation_id,company_id,revision,source_message_id,commerce_state_revision,
      memory,markdown_projection,memory_hash,updated_from_turn
    ) VALUES (
      p_conversation_id,p_company_id,v_revision,p_source_message_id,p_expected_commerce_revision,
      p_memory,p_markdown_projection,v_hash,p_updated_from_turn
    );
  END IF;
  INSERT INTO public.conversation_memory_state_event(
    source_message_id,conversation_id,company_id,applied_revision,commerce_state_revision,memory_hash
  ) VALUES (
    p_source_message_id,p_conversation_id,p_company_id,v_revision,p_expected_commerce_revision,v_hash
  );
  RETURN jsonb_build_object('result','success','idempotent',false,'applied_revision',v_revision,
    'current_revision',v_revision,'memory_hash',v_hash);
END;
$function$;

REVOKE ALL ON FUNCTION public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)
  TO service_role;
