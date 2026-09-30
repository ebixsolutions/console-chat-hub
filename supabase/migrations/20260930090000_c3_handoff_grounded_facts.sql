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
  NEW.ai_summary := jsonb_set(v_outer,'{structured_package}',v_package,true)::text;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.c3_enrich_handoff_from_memory_tg()
  FROM PUBLIC, anon, authenticated, service_role;
