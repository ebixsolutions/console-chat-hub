-- ===========================================================================
-- Task 1 — Conversation Evaluation (CE) forward migration  [STAGED, NOT APPLIED]
--
-- Staged here (sql/ce-task1/) because supabase/migrations/ is platform-managed
-- and the only apply path executes SQL, which this run is forbidden to do.
-- Submit verbatim through the platform migration tool when authorized.
--
-- CANONICAL OWNER: AI Chatbot. SU CoachAI is a downstream training consumer.
--
-- Properties:
--   * Single transaction — any failure leaves ZERO partial state.
--   * Idempotent — re-running is a no-op (catalog guards + ON CONFLICT).
--   * Provenance — every object created is recorded in
--     public.ce_migration_provenance (created_by_migration = true). Objects
--     that would be REPLACED capture prior definition/owner/ACL/RLS first.
--   * Companion: 20260805012800_task1_ce_grounding_replay_rollback.sql
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. Provenance ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ce_migration_provenance (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_key        text NOT NULL,
  object_type          text NOT NULL,
  object_identity      text NOT NULL,
  created_by_migration boolean NOT NULL,
  prior_definition     text,
  prior_owner          text,
  prior_acl            text[],
  prior_rls_enabled    boolean,
  notes                text,
  captured_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (migration_key, object_type, object_identity)
);

GRANT SELECT ON public.ce_migration_provenance TO authenticated;
GRANT ALL    ON public.ce_migration_provenance TO service_role;
ALTER TABLE public.ce_migration_provenance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ce_provenance_admin_read ON public.ce_migration_provenance;
CREATE POLICY ce_provenance_admin_read ON public.ce_migration_provenance
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Capture pre-state for objects this migration REPLACES (fail-closed rollback
-- needs exact definition + owner + ACL + RLS state). Nothing is captured for
-- objects that do not already exist, so rollback never guesses.
INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration,
   prior_definition, prior_owner, prior_acl, prior_rls_enabled, notes)
SELECT '20260805012800_task1_ce_grounding_replay', 'table', c.oid::regclass::text, false,
       NULL, pg_get_userbyid(c.relowner), c.relacl::text[], c.relrowsecurity,
       'pre-existing table modified by this migration'
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('conversations','channel_config','upstream_call_log')
ON CONFLICT DO NOTHING;

INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration,
   prior_definition, prior_owner, notes)
SELECT '20260805012800_task1_ce_grounding_replay', 'function',
       p.oid::regprocedure::text, false,
       pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner),
       'pre-existing function replaced by CREATE OR REPLACE'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('ce_enforce_conversation_company','ce_enforce_upstream_log_company',
                     'ce_block_mutation','ce_validate_grounding','ce_purge_expired_replays')
ON CONFLICT DO NOTHING;

INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration,
   prior_definition, notes)
SELECT '20260805012800_task1_ce_grounding_replay', 'trigger',
       c.relname || ':' || t.tgname, false,
       pg_get_triggerdef(t.oid), 'pre-existing trigger replaced'
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal AND n.nspname = 'public'
   AND t.tgname IN ('trg_ce_conversation_company','trg_ce_upstream_log_company',
                    'trg_ce_replay_bundle_immutable','trg_ce_replay_chunk_immutable')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. Tenant / company root
