-- NOT AUTHORIZED FOR PRODUCTION. Review together with callers/tests/rollback.
-- Original customer receipts and all existing RPCs/triggers remain unchanged.
BEGIN;
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)'::regprocedure))
    IS DISTINCT FROM nullif(current_setting('c3.expected_memory_rpc_md5',true),'') THEN
   RAISE EXCEPTION 'Fresh Memory baseline required';
 END IF;
 IF md5(pg_get_functiondef('public.c3_enforce_conversation_memory_lineage_tg()'::regprocedure))
    IS DISTINCT FROM nullif(current_setting('c3.expected_memory_trigger_md5',true),'') THEN
   RAISE EXCEPTION 'Fresh Memory trigger baseline required';
 END IF;
 IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Approved owner execution required'; END IF;
 IF to_regclass('public.c3_memory_reply_lifecycle_receipt') IS NOT NULL THEN
   RAISE EXCEPTION 'Existing lifecycle objects require comparison';
 END IF;
END $$;
CREATE TABLE public.c3_memory_reply_lifecycle_receipt (
 reply_message_id uuid PRIMARY KEY REFERENCES public.messages(id),
 conversation_id uuid NOT NULL REFERENCES public.conversations(id),
 company_id uuid NOT NULL REFERENCES public.company(id),
 source_message_id uuid NOT NULL REFERENCES public.messages(id),
 parent_revision bigint NOT NULL CHECK (parent_revision > 0),
 parent_hash text NOT NULL CHECK (parent_hash ~ '^[a-f0-9]{64}$'),
 applied_revision bigint NOT NULL CHECK (applied_revision = parent_revision + 1),
 commerce_state_revision bigint,
 memory_hash text NOT NULL CHECK (memory_hash ~ '^[a-f0-9]{64}$'),
 reply_content_hash text NOT NULL CHECK (reply_content_hash ~ '^[a-f0-9]{64}$'),
 markdown_hash text NOT NULL CHECK (markdown_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (conversation_id, source_message_id)
);
ALTER TABLE public.c3_memory_reply_lifecycle_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.c3_memory_reply_lifecycle_receipt FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.c3_memory_reply_lifecycle_receipt TO service_role;
CREATE FUNCTION public.c3_finalize_memory_reply_tx(
 p_conversation_id uuid, p_company_id uuid, p_source_message_id uuid,
 p_reply_message_id uuid, p_expected_memory_revision bigint,
 p_expected_memory_hash text, p_memory jsonb, p_markdown_projection text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 s public.conversation_memory_state%rowtype;
 e public.conversation_memory_state_event%rowtype;
 r public.messages%rowtype;
 receipt public.c3_memory_reply_lifecycle_receipt%rowtype;
 co uuid; latest uuid; commerce_revision bigint;
 h text; mh text; rh text;
BEGIN
 IF p_conversation_id IS NULL OR p_company_id IS NULL OR p_source_message_id IS NULL
    OR p_reply_message_id IS NULL OR p_expected_memory_revision IS NULL
    OR p_expected_memory_revision < 1 OR p_expected_memory_hash IS NULL
    OR p_expected_memory_hash !~ '^[a-f0-9]{64}$'
    OR p_memory IS NULL OR jsonb_typeof(p_memory) IS DISTINCT FROM 'object'
    OR octet_length(p_memory::text)>65536 OR p_markdown_projection IS NULL
    OR octet_length(p_markdown_projection)>32768 THEN
   RETURN jsonb_build_object('result','invalid_input');
 END IF;
 SELECT company_id INTO co FROM public.conversations WHERE id=p_conversation_id FOR UPDATE;
 IF NOT FOUND OR co IS DISTINCT FROM p_company_id THEN
   RETURN jsonb_build_object('result','tenant_mismatch');
 END IF;
 SELECT * INTO r FROM public.messages WHERE id=p_reply_message_id FOR SHARE;
 IF NOT FOUND OR r.conversation_id IS DISTINCT FROM p_conversation_id
    OR r.role IS DISTINCT FROM 'assistant' OR coalesce(r.is_recalled,false)
    OR r.metadata->>'source_message_id' IS DISTINCT FROM p_source_message_id::text
    OR r.metadata->>'control_commit' IS DISTINCT FROM 'ai'
    OR r.metadata->>'b2_source_message_id' IS DISTINCT FROM p_source_message_id::text
    OR r.metadata->>'b2_commit_source' IS DISTINCT FROM 'commit_ai_reply_tx'
    OR r.metadata->>'recap_read_only'='true' OR r.metadata->>'transaction_mutation'='NONE'
    OR r.metadata->>'response_route' IN ('natural_greeting','natural_social_acknowledgement','natural_conversation_closure')
    OR r.metadata->>'b2_expected_company_id' IS DISTINCT FROM p_company_id::text
    OR r.metadata->>'b2_gate_contract' IS DISTINCT FROM 'executeB2PersistenceGate:allow_after_revalidation' THEN
   RETURN jsonb_build_object('result','delivered_reply_required');
 END IF;
 h:=encode(extensions.digest(p_memory::text,'sha256'),'hex');
 mh:=encode(extensions.digest(p_markdown_projection,'sha256'),'hex');
 rh:=encode(extensions.digest(r.content,'sha256'),'hex');
 SELECT * INTO receipt FROM public.c3_memory_reply_lifecycle_receipt WHERE reply_message_id=p_reply_message_id;
 IF FOUND THEN
   IF receipt.conversation_id IS DISTINCT FROM p_conversation_id OR receipt.company_id IS DISTINCT FROM p_company_id
      OR receipt.source_message_id IS DISTINCT FROM p_source_message_id
      OR receipt.parent_revision IS DISTINCT FROM p_expected_memory_revision
      OR receipt.parent_hash IS DISTINCT FROM p_expected_memory_hash
      OR receipt.memory_hash IS DISTINCT FROM h OR receipt.markdown_hash IS DISTINCT FROM mh
      OR receipt.reply_content_hash IS DISTINCT FROM rh THEN
     RETURN jsonb_build_object('result','reply_replay_conflict');
   END IF;
   RETURN jsonb_build_object('result','success','idempotent',true,'applied_revision',receipt.applied_revision,'memory_hash',h);
 END IF;
 IF EXISTS(SELECT 1 FROM public.c3_memory_reply_lifecycle_receipt WHERE conversation_id=p_conversation_id AND source_message_id=p_source_message_id) THEN
   RETURN jsonb_build_object('result','reply_replay_conflict');
 END IF;
 SELECT * INTO s FROM public.conversation_memory_state WHERE conversation_id=p_conversation_id FOR UPDATE;
 IF NOT FOUND OR s.company_id IS DISTINCT FROM p_company_id OR s.source_message_id IS DISTINCT FROM p_source_message_id
    OR s.revision IS DISTINCT FROM p_expected_memory_revision OR s.memory_hash IS DISTINCT FROM p_expected_memory_hash THEN
   RETURN jsonb_build_object('result','revision_conflict');
 END IF;
 SELECT * INTO e FROM public.conversation_memory_state_event WHERE source_message_id=p_source_message_id;
 IF NOT FOUND OR e.conversation_id IS DISTINCT FROM p_conversation_id OR e.company_id IS DISTINCT FROM p_company_id
    OR e.applied_revision IS DISTINCT FROM s.revision OR e.memory_hash IS DISTINCT FROM s.memory_hash
    OR e.commerce_state_revision IS DISTINCT FROM s.commerce_state_revision THEN
   RETURN jsonb_build_object('result','parent_receipt_mismatch');
 END IF;
 SELECT id INTO latest FROM public.messages WHERE conversation_id=p_conversation_id
   AND lower(role) IN ('visitor','customer','user') AND NOT coalesce(is_recalled,false)
   ORDER BY created_at DESC,id DESC LIMIT 1;
 IF latest IS DISTINCT FROM p_source_message_id THEN RETURN jsonb_build_object('result','superseded_source'); END IF;
 SELECT revision INTO commerce_revision FROM public.conversation_commerce_state WHERE conversation_id=p_conversation_id AND company_id=p_company_id FOR SHARE;
 IF commerce_revision IS DISTINCT FROM s.commerce_state_revision
    OR r.metadata->>'b2_expected_revision' IS DISTINCT FROM coalesce(s.commerce_state_revision,0)::text THEN
   RETURN jsonb_build_object('result','stale_commerce_revision');
 END IF;
 IF p_memory->>'memory_revision' IS DISTINCT FROM (s.revision+1)::text
    OR (p_memory-ARRAY['memory_revision','question_lifecycle','open_questions','pending_actions','handoff_relevant_state'])
       IS DISTINCT FROM (s.memory-ARRAY['memory_revision','question_lifecycle','open_questions','pending_actions','handoff_relevant_state'])
    OR ((p_memory->'handoff_relevant_state')-ARRAY['open_questions','pending_actions'])
       IS DISTINCT FROM ((s.memory->'handoff_relevant_state')-ARRAY['open_questions','pending_actions'])
    OR jsonb_typeof(p_memory->'question_lifecycle') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_memory->'open_questions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_memory->'pending_actions') IS DISTINCT FROM 'array' THEN
   RETURN jsonb_build_object('result','business_semantics_changed');
 END IF;
 -- Only delivered reply lifecycle changes are permitted. A prior professional
 -- request may become superseded ONLY by a new pending request for the same
 -- non-null entity. Previously resolved questions cannot be resurrected.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s.memory->'question_lifecycle','[]')) old
      WHERE old->>'source_message_id' IS DISTINCT FROM p_source_message_id::text
        AND NOT(p_memory->'question_lifecycle' @> jsonb_build_array(old))
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') q
          WHERE old->>'status'='pending' AND old->>'resolution' LIKE '%professional%'
            AND q->>'source_message_id'=old->>'source_message_id'
            AND q->>'status'='superseded' AND q->>'resolution'='later scoped assessment request'
            AND q->>'resolution_source_message_id'=p_source_message_id::text
            AND (q-ARRAY['status','resolution','resolution_source_message_id'])=(old-ARRAY['status','resolution','resolution_source_message_id'])
            AND q->>'entity_id' IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') current
              WHERE current->>'source_message_id'=p_source_message_id::text AND current->>'entity_id'=q->>'entity_id'
                AND current->>'status'='pending' AND current->>'resolution'='professional/site confirmation pending'
                AND current->>'resolution_source_message_id'=p_reply_message_id::text)))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') q
      WHERE NOT(coalesce(s.memory->'question_lifecycle','[]') @> jsonb_build_array(q))
        AND (q->>'status' IS NULL OR q->>'status' NOT IN ('pending','resolved','superseded') OR
          (q->>'source_message_id'=p_source_message_id::text AND q->>'resolution_source_message_id' IS DISTINCT FROM p_reply_message_id::text) OR
          (q->>'source_message_id' IS DISTINCT FROM p_source_message_id::text AND NOT EXISTS(
            SELECT 1 FROM jsonb_array_elements(coalesce(s.memory->'question_lifecycle','[]')) old
              WHERE old->>'source_message_id'=q->>'source_message_id' AND old->>'status'='pending'
                AND old->>'resolution' LIKE '%professional%' AND q->>'status'='superseded'
                AND q->>'resolution'='later scoped assessment request'
                AND q->>'resolution_source_message_id'=p_source_message_id::text
                AND (q-ARRAY['status','resolution','resolution_source_message_id'])=(old-ARRAY['status','resolution','resolution_source_message_id'])
                AND q->>'entity_id' IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') current
                  WHERE current->>'source_message_id'=p_source_message_id::text AND current->>'entity_id'=q->>'entity_id'
                    AND current->>'status'='pending' AND current->>'resolution'='professional/site confirmation pending'
                    AND current->>'resolution_source_message_id'=p_reply_message_id::text)))))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') q GROUP BY q->>'source_message_id' HAVING q->>'source_message_id' IS NULL OR count(*)>1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s.memory->'question_lifecycle','[]')) old
      JOIN jsonb_array_elements(p_memory->'question_lifecycle') q ON old->>'source_message_id'=q->>'source_message_id'
      WHERE old->>'status'='resolved' AND q IS DISTINCT FROM old)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_memory->'open_questions') q
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') item WHERE item->>'status'='pending' AND item->>'text'=q))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_memory->'pending_actions') a
      WHERE NOT coalesce(s.memory->'pending_actions','[]') ? a AND NOT EXISTS(
       SELECT 1 FROM jsonb_array_elements(p_memory->'question_lifecycle') q WHERE q->>'status'='pending' AND q->>'resolution' LIKE '%professional%' AND q->>'text'=a))
    OR p_memory->'handoff_relevant_state'->'open_questions' IS DISTINCT FROM
       (SELECT coalesce(jsonb_agg(value),'[]') FROM(SELECT value FROM jsonb_array_elements(p_memory->'open_questions') LIMIT 6)x)
    OR p_memory->'handoff_relevant_state'->'pending_actions' IS DISTINCT FROM
       (SELECT coalesce(jsonb_agg(value),'[]') FROM(SELECT value FROM jsonb_array_elements(p_memory->'pending_actions') LIMIT 6)x) THEN
   RETURN jsonb_build_object('result','lifecycle_reply_binding_invalid');
 END IF;
 UPDATE public.conversation_memory_state SET revision=s.revision+1,memory=p_memory,
   markdown_projection=p_markdown_projection,memory_hash=h,updated_at=now()
   WHERE conversation_id=p_conversation_id AND company_id=p_company_id AND revision=s.revision;
 INSERT INTO public.c3_memory_reply_lifecycle_receipt(reply_message_id,conversation_id,company_id,source_message_id,
   parent_revision,parent_hash,applied_revision,commerce_state_revision,memory_hash,reply_content_hash,markdown_hash)
 VALUES(p_reply_message_id,p_conversation_id,p_company_id,p_source_message_id,s.revision,s.memory_hash,s.revision+1,s.commerce_state_revision,h,rh,mh);
 RETURN jsonb_build_object('result','success','idempotent',false,'applied_revision',s.revision+1,'memory_hash',h);
END $$;
REVOKE ALL ON FUNCTION public.c3_finalize_memory_reply_tx(uuid,uuid,uuid,uuid,bigint,text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.c3_finalize_memory_reply_tx(uuid,uuid,uuid,uuid,bigint,text,jsonb,text) TO service_role;
COMMIT;
