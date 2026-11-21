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
  v_request record;
  v_commerce record;
  v_has_memory boolean;
  v_has_commerce boolean;
  v_interpreted boolean;
  v_turns jsonb;
  v_grounded jsonb;
  v_context jsonb;
  v_clear text;
  v_field text;
  v_fact_lines text;
  v_corrections text;
  v_pending text;
BEGIN
  -- Supplemental projection from persisted rows. Never rewrites Memory/Commerce.
  IF NEW.handoff_type = 'ai_to_agent' AND NEW.escalation_rule = 'R1' THEN
    BEGIN v_outer := NEW.ai_summary::jsonb;
    EXCEPTION WHEN others THEN RAISE EXCEPTION 'C3_R1_SUMMARY_ENVELOPE_INVALID'; END;
    v_package := v_outer->'structured_package';
    SELECT c.company_id INTO v_company_id FROM public.conversations c
      WHERE c.id=NEW.conversation_id FOR SHARE;
    IF v_company_id IS NULL OR v_outer->>'schema_version' IS DISTINCT FROM 'c2-handoff-1.0.0'
       OR v_package->>'schema_version' IS DISTINCT FROM 'c2-handoff-1.0.0'
       OR v_package->>'conversation_id' IS DISTINCT FROM NEW.conversation_id::text
       OR v_package->>'company_id' IS DISTINCT FROM v_company_id::text
       OR v_package->>'generated_from_source_message_id' IS DISTINCT FROM NEW.source_message_id::text
    THEN RAISE EXCEPTION 'C3_R1_SUMMARY_BINDING_INVALID'; END IF;
    SELECT s.id,s.content,s.created_at INTO v_request FROM public.messages s
      WHERE s.id=NEW.source_message_id AND s.conversation_id=NEW.conversation_id
        AND s.role='visitor' AND NOT coalesce(s.is_recalled,false) AND s.content<>'__THINKING__'
      FOR SHARE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM public.messages s
      WHERE s.conversation_id=NEW.conversation_id AND s.role='visitor'
        AND NOT coalesce(s.is_recalled,false) AND s.content<>'__THINKING__'
        AND (s.created_at,s.id)>(v_request.created_at,v_request.id))
    THEN RAISE EXCEPTION 'C3_R1_SUMMARY_CURRENT_SOURCE_INVALID' USING ERRCODE='40001'; END IF;

    -- Lock/read the actual committed snapshots, with their original source IDs.
    SELECT c.* INTO v_commerce FROM public.conversation_commerce_state c
      WHERE c.conversation_id=NEW.conversation_id FOR SHARE;
    v_has_commerce := FOUND;
    IF v_has_commerce AND (v_commerce.company_id IS DISTINCT FROM v_company_id
      OR v_commerce.revision IS NULL OR v_commerce.revision<1
      OR NOT EXISTS (SELECT 1 FROM public.messages s WHERE s.id=v_commerce.source_message_id
        AND s.conversation_id=NEW.conversation_id AND s.role='visitor'
        AND NOT coalesce(s.is_recalled,false)
        AND (s.created_at,s.id)<=(v_request.created_at,v_request.id)))
    THEN RAISE EXCEPTION 'C3_R1_SUMMARY_COMMERCE_BINDING_INVALID'; END IF;
    SELECT m.* INTO v_memory FROM public.conversation_memory_state m
      WHERE m.conversation_id=NEW.conversation_id FOR SHARE;
    v_has_memory := FOUND;
    IF v_has_memory THEN
      IF v_memory.company_id IS DISTINCT FROM v_company_id
         OR v_memory.revision IS NULL OR v_memory.revision<1
         OR nullif(v_memory.memory_hash,'') IS NULL
         OR v_memory.memory->>'version' IS DISTINCT FROM 'conversation-memory-1.0.0'
         OR v_memory.memory->>'conversation_id' IS DISTINCT FROM NEW.conversation_id::text
         OR v_memory.memory->>'company_id' IS DISTINCT FROM v_company_id::text
         OR v_memory.memory->>'source_message_id' IS DISTINCT FROM v_memory.source_message_id::text
         OR v_memory.memory->>'memory_revision' IS DISTINCT FROM v_memory.revision::text
         OR v_memory.memory->>'commerce_state_revision' IS DISTINCT FROM v_memory.commerce_state_revision::text
         OR v_memory.commerce_state_revision IS DISTINCT FROM
           (CASE WHEN v_has_commerce THEN v_commerce.revision ELSE NULL END)
         OR NOT EXISTS (SELECT 1 FROM public.messages s WHERE s.id=v_memory.source_message_id
           AND s.conversation_id=NEW.conversation_id AND s.role='visitor'
           AND NOT coalesce(s.is_recalled,false)
           AND (s.created_at,s.id)<=(v_request.created_at,v_request.id))
         OR jsonb_typeof(v_memory.memory->'current_customer_facts') IS DISTINCT FROM 'array'
      THEN RAISE EXCEPTION 'C3_R1_SUMMARY_MEMORY_BINDING_INVALID'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_memory.memory->'current_customer_facts') f
        WHERE f->>'authority' IS NULL OR f->>'authority' NOT IN ('customer','canonical_commerce')
          OR NOT (f ? 'value') OR nullif(f->>'key','') IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.messages s WHERE s.id::text=f->>'source_message_id'
            AND s.conversation_id=NEW.conversation_id AND s.role='visitor'
            AND NOT coalesce(s.is_recalled,false)
            AND (s.created_at,s.id)<=(v_request.created_at,v_request.id)))
      THEN RAISE EXCEPTION 'C3_R1_SUMMARY_FACT_PROVENANCE_INVALID'; END IF;
    END IF;

    -- Raw history is explicitly not fact verification. No first/last-40 truncation.
    SELECT coalesce(jsonb_agg(jsonb_build_object('message_id',s.id,'role',s.role,
      'content',s.content,'created_at',s.created_at) ORDER BY s.created_at,s.id),'[]'::jsonb)
      INTO v_turns FROM public.messages s
      WHERE s.conversation_id=NEW.conversation_id AND s.role IN ('visitor','assistant','agent')
        AND NOT coalesce(s.is_recalled,false) AND s.content<>'__THINKING__'
        AND (s.created_at,s.id)<(v_request.created_at,v_request.id);
    -- Historical KB receipts must have a B2-bound same-company visitor source,
    -- matching tenant/document/chunk provenance and actually used citations.
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'company_id',v_company_id,'source_message_id',q.id,'assistant_message_id',s.id,
      'question',q.content,'answer',s.content,'answered_at',s.created_at,
      'tenant_id',s.metadata->'reference_authority'->'provenance'->>'tenant_id',
      'b2_proof',jsonb_build_object('company_id',s.metadata->>'b2_expected_company_id',
        'source_message_id',s.metadata->>'b2_source_message_id',
        'revision',s.metadata->'b2_expected_revision','response_hash',s.metadata->>'b2_response_hash',
        'idempotency_key',s.metadata->>'b2_idempotency_key'),
      'kb_fact_proof',s.metadata->'kb_fact_proof',
      'authoritative_kb_facts',coalesce(s.metadata->'authoritative_kb_facts','[]'::jsonb),
      'citations',s.metadata->'citations','citation_lineage',s.metadata->'citation_lineage',
      'applicability','historical_answer_not_current_authority','reusable_as_current',false
    ) ORDER BY s.created_at,s.id),'[]'::jsonb) INTO v_grounded
    FROM public.messages s JOIN public.messages q ON q.id::text=s.metadata->>'source_message_id'
    WHERE s.conversation_id=NEW.conversation_id AND q.conversation_id=NEW.conversation_id
      AND s.role='assistant' AND q.role='visitor' AND NOT coalesce(s.is_recalled,false)
      AND NOT coalesce(q.is_recalled,false) AND s.content<>'__THINKING__'
      AND (q.created_at,q.id)<(s.created_at,s.id)
      AND (s.created_at,s.id)<(v_request.created_at,v_request.id)
      AND s.metadata->>'b2_expected_company_id'=v_company_id::text
      AND s.metadata->>'b2_source_message_id'=q.id::text
      AND s.metadata->>'b2_commit_source'='commit_ai_reply_tx'
      AND s.metadata->>'b2_gate_contract'='executeB2PersistenceGate:allow_after_revalidation'
      AND s.metadata->>'b2_expected_revision' ~ '^(0|[1-9][0-9]{0,17})$'
      AND s.metadata->>'b2_response_hash'=encode(extensions.digest(convert_to(s.content,'UTF8'),'sha256'),'hex')
      AND s.metadata->>'b2_idempotency_key'=encode(extensions.digest(convert_to(
        v_company_id::text || ':' || NEW.conversation_id::text || ':' || q.id::text || ':' ||
        (s.metadata->>'b2_expected_revision') || ':' || (s.metadata->>'b2_response_hash'), 'UTF8'),'sha256'),'hex')
      AND s.metadata->>'rag_api_status'='success'
      AND s.metadata->'reference_authority'->>'selected_authority_class'='CURRENT_KB'
      AND s.metadata->'reference_authority'->>'decision'='USE_CURRENT_KB'
      AND s.metadata->'kb_fact_proof'->>'authority_decision'='USE_CURRENT_KB'
      AND s.metadata->'kb_fact_proof'->>'currentness'='current'
      AND nullif(s.metadata->'kb_fact_proof'->>'tenant_id','') IS NOT NULL
      AND s.metadata->'kb_fact_proof'->>'tenant_id'=
        s.metadata->'reference_authority'->'provenance'->>'tenant_id'
      AND s.metadata->'kb_fact_proof'->>'document_id'=
        s.metadata->'reference_authority'->>'selected_source_id'
      AND s.metadata->'kb_fact_proof'->>'document_id'=
        s.metadata->'citation_lineage'->>'selected_document_id'
      AND s.metadata->'citation_lineage'->>'evidence_state'='current'
      AND s.metadata->'citation_lineage'->>'authority_decision'='USE_CURRENT_KB'
      AND jsonb_typeof(s.metadata->'citations')='array'
      AND jsonb_typeof(coalesce(s.metadata->'authoritative_kb_facts','[]'::jsonb))='array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.metadata->'citations')='array' THEN s.metadata->'citations' ELSE '[]'::jsonb END) c
        WHERE c->>'document_id'=s.metadata->'kb_fact_proof'->>'document_id'
          AND c->>'chunk_id'=s.metadata->'kb_fact_proof'->>'chunk_id'
          AND c->>'evidence_state'='current' AND c->>'authority_decision'='USE_CURRENT_KB')
      AND s.metadata->'citation_lineage'->'evidence_chunk_ids' ? (s.metadata->'kb_fact_proof'->>'chunk_id')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.metadata->'authoritative_kb_facts')='array' THEN s.metadata->'authoritative_kb_facts' ELSE '[]'::jsonb END) f
        WHERE f->>'authority' IS DISTINCT FROM 'CURRENT_KB'
          OR f->>'currentness_at_answer' IS DISTINCT FROM 'current'
          OR f->>'tenant_id' IS DISTINCT FROM (s.metadata->'kb_fact_proof'->>'tenant_id')
          OR f->>'source_message_id' IS DISTINCT FROM q.id::text
          OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.metadata->'citations')='array' THEN s.metadata->'citations' ELSE '[]'::jsonb END) c
            WHERE c->>'document_id'=f->>'document_id' AND c->>'chunk_id'=f->>'chunk_id'
              AND c->>'evidence_state'='current' AND c->>'authority_decision'='USE_CURRENT_KB'));

    v_interpreted := v_has_memory AND v_memory.source_message_id=NEW.source_message_id;
    v_context := jsonb_build_object('version','c3-early-r1-context-1.0.0',
      'conversation_id',NEW.conversation_id,'company_id',v_company_id,
      'current_request',jsonb_build_object('source_message_id',NEW.source_message_id,
        'content',v_request.content,'interpretation_committed',v_interpreted),
      'memory_snapshot',CASE WHEN v_has_memory THEN jsonb_build_object(
        'revision',v_memory.revision,'source_message_id',v_memory.source_message_id,
        'memory_hash',v_memory.memory_hash,'commerce_state_revision',v_memory.commerce_state_revision,
        'applicability',CASE WHEN v_interpreted THEN 'same_source_committed' ELSE 'prior_committed_snapshot' END,
        'memory',v_memory.memory) ELSE NULL END,
      'commerce_snapshot',CASE WHEN v_has_commerce THEN jsonb_build_object(
        'revision',v_commerce.revision,'source_message_id',v_commerce.source_message_id,
        'state_hash',v_commerce.state_hash,'state',v_commerce.state,
        'applicability',CASE WHEN v_commerce.source_message_id=NEW.source_message_id
          THEN 'same_source_committed' ELSE 'prior_committed_snapshot' END) ELSE NULL END,
      'prior_turns',v_turns,'grounded_answer_history',v_grounded);
    v_package := jsonb_set(v_package,'{handoff_context}',v_context,true);
    IF coalesce(v_interpreted,false) THEN
      FOREACH v_clear IN ARRAY ARRAY['customer_preferences','open_questions','pending_actions',
        'current_customer_facts','latest_corrections','question_lifecycle'] LOOP
        v_package := jsonb_set(v_package,ARRAY[v_clear],coalesce(v_memory.memory->v_clear,'[]'::jsonb),true);
      END LOOP;
      v_package := jsonb_set(v_package,'{current_customer_goal}',coalesce(v_memory.memory->'current_goal','null'::jsonb),true);
      v_package := jsonb_set(v_package,'{historical_customer_facts}',coalesce(v_memory.memory->'historical_facts','[]'::jsonb),true);
      v_package := jsonb_set(v_package,'{superseded_customer_facts}',coalesce(v_memory.memory->'cancelled_or_superseded','[]'::jsonb),true);
    ELSE
      -- Latest raw correction/cancellation is durable, but has not been interpreted
      -- or committed into canonical state. Old topic entities cannot be current.
      v_package := jsonb_set(v_package,'{current_customer_goal}',to_jsonb(v_request.content),true);
      FOREACH v_clear IN ARRAY ARRAY['active_entities','latest_corrections','confirmed_facts',
        'customer_preferences','current_customer_facts','open_questions','pending_actions',
        'current_authoritative_kb_facts','citations'] LOOP
        v_package := jsonb_set(v_package,ARRAY[v_clear],'[]'::jsonb,true);
      END LOOP;
      v_package := jsonb_set(v_package,'{recommended_next_human_action}',to_jsonb(
        'Review the latest customer request, including corrections/cancellations, before applying any prior snapshot or historical KB answer. Verify outstanding current requirements and merchant/transaction authority.'::text),true);
    END IF;
    -- Prior and same-source snapshots retain separate, explicit applicability.
    v_outer := jsonb_set(v_outer,'{structured_package}',v_package,true);
    v_outer := jsonb_set(v_outer,'{summary_markdown}',to_jsonb(concat_ws(E'\n',
      '### Latest Customer Request (original persisted text)',v_request.content,
      '### Interpretation',CASE WHEN v_interpreted THEN 'Same-source canonical snapshot committed.'
        ELSE 'Latest request has not been interpreted into canonical Memory/Commerce; review correction/cancellation before reusing prior context.' END,
      '### Prior Committed Snapshot (not automatically applicable to the latest request)',
      coalesce(v_context->'memory_snapshot'->'memory','null'::jsonb)::text,
      '### Prior Grounded KB Answers (historical; not current request authority)',v_grounded::text,
      '### Prior Conversation (raw history; not verification)',v_turns::text,
      '### Last Committed Transaction State (verify against latest request)',(v_package->'transaction_state')::text,
      '### Handoff Reason',NEW.handoff_reason,
      '### Recommended Next Action',v_package->>'recommended_next_human_action')),true);
    NEW.ai_summary := v_outer::text;
    RETURN NEW;
  END IF;
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
;