-- ---------------------------------------------------------------------------
DO $mig$
DECLARE v_key text := '20260805012800_task1_ce_grounding_replay';
BEGIN
  IF to_regclass('public.company') IS NULL THEN
    CREATE TABLE public.company (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL,
      tenant_id    uuid NOT NULL,
      name         text NOT NULL,
      is_active    boolean NOT NULL DEFAULT true,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, tenant_id, name)
    );
    GRANT SELECT ON public.company TO authenticated;
    GRANT ALL    ON public.company TO service_role;
    ALTER TABLE public.company ENABLE ROW LEVEL SECURITY;
    CREATE POLICY company_staff_read ON public.company
      FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

    INSERT INTO public.ce_migration_provenance
      (migration_key, object_type, object_identity, created_by_migration)
    VALUES (v_key, 'table', 'public.company', true) ON CONFLICT DO NOTHING;
  END IF;

  -- company_id columns (each tracked individually)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='channel_config'
                    AND column_name='company_id') THEN
    ALTER TABLE public.channel_config ADD COLUMN company_id uuid REFERENCES public.company(id);
    INSERT INTO public.ce_migration_provenance
      (migration_key, object_type, object_identity, created_by_migration)
    VALUES (v_key,'column','public.channel_config.company_id',true) ON CONFLICT DO NOTHING;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='conversations'
                    AND column_name='company_id') THEN
    ALTER TABLE public.conversations ADD COLUMN company_id uuid REFERENCES public.company(id);
    INSERT INTO public.ce_migration_provenance
      (migration_key, object_type, object_identity, created_by_migration)
    VALUES (v_key,'column','public.conversations.company_id',true) ON CONFLICT DO NOTHING;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='upstream_call_log'
                    AND column_name='company_id') THEN
    ALTER TABLE public.upstream_call_log ADD COLUMN company_id uuid REFERENCES public.company(id);
    INSERT INTO public.ce_migration_provenance
      (migration_key, object_type, object_identity, created_by_migration)
    VALUES (v_key,'column','public.upstream_call_log.company_id',true) ON CONFLICT DO NOTHING;
  END IF;
END
$mig$;

CREATE INDEX IF NOT EXISTS idx_conversations_company    ON public.conversations (company_id);
CREATE INDEX IF NOT EXISTS idx_upstream_call_log_company ON public.upstream_call_log (company_id);

INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration)
VALUES
  ('20260805012800_task1_ce_grounding_replay','index','public.idx_conversations_company',true),
  ('20260805012800_task1_ce_grounding_replay','index','public.idx_upstream_call_log_company',true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Fail-closed company consistency
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_enforce_conversation_company()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_channel_company uuid;
BEGIN
  IF NEW.channel_config_id IS NULL THEN
    IF NEW.company_id IS NOT NULL THEN
      RAISE EXCEPTION 'CE_SCOPE_MISMATCH: company_id set without channel_config_id';
    END IF;
    RETURN NEW;
  END IF;
  SELECT company_id INTO v_channel_company
    FROM public.channel_config WHERE id = NEW.channel_config_id;
  IF NEW.company_id IS DISTINCT FROM v_channel_company THEN
    RAISE EXCEPTION 'CE_SCOPE_MISMATCH: conversation.company_id % != channel_config.company_id %',
      NEW.company_id, v_channel_company;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_ce_conversation_company ON public.conversations;
CREATE TRIGGER trg_ce_conversation_company
  BEFORE INSERT OR UPDATE OF company_id, channel_config_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.ce_enforce_conversation_company();

CREATE OR REPLACE FUNCTION public.ce_enforce_upstream_log_company()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_conv_company uuid;
BEGIN
  IF NEW.conversation_id IS NOT NULL THEN
    SELECT company_id INTO v_conv_company
      FROM public.conversations WHERE id = NEW.conversation_id;
    IF NEW.company_id IS DISTINCT FROM v_conv_company THEN
      RAISE EXCEPTION 'CE_SCOPE_MISMATCH: upstream_call_log.company_id != conversation.company_id';
    END IF;
  END IF;
  -- No raw prompt / provider response may be persisted in observability rows.
  IF NEW.request_payload IS NOT NULL AND (
       NEW.request_payload ? 'prompt' OR NEW.request_payload ? 'messages'
    OR NEW.request_payload ? 'raw_response' OR NEW.request_payload ? 'provider_response') THEN
    RAISE EXCEPTION 'CE_RAW_PAYLOAD_FORBIDDEN: upstream_call_log stores sanitized metadata only';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_ce_upstream_log_company ON public.upstream_call_log;
CREATE TRIGGER trg_ce_upstream_log_company
  BEFORE INSERT OR UPDATE ON public.upstream_call_log
  FOR EACH ROW EXECUTE FUNCTION public.ce_enforce_upstream_log_company();

ALTER TABLE public.upstream_call_log ENABLE ROW LEVEL SECURITY;

INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration)
VALUES
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_enforce_conversation_company()',true),
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_enforce_upstream_log_company()',true),
  ('20260805012800_task1_ce_grounding_replay','trigger','conversations:trg_ce_conversation_company',true),
  ('20260805012800_task1_ce_grounding_replay','trigger','upstream_call_log:trg_ce_upstream_log_company',true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Immutable replay bundles + grounding evidence (joined by chunk_id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ce_replay_bundle (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id               uuid REFERENCES public.conversation_evaluation(id) ON DELETE RESTRICT,
  attempt_id                  uuid NOT NULL REFERENCES public.conversation_evaluation_attempt(id) ON DELETE RESTRICT,
  conversation_id             uuid NOT NULL REFERENCES public.conversations(id) ON DELETE RESTRICT,
  company_id                  uuid REFERENCES public.company(id),
  workspace_id                uuid,
  tenant_id                   uuid,
  bundle_version              integer NOT NULL DEFAULT 1,
  transcript_redacted         jsonb NOT NULL,
  evaluated_reply_message_id  uuid REFERENCES public.messages(id),
  human_response_message_id   uuid REFERENCES public.messages(id),
  truncation_manifest         jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluation_contract_version text NOT NULL,
  model_version               text NOT NULL,
  prompt_version              text NOT NULL,
  kb_snapshot_id              text NOT NULL,
  policy_snapshot_id          text NOT NULL,
  snapshot_hash               text NOT NULL,
  raw_evaluator_payload       jsonb,           -- admin-only, see policies below
  retention_expires_at        timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, bundle_version)
);
GRANT SELECT ON public.ce_replay_bundle TO authenticated;
GRANT ALL    ON public.ce_replay_bundle TO service_role;
ALTER TABLE public.ce_replay_bundle ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.ce_replay_chunk (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id           uuid NOT NULL REFERENCES public.ce_replay_bundle(id) ON DELETE CASCADE,
  chunk_id            text NOT NULL,
  company_id          uuid REFERENCES public.company(id),
  workspace_id        uuid,
  tenant_id           uuid,
  content_hash        text NOT NULL,
  chunk_text_redacted text NOT NULL,
  score               numeric(6,4),
  source_ref          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bundle_id, chunk_id)
);
GRANT SELECT ON public.ce_replay_chunk TO authenticated;
GRANT ALL    ON public.ce_replay_chunk TO service_role;
ALTER TABLE public.ce_replay_chunk ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.ce_grounding_violation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id       uuid REFERENCES public.conversation_evaluation_attempt(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  company_id       uuid REFERENCES public.company(id),
  violation_code   text NOT NULL,
  detail_sanitized jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.ce_grounding_violation TO authenticated;
GRANT ALL    ON public.ce_grounding_violation TO service_role;
ALTER TABLE public.ce_grounding_violation ENABLE ROW LEVEL SECURITY;

-- Immutability: append-only
CREATE OR REPLACE FUNCTION public.ce_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  RAISE EXCEPTION 'CE_IMMUTABLE: % rows cannot be modified', TG_TABLE_NAME;
END $fn$;

DROP TRIGGER IF EXISTS trg_ce_replay_bundle_immutable ON public.ce_replay_bundle;
CREATE TRIGGER trg_ce_replay_bundle_immutable BEFORE UPDATE ON public.ce_replay_bundle
  FOR EACH ROW EXECUTE FUNCTION public.ce_block_mutation();

DROP TRIGGER IF EXISTS trg_ce_replay_chunk_immutable ON public.ce_replay_chunk;
CREATE TRIGGER trg_ce_replay_chunk_immutable BEFORE UPDATE ON public.ce_replay_chunk
  FOR EACH ROW EXECUTE FUNCTION public.ce_block_mutation();

-- Raw evaluator payload lives on ce_replay_bundle, whose SELECT policy is
-- admin-only. QA/agent read the sanitized view instead.
DROP POLICY IF EXISTS ce_replay_bundle_admin_read ON public.ce_replay_bundle;
CREATE POLICY ce_replay_bundle_admin_read ON public.ce_replay_bundle
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS ce_replay_chunk_staff_read ON public.ce_replay_chunk;
CREATE POLICY ce_replay_chunk_staff_read ON public.ce_replay_chunk
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS ce_grounding_violation_staff_read ON public.ce_grounding_violation;
CREATE POLICY ce_grounding_violation_staff_read ON public.ce_grounding_violation
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- Sanitized replay projection: security_definer so staff can rebuild replays
-- without gaining access to raw_evaluator_payload (column is not exposed).
CREATE OR REPLACE VIEW public.ce_replay_bundle_sanitized_v AS
SELECT b.id, b.evaluation_id, b.attempt_id, b.conversation_id, b.company_id,
       b.workspace_id, b.tenant_id, b.bundle_version, b.transcript_redacted,
       b.evaluated_reply_message_id, b.human_response_message_id,
       b.truncation_manifest, b.evaluation_contract_version, b.model_version,
       b.prompt_version, b.kb_snapshot_id, b.policy_snapshot_id,
       b.snapshot_hash, b.retention_expires_at, b.created_at
  FROM public.ce_replay_bundle b
 WHERE public.is_staff(auth.uid());

GRANT SELECT ON public.ce_replay_bundle_sanitized_v TO authenticated;
GRANT ALL    ON public.ce_replay_bundle_sanitized_v TO service_role;

INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration)
VALUES
  ('20260805012800_task1_ce_grounding_replay','table','public.ce_replay_bundle',true),
  ('20260805012800_task1_ce_grounding_replay','table','public.ce_replay_chunk',true),
  ('20260805012800_task1_ce_grounding_replay','table','public.ce_grounding_violation',true),
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_block_mutation()',true),
  ('20260805012800_task1_ce_grounding_replay','trigger','ce_replay_bundle:trg_ce_replay_bundle_immutable',true),
  ('20260805012800_task1_ce_grounding_replay','trigger','ce_replay_chunk:trg_ce_replay_chunk_immutable',true),
  ('20260805012800_task1_ce_grounding_replay','view','public.ce_replay_bundle_sanitized_v',true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Fail-closed grounding validator (chunk_id join, never array position)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_validate_grounding(p_expected jsonb, p_response jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $fn$
DECLARE v_exp_ids text[]; v_res_ids text[]; v_id text; v_hash text; v_c jsonb;
BEGIN
  IF p_response IS NULL OR jsonb_typeof(p_response) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CE_SCOPE_ECHO_MISSING');
  END IF;
  IF (p_response->>'workspace_id') IS NULL OR (p_response->>'tenant_id') IS NULL
     OR (p_response->>'company_id') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CE_SCOPE_ECHO_MISSING');
  END IF;
  IF (p_response->>'workspace_id') IS DISTINCT FROM (p_expected->>'workspace_id')
     OR (p_response->>'tenant_id')  IS DISTINCT FROM (p_expected->>'tenant_id')
     OR (p_response->>'company_id') IS DISTINCT FROM (p_expected->>'company_id') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CE_CROSS_TENANT_SCOPE');
  END IF;
  IF jsonb_typeof(p_response->'chunks') <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CE_CHUNK_SCOPE_MISSING');
  END IF;

  SELECT array_agg(c->>'chunk_id' ORDER BY c->>'chunk_id') INTO v_exp_ids
    FROM jsonb_array_elements(p_expected->'chunks') c;
  SELECT array_agg(c->>'chunk_id' ORDER BY c->>'chunk_id') INTO v_res_ids
    FROM jsonb_array_elements(p_response->'chunks') c;

  IF (SELECT count(*) FROM jsonb_array_elements(p_response->'chunks') c)
     <> (SELECT count(DISTINCT c->>'chunk_id') FROM jsonb_array_elements(p_response->'chunks') c) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CE_CHUNK_DUPLICATE');
  END IF;
  IF COALESCE(v_exp_ids,'{}') IS DISTINCT FROM COALESCE(v_res_ids,'{}') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CE_CHUNK_SET_MISMATCH');
  END IF;

  FOR v_c IN SELECT c FROM jsonb_array_elements(p_response->'chunks') c LOOP
    v_id := v_c->>'chunk_id';
    IF (v_c->>'workspace_id') IS DISTINCT FROM (p_expected->>'workspace_id')
       OR (v_c->>'tenant_id')  IS DISTINCT FROM (p_expected->>'tenant_id')
       OR (v_c->>'company_id') IS DISTINCT FROM (p_expected->>'company_id') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CE_CHUNK_CROSS_TENANT', 'chunk_id', v_id);
    END IF;
    SELECT c->>'content_hash' INTO v_hash
      FROM jsonb_array_elements(p_expected->'chunks') c WHERE c->>'chunk_id' = v_id;
    IF v_hash IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CE_CHUNK_UNKNOWN', 'chunk_id', v_id);
    END IF;
    IF (v_c->>'content_hash') IS DISTINCT FROM v_hash THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CE_CONTENT_HASH_MISMATCH', 'chunk_id', v_id);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true);
END $fn$;

