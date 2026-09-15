-- AI-ABC-C3 — tenant-bound, revisioned structured conversation memory.
-- Forward closure version after the earlier C3 apply/rollback history; the
-- prior 20260915012938 version is intentionally not replayed in production.
-- The memory is a bounded projection. Canonical commerce state and current KB
-- remain higher authority. Raw message history is retained unchanged.
-- Exact rollback closure (execute in this order):
-- DROP TRIGGER IF EXISTS c3_enrich_handoff_from_memory_before_insert ON public.handoff_event;
-- DROP FUNCTION IF EXISTS public.c3_enrich_handoff_from_memory_tg();
-- DROP FUNCTION IF EXISTS public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint);
-- DROP TRIGGER IF EXISTS c3_conversation_memory_lineage_before_write ON public.conversation_memory_state;
-- DROP FUNCTION IF EXISTS public.c3_enforce_conversation_memory_lineage_tg();
-- DROP TABLE IF EXISTS public.conversation_memory_state_event;
-- DROP TABLE IF EXISTS public.conversation_memory_state;

CREATE TABLE public.conversation_memory_state (
  conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  source_message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE RESTRICT,
  commerce_state_revision bigint,
  memory jsonb NOT NULL,
  markdown_projection text NOT NULL,
  memory_hash text NOT NULL,
  updated_from_turn bigint NOT NULL CHECK (updated_from_turn >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_memory_state_company_unique UNIQUE (conversation_id, company_id),
  CONSTRAINT conversation_memory_state_object_check CHECK (jsonb_typeof(memory) = 'object'),
  CONSTRAINT conversation_memory_state_version_check CHECK (memory->>'version' = 'conversation-memory-1.0.0'),
  CONSTRAINT conversation_memory_state_hash_check CHECK (memory_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT conversation_memory_state_size_check CHECK (octet_length(memory::text) <= 65536),
  CONSTRAINT conversation_memory_state_projection_size_check CHECK (octet_length(markdown_projection) <= 32768)
);

CREATE TABLE public.conversation_memory_state_event (
  source_message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL,
  company_id uuid NOT NULL,
  applied_revision bigint NOT NULL CHECK (applied_revision >= 1),
  commerce_state_revision bigint,
  memory_hash text NOT NULL CHECK (memory_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_memory_state_event_revision_unique UNIQUE (conversation_id, applied_revision),
  CONSTRAINT conversation_memory_state_event_parent_fk
    FOREIGN KEY (conversation_id, company_id)
    REFERENCES public.conversation_memory_state(conversation_id, company_id)
    ON DELETE CASCADE
);

CREATE INDEX conversation_memory_state_company_updated_idx
  ON public.conversation_memory_state(company_id, updated_at DESC);
CREATE INDEX conversation_memory_state_source_message_idx
  ON public.conversation_memory_state(source_message_id);
CREATE INDEX conversation_memory_state_event_company_created_idx
  ON public.conversation_memory_state_event(company_id, created_at DESC);

ALTER TABLE public.conversation_memory_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_memory_state_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversation_memory_state_select_staff
ON public.conversation_memory_state FOR SELECT TO authenticated
USING (company_id IS NOT NULL AND public.is_company_member(company_id, auth.uid()));

CREATE POLICY conversation_memory_state_event_select_staff
ON public.conversation_memory_state_event FOR SELECT TO authenticated
USING (company_id IS NOT NULL AND public.is_company_member(company_id, auth.uid()));

REVOKE ALL ON TABLE public.conversation_memory_state FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.conversation_memory_state_event FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.conversation_memory_state TO authenticated, service_role;
GRANT SELECT ON TABLE public.conversation_memory_state_event TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.c3_enforce_conversation_memory_lineage_tg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_conversation_company uuid;
  v_message_conversation uuid;
  v_message_role text;
BEGIN
  SELECT c.company_id INTO v_conversation_company
  FROM public.conversations c WHERE c.id = NEW.conversation_id;
  IF NOT FOUND OR v_conversation_company IS NULL OR v_conversation_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'C3_MEMORY_TENANT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  SELECT m.conversation_id, m.role INTO v_message_conversation, v_message_role
  FROM public.messages m WHERE m.id = NEW.source_message_id;
  IF NOT FOUND OR v_message_conversation IS DISTINCT FROM NEW.conversation_id
     OR lower(coalesce(v_message_role,'')) NOT IN ('visitor','customer','user') THEN
    RAISE EXCEPTION 'C3_MEMORY_SOURCE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.memory->>'conversation_id' IS DISTINCT FROM NEW.conversation_id::text
     OR NEW.memory->>'company_id' IS DISTINCT FROM NEW.company_id::text
     OR NEW.memory->>'source_message_id' IS DISTINCT FROM NEW.source_message_id::text
     OR (NEW.memory->>'memory_revision')::bigint IS DISTINCT FROM NEW.revision
     OR (CASE WHEN NEW.commerce_state_revision IS NULL
          THEN NEW.memory->>'commerce_state_revision' IS NOT NULL
          ELSE (NEW.memory->>'commerce_state_revision')::bigint IS DISTINCT FROM NEW.commerce_state_revision END) THEN
    RAISE EXCEPTION 'C3_MEMORY_LINEAGE_INVALID' USING ERRCODE = 'P0001';
  END IF;
  NEW.memory_hash := encode(extensions.digest(NEW.memory::text, 'sha256'), 'hex');
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.c3_enforce_conversation_memory_lineage_tg()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER c3_conversation_memory_lineage_before_write
BEFORE INSERT OR UPDATE ON public.conversation_memory_state
FOR EACH ROW EXECUTE FUNCTION public.c3_enforce_conversation_memory_lineage_tg();

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
       OR v_receipt.company_id IS DISTINCT FROM p_company_id
       OR v_receipt.memory_hash IS DISTINCT FROM v_hash THEN
      RETURN jsonb_build_object('result','source_message_replay_conflict','applied_revision',v_receipt.applied_revision);
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

-- C2 remains authoritative for transaction state. This later alphabetic BEFORE
-- trigger only fills memory-derived conversational fields and never overwrites
-- C2 commerce truth, handoff authority, or source lineage.
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

REVOKE ALL ON FUNCTION public.c3_enrich_handoff_from_memory_tg()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER c3_enrich_handoff_from_memory_before_insert
BEFORE INSERT ON public.handoff_event
FOR EACH ROW EXECUTE FUNCTION public.c3_enrich_handoff_from_memory_tg();

COMMENT ON TABLE public.conversation_memory_state IS
  'C3 bounded, revisioned structured conversation memory; derived context only, never commerce authority.';
COMMENT ON TABLE public.conversation_memory_state_event IS
  'C3 source-message idempotency ledger for structured memory commits.';

DO $c3_security_assert$
DECLARE
  v_rpc oid := 'public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)'::regprocedure;
  v_lineage oid := 'public.c3_enforce_conversation_memory_lineage_tg()'::regprocedure;
  v_handoff oid := 'public.c3_enrich_handoff_from_memory_tg()'::regprocedure;
  v_trigger_count integer;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='public.conversation_memory_state'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='public.conversation_memory_state_event'::regclass) THEN
    RAISE EXCEPTION 'C3_MEMORY_RLS_REQUIRED';
  END IF;
  IF has_function_privilege('anon',v_rpc,'EXECUTE') OR has_function_privilege('authenticated',v_rpc,'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
       LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
       WHERE p.oid=v_rpc AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
     OR NOT has_function_privilege('service_role',v_rpc,'EXECUTE') THEN
    RAISE EXCEPTION 'C3_MEMORY_RPC_ACL_INVALID';
  END IF;
  IF has_function_privilege('anon',v_lineage,'EXECUTE') OR has_function_privilege('authenticated',v_lineage,'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
       LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
       WHERE p.oid=v_lineage AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
     OR has_function_privilege('service_role',v_lineage,'EXECUTE')
     OR has_function_privilege('anon',v_handoff,'EXECUTE') OR has_function_privilege('authenticated',v_handoff,'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p,
       LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
       WHERE p.oid=v_handoff AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
     OR has_function_privilege('service_role',v_handoff,'EXECUTE') THEN
    RAISE EXCEPTION 'C3_MEMORY_TRIGGER_ACL_INVALID';
  END IF;
  IF (SELECT NOT prosecdef OR pg_catalog.pg_get_userbyid(proowner)<>'postgres'
       OR proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[] FROM pg_catalog.pg_proc WHERE oid=v_rpc)
     OR (SELECT NOT prosecdef OR pg_catalog.pg_get_userbyid(proowner)<>'postgres'
       OR proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[] FROM pg_catalog.pg_proc WHERE oid=v_lineage)
     OR (SELECT NOT prosecdef OR pg_catalog.pg_get_userbyid(proowner)<>'postgres'
       OR proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[] FROM pg_catalog.pg_proc WHERE oid=v_handoff) THEN
    RAISE EXCEPTION 'C3_MEMORY_FUNCTION_SECURITY_INVALID';
  END IF;
  SELECT count(*) INTO v_trigger_count FROM pg_catalog.pg_trigger
   WHERE tgrelid='public.conversation_memory_state'::regclass AND tgname='c3_conversation_memory_lineage_before_write' AND NOT tgisinternal;
  IF v_trigger_count<>1 THEN RAISE EXCEPTION 'C3_MEMORY_LINEAGE_TRIGGER_INVALID'; END IF;
  SELECT count(*) INTO v_trigger_count FROM pg_catalog.pg_trigger
   WHERE tgrelid='public.handoff_event'::regclass AND tgname='c3_enrich_handoff_from_memory_before_insert' AND NOT tgisinternal;
  IF v_trigger_count<>1 THEN RAISE EXCEPTION 'C3_MEMORY_HANDOFF_TRIGGER_INVALID'; END IF;
END;
$c3_security_assert$;
