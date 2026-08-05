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
  purged_at                   timestamptz,
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

-- Immutability: append-only, except the retention purge path which may only
-- clear raw payload / raw transcript text. Every audit field is frozen.
CREATE OR REPLACE FUNCTION public.ce_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  RAISE EXCEPTION 'CE_IMMUTABLE: % rows cannot be modified', TG_TABLE_NAME;
END $fn$;

CREATE OR REPLACE FUNCTION public.ce_guard_replay_bundle_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF (NEW.id, NEW.evaluation_id, NEW.attempt_id, NEW.conversation_id, NEW.company_id,
      NEW.workspace_id, NEW.tenant_id, NEW.bundle_version, NEW.evaluated_reply_message_id,
      NEW.human_response_message_id, NEW.truncation_manifest, NEW.evaluation_contract_version,
      NEW.model_version, NEW.prompt_version, NEW.kb_snapshot_id, NEW.policy_snapshot_id,
      NEW.snapshot_hash, NEW.retention_expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.evaluation_id, OLD.attempt_id, OLD.conversation_id, OLD.company_id,
      OLD.workspace_id, OLD.tenant_id, OLD.bundle_version, OLD.evaluated_reply_message_id,
      OLD.human_response_message_id, OLD.truncation_manifest, OLD.evaluation_contract_version,
      OLD.model_version, OLD.prompt_version, OLD.kb_snapshot_id, OLD.policy_snapshot_id,
      OLD.snapshot_hash, OLD.retention_expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'CE_IMMUTABLE: ce_replay_bundle audit fields cannot be modified';
  END IF;

  -- only the purge may touch the remaining columns, and only to clear them
  IF NEW.purged_at IS NULL
     OR OLD.purged_at IS NOT NULL
     OR OLD.retention_expires_at >= now()
     OR NEW.raw_evaluator_payload IS NOT NULL
     OR NEW.transcript_redacted <> '[]'::jsonb THEN
    RAISE EXCEPTION 'CE_IMMUTABLE: ce_replay_bundle rows cannot be modified';
  END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.ce_guard_replay_chunk_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF (NEW.id, NEW.bundle_id, NEW.chunk_id, NEW.company_id, NEW.workspace_id,
      NEW.tenant_id, NEW.content_hash, NEW.score, NEW.source_ref, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.bundle_id, OLD.chunk_id, OLD.company_id, OLD.workspace_id,
      OLD.tenant_id, OLD.content_hash, OLD.score, OLD.source_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'CE_IMMUTABLE: ce_replay_chunk audit fields cannot be modified';
  END IF;
  IF NEW.chunk_text_redacted <> ''
     OR NOT EXISTS (SELECT 1 FROM public.ce_replay_bundle b
                     WHERE b.id = OLD.bundle_id AND b.purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'CE_IMMUTABLE: ce_replay_chunk rows cannot be modified';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_ce_replay_bundle_immutable ON public.ce_replay_bundle;
CREATE TRIGGER trg_ce_replay_bundle_immutable BEFORE UPDATE ON public.ce_replay_bundle
  FOR EACH ROW EXECUTE FUNCTION public.ce_guard_replay_bundle_immutable();

DROP TRIGGER IF EXISTS trg_ce_replay_bundle_no_delete ON public.ce_replay_bundle;
CREATE TRIGGER trg_ce_replay_bundle_no_delete BEFORE DELETE ON public.ce_replay_bundle
  FOR EACH ROW EXECUTE FUNCTION public.ce_block_mutation();

DROP TRIGGER IF EXISTS trg_ce_replay_chunk_immutable ON public.ce_replay_chunk;
CREATE TRIGGER trg_ce_replay_chunk_immutable BEFORE UPDATE ON public.ce_replay_chunk
  FOR EACH ROW EXECUTE FUNCTION public.ce_guard_replay_chunk_immutable();

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
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_guard_replay_bundle_immutable()',true),
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_guard_replay_chunk_immutable()',true),
  ('20260805012800_task1_ce_grounding_replay','trigger','ce_replay_bundle:trg_ce_replay_bundle_no_delete',true),
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


-- ---------------------------------------------------------------------------
-- 5. Retention purge (raw PII / raw LLM data) — audit fields preserved
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_purge_expired_replays()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_n integer;
BEGIN
  -- Purge raw payload + raw transcript/grounding text, keep immutable audit
  -- fields (hashes, versions, ids, timestamps) so provenance survives.
  UPDATE public.ce_replay_bundle
     SET raw_evaluator_payload = NULL,
         transcript_redacted   = '[]'::jsonb,
         purged_at             = now()
   WHERE retention_expires_at < now() AND purged_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.ce_replay_chunk c
     SET chunk_text_redacted = ''
   WHERE EXISTS (SELECT 1 FROM public.ce_replay_bundle b
                  WHERE b.id = c.bundle_id AND b.purged_at IS NOT NULL)
     AND c.chunk_text_redacted <> '';

  RETURN v_n;
END $fn$;

REVOKE ALL ON FUNCTION public.ce_purge_expired_replays() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ce_purge_expired_replays() TO service_role;

INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration)
VALUES
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_validate_grounding(jsonb,jsonb)',true),
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_purge_expired_replays()',true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. Tenant / company membership primitives (server-derived scope)
-- ---------------------------------------------------------------------------
DO $mig$
DECLARE v_key text := '20260805012800_task1_ce_grounding_replay';
BEGIN
  IF to_regclass('public.company_member') IS NULL THEN
    CREATE TABLE public.company_member (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
      user_id    uuid NOT NULL,
      is_active  boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, user_id)
    );
    GRANT SELECT ON public.company_member TO authenticated;
    GRANT ALL    ON public.company_member TO service_role;
    ALTER TABLE public.company_member ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.ce_migration_provenance
      (migration_key, object_type, object_identity, created_by_migration)
    VALUES (v_key,'table','public.company_member',true) ON CONFLICT DO NOTHING;
  END IF;
END
$mig$;

CREATE INDEX IF NOT EXISTS idx_company_member_user ON public.company_member (user_id) WHERE is_active;

CREATE OR REPLACE FUNCTION public.ce_member_company_ids(_user_id uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT m.company_id
    FROM public.company_member m
   WHERE m.user_id = _user_id
     AND m.is_active
$fn$;

CREATE OR REPLACE FUNCTION public.ce_is_company_member(_user_id uuid, _company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT _user_id IS NOT NULL
     AND _company_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.company_member m
                  WHERE m.user_id = _user_id
                    AND m.company_id = _company_id
                    AND m.is_active)
$fn$;

/* Conversation scope resolved server-side; never from client input. */
CREATE OR REPLACE FUNCTION public.ce_conversation_company(_conversation_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT c.company_id FROM public.conversations c WHERE c.id = _conversation_id
$fn$;

REVOKE ALL ON FUNCTION public.ce_member_company_ids(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ce_is_company_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ce_conversation_company(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ce_member_company_ids(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ce_is_company_member(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ce_conversation_company(uuid) TO authenticated, service_role;

INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration)
VALUES
  ('20260805012800_task1_ce_grounding_replay','index','public.idx_company_member_user',true),
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_member_company_ids(uuid)',true),
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_is_company_member(uuid,uuid)',true),
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_conversation_company(uuid)',true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6b. Enforcement gate + safe backfill.
--     Applying this migration must not change behaviour, so tenant grounding
--     is gated on ce_grounding_fail_closed_enabled (inserted disabled at the
--     end of this file). Every scoped row is backfilled onto one provisioned
--     canonical company so that enabling the flag later is a no-downtime step
--     instead of a blackout. Backfilled rows are recorded as 'seed' provenance
--     so the rollback reverts exactly its own writes and nothing else.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_tenant_enforced()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT COALESCE((SELECT f.enabled FROM public.ce_feature_flags f
                    WHERE f.key = 'ce_grounding_fail_closed_enabled'), false)
$fn$;
REVOKE ALL ON FUNCTION public.ce_tenant_enforced() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ce_tenant_enforced() TO authenticated, service_role;

DO $mig$
DECLARE
  v_key  text := '20260805012800_task1_ce_grounding_replay';
  v_seed uuid := '0e51e0c0-0000-4000-8000-ce0000000001'::uuid;
  v_n    bigint;
BEGIN
  INSERT INTO public.company (id, workspace_id, tenant_id, name)
  VALUES (v_seed, v_seed, v_seed, 'Default Canonical Company')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.ce_migration_provenance
    (migration_key, object_type, object_identity, created_by_migration, notes)
  VALUES (v_key, 'seed', 'public.company:' || v_seed::text, true,
          'provisioned canonical company root for backfill')
  ON CONFLICT DO NOTHING;

  -- channel_config first: the conversation trigger compares against it.
  UPDATE public.channel_config SET company_id = v_seed WHERE company_id IS NULL;
  -- conversations without a channel must stay unscoped (trigger invariant).
  UPDATE public.conversations SET company_id = v_seed
   WHERE company_id IS NULL AND channel_config_id IS NOT NULL;
  UPDATE public.upstream_call_log l SET company_id = v_seed
   WHERE l.company_id IS NULL
     AND EXISTS (SELECT 1 FROM public.conversations c
                  WHERE c.id = l.conversation_id AND c.company_id = v_seed);

  INSERT INTO public.company_member (company_id, user_id)
  SELECT DISTINCT v_seed, r.user_id FROM public.user_roles r
  ON CONFLICT (company_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  INSERT INTO public.ce_migration_provenance
    (migration_key, object_type, object_identity, created_by_migration, notes)
  VALUES (v_key, 'seed', 'public.company_member:' || v_seed::text, true,
          'staff membership backfill (' || v_n || ' row(s))')
  ON CONFLICT DO NOTHING;
END
$mig$;

INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration)
VALUES ('20260805012800_task1_ce_grounding_replay','function','public.ce_tenant_enforced()',true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7. Fail-closed tenant grounding on top of existing role policies.
--    RESTRICTIVE policies narrow (AND) every existing permissive policy, so
--    once the gate flag is on, is_staff alone is no longer sufficient anywhere
--    in the CE surface.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS company_staff_read ON public.company;

CREATE POLICY company_member_read ON public.company
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()) AND public.ce_is_company_member(auth.uid(), id));

DROP POLICY IF EXISTS company_member_self_read ON public.company_member;
CREATE POLICY company_member_self_read ON public.company_member
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS ce_replay_bundle_admin_read ON public.ce_replay_bundle;
CREATE POLICY ce_replay_bundle_admin_read ON public.ce_replay_bundle
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role)
         AND public.ce_is_company_member(auth.uid(), company_id));

DROP POLICY IF EXISTS ce_replay_chunk_staff_read ON public.ce_replay_chunk;
CREATE POLICY ce_replay_chunk_staff_read ON public.ce_replay_chunk
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid())
         AND public.ce_is_company_member(auth.uid(), company_id));

DROP POLICY IF EXISTS ce_grounding_violation_staff_read ON public.ce_grounding_violation;
CREATE POLICY ce_grounding_violation_staff_read ON public.ce_grounding_violation
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid())
         AND public.ce_is_company_member(auth.uid(), company_id));

DROP POLICY IF EXISTS ce_tenant_scope_conversations ON public.conversations;
CREATE POLICY ce_tenant_scope_conversations ON public.conversations AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (NOT public.ce_tenant_enforced()
         OR public.ce_is_company_member(auth.uid(), company_id))
  WITH CHECK (NOT public.ce_tenant_enforced()
         OR public.ce_is_company_member(auth.uid(), company_id));

DROP POLICY IF EXISTS ce_tenant_scope_messages ON public.messages;
CREATE POLICY ce_tenant_scope_messages ON public.messages AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (NOT public.ce_tenant_enforced()
         OR public.ce_is_company_member(auth.uid(),
              public.ce_conversation_company(conversation_id)))
  WITH CHECK (NOT public.ce_tenant_enforced()
         OR public.ce_is_company_member(auth.uid(),
              public.ce_conversation_company(conversation_id)));

DROP POLICY IF EXISTS ce_tenant_scope_evaluation ON public.conversation_evaluation;
CREATE POLICY ce_tenant_scope_evaluation ON public.conversation_evaluation AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (NOT public.ce_tenant_enforced()
         OR public.ce_is_company_member(auth.uid(),
              public.ce_conversation_company(conversation_id)))
  WITH CHECK (NOT public.ce_tenant_enforced()
         OR public.ce_is_company_member(auth.uid(),
              public.ce_conversation_company(conversation_id)));

DROP POLICY IF EXISTS ce_tenant_scope_attempt ON public.conversation_evaluation_attempt;
CREATE POLICY ce_tenant_scope_attempt ON public.conversation_evaluation_attempt AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (NOT public.ce_tenant_enforced()
         OR public.ce_is_company_member(auth.uid(),
              public.ce_conversation_company(conversation_id)))
  WITH CHECK (NOT public.ce_tenant_enforced()
         OR public.ce_is_company_member(auth.uid(),
              public.ce_conversation_company(conversation_id)));

DROP POLICY IF EXISTS ce_tenant_scope_detail ON public.conversation_evaluation_detail;
CREATE POLICY ce_tenant_scope_detail ON public.conversation_evaluation_detail AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (NOT public.ce_tenant_enforced()
         OR EXISTS (SELECT 1 FROM public.conversation_evaluation e
                     WHERE e.id = evaluation_id
                       AND public.ce_is_company_member(auth.uid(),
                             public.ce_conversation_company(e.conversation_id))))
  WITH CHECK (NOT public.ce_tenant_enforced()
         OR EXISTS (SELECT 1 FROM public.conversation_evaluation e
                     WHERE e.id = evaluation_id
                       AND public.ce_is_company_member(auth.uid(),
                             public.ce_conversation_company(e.conversation_id))));

DROP POLICY IF EXISTS ce_raw_llm_admin_only_detail ON public.conversation_evaluation_detail;
CREATE POLICY ce_raw_llm_admin_only_detail ON public.conversation_evaluation_detail AS RESTRICTIVE
  FOR SELECT TO authenticated
  USING (raw_llm_response IS NULL
         OR public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS ce_tenant_scope_outbox ON public.evaluation_training_outbox;
CREATE POLICY ce_tenant_scope_outbox ON public.evaluation_training_outbox AS RESTRICTIVE
  FOR ALL TO authenticated
  USING (NOT public.ce_tenant_enforced()
         OR EXISTS (SELECT 1 FROM public.conversation_evaluation e
                     WHERE e.id = evaluation_id
                       AND public.ce_is_company_member(auth.uid(),
                             public.ce_conversation_company(e.conversation_id))))
  WITH CHECK (NOT public.ce_tenant_enforced()
         OR EXISTS (SELECT 1 FROM public.conversation_evaluation e
                     WHERE e.id = evaluation_id
                       AND public.ce_is_company_member(auth.uid(),
                             public.ce_conversation_company(e.conversation_id))));


INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration)
VALUES
  ('20260805012800_task1_ce_grounding_replay','policy','public.company:company_member_read',true),
  ('20260805012800_task1_ce_grounding_replay','policy','public.company_member:company_member_self_read',true),
  ('20260805012800_task1_ce_grounding_replay','policy','public.conversations:ce_tenant_scope_conversations',true),
  ('20260805012800_task1_ce_grounding_replay','policy','public.messages:ce_tenant_scope_messages',true),
  ('20260805012800_task1_ce_grounding_replay','policy','public.conversation_evaluation:ce_tenant_scope_evaluation',true),
  ('20260805012800_task1_ce_grounding_replay','policy','public.conversation_evaluation_attempt:ce_tenant_scope_attempt',true),
  ('20260805012800_task1_ce_grounding_replay','policy','public.conversation_evaluation_detail:ce_tenant_scope_detail',true),
  ('20260805012800_task1_ce_grounding_replay','policy','public.conversation_evaluation_detail:ce_raw_llm_admin_only_detail',true),
  ('20260805012800_task1_ce_grounding_replay','policy','public.evaluation_training_outbox:ce_tenant_scope_outbox',true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. Review workflow + downstream improved-training-result link
-- ---------------------------------------------------------------------------
DO $mig$
DECLARE v_key text := '20260805012800_task1_ce_grounding_replay';
BEGIN
  IF to_regclass('public.ce_evaluation_review') IS NULL THEN
    CREATE TABLE public.ce_evaluation_review (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id uuid NOT NULL UNIQUE
                      REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
      company_id    uuid REFERENCES public.company(id),
      review_status text NOT NULL CHECK (review_status IN ('pending','accepted','rejected')),
      reviewer_id   uuid NOT NULL,
      notes         text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );
    GRANT SELECT ON public.ce_evaluation_review TO authenticated;
    GRANT ALL    ON public.ce_evaluation_review TO service_role;
    ALTER TABLE public.ce_evaluation_review ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ce_review_member_read ON public.ce_evaluation_review
      FOR SELECT TO authenticated
      USING (public.is_staff(auth.uid())
             AND public.ce_is_company_member(auth.uid(), company_id));
    INSERT INTO public.ce_migration_provenance
      (migration_key, object_type, object_identity, created_by_migration)
    VALUES (v_key,'table','public.ce_evaluation_review',true),
           (v_key,'policy','public.ce_evaluation_review:ce_review_member_read',true)
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.ce_training_result') IS NULL THEN
    CREATE TABLE public.ce_training_result (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id uuid NOT NULL UNIQUE
                      REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
      company_id    uuid REFERENCES public.company(id),
      result_status text NOT NULL CHECK (result_status IN ('pending','received')),
      improved_reply_redacted text,
      received_at   timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    GRANT SELECT ON public.ce_training_result TO authenticated;
    GRANT ALL    ON public.ce_training_result TO service_role;
    ALTER TABLE public.ce_training_result ENABLE ROW LEVEL SECURITY;
    CREATE POLICY ce_training_result_member_read ON public.ce_training_result
      FOR SELECT TO authenticated
      USING (public.is_staff(auth.uid())
             AND public.ce_is_company_member(auth.uid(), company_id));
    INSERT INTO public.ce_migration_provenance
      (migration_key, object_type, object_identity, created_by_migration)
    VALUES (v_key,'table','public.ce_training_result',true),
           (v_key,'policy','public.ce_training_result:ce_training_result_member_read',true)
    ON CONFLICT DO NOTHING;
  END IF;
END
$mig$;

-- ---------------------------------------------------------------------------
-- 9. Canonical status view — single source of truth for the Console tabs
--      needs_review   : review not yet accepted/rejected, or review-worthy
--      training_ready : accepted + training_eligible + NOT delivered
--                       + no improved result received
--      trained        : outbox delivered OR improved result received
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.ce_conversation_status_v AS
SELECT
  e.id                                   AS evaluation_id,
  e.conversation_id,
  c.company_id,
  e.overall_score,
  e.severity,
  e.training_eligible,
  e.has_verified_human_response,
  e.created_at                           AS evaluated_at,
  COALESCE(r.review_status,'pending')    AS review_status,
  o.status                               AS outbox_status,
  o.delivered_at,
  COALESCE(tr.result_status,'none')      AS improved_result_status,
  tr.received_at                         AS improved_result_received_at,
  (COALESCE(r.review_status,'pending') = 'pending'
     AND (e.severity IN ('critical','high') OR e.overall_score < 70)) AS needs_review,
  (COALESCE(r.review_status,'pending') = 'accepted'
     AND e.training_eligible
     AND COALESCE(o.status,'none') <> 'delivered'
     AND COALESCE(tr.result_status,'none') <> 'received')             AS training_ready,
  (COALESCE(o.status,'none') = 'delivered'
     OR COALESCE(tr.result_status,'none') = 'received')               AS trained,
  CASE
    WHEN COALESCE(tr.result_status,'none') = 'received' THEN 'received'
    WHEN COALESCE(o.status,'none') = 'delivered'
      OR COALESCE(tr.result_status,'none') = 'pending' THEN 'pending'
    ELSE 'not_applicable'
  END                                                                AS improved_result_state
FROM public.conversation_evaluation e
JOIN public.conversations c ON c.id = e.conversation_id
LEFT JOIN public.evaluation_training_outbox o ON o.evaluation_id = e.id
LEFT JOIN public.ce_evaluation_review r       ON r.evaluation_id = e.id
LEFT JOIN public.ce_training_result tr        ON tr.evaluation_id = e.id
WHERE public.is_staff(auth.uid())
  AND public.ce_is_company_member(auth.uid(), c.company_id);

GRANT SELECT ON public.ce_conversation_status_v TO authenticated;
GRANT ALL    ON public.ce_conversation_status_v TO service_role;

INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration)
VALUES ('20260805012800_task1_ce_grounding_replay','view','public.ce_conversation_status_v',true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 10. Canonical RPCs — authenticated, tenant-grounded, idempotent
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ce_assert_scope(_conversation_id uuid, _min_role text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_company uuid; v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'CE_UNAUTHENTICATED'; END IF;
  IF NOT public.is_staff(v_uid) THEN RAISE EXCEPTION 'CE_FORBIDDEN'; END IF;
  IF _min_role = 'admin' AND NOT public.has_role(v_uid,'admin'::public.app_role) THEN
    RAISE EXCEPTION 'CE_FORBIDDEN';
  END IF;
  IF _min_role = 'qa' AND NOT (public.has_role(v_uid,'admin'::public.app_role)
       OR public.has_role(v_uid,'supervisor'::public.app_role)
       OR public.has_role(v_uid,'qa'::public.app_role)) THEN
    RAISE EXCEPTION 'CE_FORBIDDEN';
  END IF;
  v_company := public.ce_conversation_company(_conversation_id);
  IF v_company IS NULL OR NOT public.ce_is_company_member(v_uid, v_company) THEN
    RAISE EXCEPTION 'CE_CROSS_TENANT_DENIED';
  END IF;
  RETURN v_company;
END $fn$;

CREATE OR REPLACE FUNCTION public.ce_initiate_evaluation(
  p_conversation_id uuid, p_contract_version text, p_kb_snapshot_id text,
  p_policy_snapshot_id text, p_model_version text, p_prompt_version text,
  p_input_snapshot_hash text, p_source_deployment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_company uuid; v_uid uuid := auth.uid(); v_attempt uuid;
BEGIN
  v_company := public.ce_assert_scope(p_conversation_id, 'qa');
  IF coalesce(p_input_snapshot_hash,'') = '' OR coalesce(p_contract_version,'') = '' THEN
    RAISE EXCEPTION 'CE_INVALID_INPUT';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_conversation_id::text || p_input_snapshot_hash, 0));

  -- idempotent: identical input snapshot returns the existing attempt
  SELECT a.id INTO v_attempt
    FROM public.conversation_evaluation_attempt a
   WHERE a.conversation_id = p_conversation_id
     AND a.input_snapshot_hash = p_input_snapshot_hash
   ORDER BY a.created_at DESC LIMIT 1;

  IF v_attempt IS NULL THEN
    INSERT INTO public.conversation_evaluation_attempt (
      conversation_id, evaluation_contract_version, input_snapshot_hash, status,
      pipeline_run_id, initiated_by, kb_snapshot_id, policy_snapshot_id,
      model_version, prompt_version, source_deployment)
    VALUES (p_conversation_id, p_contract_version, p_input_snapshot_hash, 'running',
            gen_random_uuid(), v_uid, p_kb_snapshot_id, p_policy_snapshot_id,
            p_model_version, p_prompt_version, p_source_deployment)
    RETURNING id INTO v_attempt;
  END IF;

  RETURN jsonb_build_object('ok', true, 'attempt_id', v_attempt, 'company_id', v_company);
END $fn$;

CREATE OR REPLACE FUNCTION public.ce_complete_evaluation(
  p_attempt_id uuid, p_scores jsonb, p_details jsonb, p_snapshot_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  a           public.conversation_evaluation_attempt;
  v_company   uuid;
  v_uid       uuid := auth.uid();
  v_eval      uuid;
  v_keys      text[] := ARRAY['accuracy','policy','tone','sales','context','hallucination_risk'];
  k           text;
  v_val       numeric;
  v_overall   numeric;
  v_quality   numeric;
  v_sev       text;
  v_verified  boolean;
  d           jsonb;
BEGIN
  SELECT * INTO a FROM public.conversation_evaluation_attempt WHERE id = p_attempt_id;
  IF a.id IS NULL THEN RAISE EXCEPTION 'CE_ATTEMPT_NOT_FOUND'; END IF;
  v_company := public.ce_assert_scope(a.conversation_id, 'qa');

  IF p_snapshot_hash IS DISTINCT FROM a.input_snapshot_hash THEN
    RAISE EXCEPTION 'CE_SNAPSHOT_HASH_MISMATCH';
  END IF;

  IF p_scores IS NULL OR jsonb_typeof(p_scores) <> 'object' THEN
    RAISE EXCEPTION 'CE_INVALID_SCORES';
  END IF;
  FOREACH k IN ARRAY v_keys LOOP
    IF NOT (p_scores ? k) THEN RAISE EXCEPTION 'CE_INVALID_SCORES: missing %', k; END IF;
    BEGIN
      v_val := (p_scores->>k)::numeric;
    EXCEPTION WHEN others THEN RAISE EXCEPTION 'CE_INVALID_SCORES: % not numeric', k;
    END;
    IF v_val < 0 OR v_val > 100 THEN RAISE EXCEPTION 'CE_INVALID_SCORES: % out of range', k; END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_object_keys(p_scores)) <> array_length(v_keys,1) THEN
    RAISE EXCEPTION 'CE_INVALID_SCORES: unexpected keys';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_attempt_id::text, 0));

  -- concurrency-safe idempotency: one evaluation per attempt
  SELECT id INTO v_eval FROM public.conversation_evaluation WHERE attempt_id = p_attempt_id;
  IF v_eval IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'evaluation_id', v_eval, 'idempotent', true);
  END IF;

  v_quality := round(100 - (p_scores->>'hallucination_risk')::numeric, 2);
  v_overall := round(
      (p_scores->>'accuracy')::numeric * 0.25
    + (p_scores->>'policy')::numeric   * 0.20
    + (p_scores->>'tone')::numeric     * 0.20
    + (p_scores->>'sales')::numeric    * 0.15
    + (p_scores->>'context')::numeric  * 0.10
    + v_quality                        * 0.10, 2);
  v_sev := CASE WHEN v_overall < 60 THEN 'critical'
                WHEN v_overall < 70 THEN 'high'
                WHEN v_overall < 80 THEN 'medium'
                ELSE 'low' END;
  v_verified := public.verified_human_response(a.conversation_id);

  INSERT INTO public.conversation_evaluation (
    attempt_id, conversation_id, evaluation_contract_version, input_snapshot_hash,
    accuracy_score, policy_score, tone_score, sales_score, context_score,
    hallucination_risk_score, hallucination_quality_score, overall_score, severity,
    has_verified_human_response, training_eligible, model_version, prompt_version,
    kb_snapshot_id, policy_snapshot_id, source_deployment, evaluated_by)
  VALUES (
    a.id, a.conversation_id, a.evaluation_contract_version, a.input_snapshot_hash,
    (p_scores->>'accuracy')::numeric, (p_scores->>'policy')::numeric,
    (p_scores->>'tone')::numeric, (p_scores->>'sales')::numeric,
    (p_scores->>'context')::numeric, (p_scores->>'hallucination_risk')::numeric,
    v_quality, v_overall, v_sev, v_verified,
    (v_overall < 70 AND v_verified), a.model_version, a.prompt_version,
    a.kb_snapshot_id, a.policy_snapshot_id, a.source_deployment, v_uid)
  RETURNING id INTO v_eval;

  IF p_details IS NOT NULL AND jsonb_typeof(p_details) = 'array' THEN
    FOR d IN SELECT value FROM jsonb_array_elements(p_details) LOOP
      INSERT INTO public.conversation_evaluation_detail (
        evaluation_id, evaluator_type, raw_score, weight, weighted_score,
        justification, raw_llm_response)
      VALUES (v_eval, d->>'evaluator_type', (d->>'raw_score')::numeric,
              (d->>'weight')::numeric, (d->>'weighted_score')::numeric,
              left(coalesce(d->>'justification',''), 2000),
              d->'raw_llm_response');
    END LOOP;
  END IF;

  UPDATE public.conversation_evaluation_attempt
     SET status = 'succeeded', updated_at = now() WHERE id = a.id;

  INSERT INTO public.ce_evaluation_review (evaluation_id, company_id, review_status, reviewer_id)
  VALUES (v_eval, v_company, 'pending', v_uid)
  ON CONFLICT (evaluation_id) DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'evaluation_id', v_eval,
    'overall_score', v_overall, 'severity', v_sev,
    'training_eligible', (v_overall < 70 AND v_verified));
END $fn$;

CREATE OR REPLACE FUNCTION public.ce_submit_review(
  p_evaluation_id uuid, p_review_status text, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_conv uuid; v_company uuid; v_uid uuid := auth.uid(); v_eligible boolean;
BEGIN
  IF p_review_status NOT IN ('accepted','rejected','pending') THEN
    RAISE EXCEPTION 'CE_INVALID_REVIEW_STATUS';
  END IF;
  SELECT conversation_id, training_eligible INTO v_conv, v_eligible
    FROM public.conversation_evaluation WHERE id = p_evaluation_id;
  IF v_conv IS NULL THEN RAISE EXCEPTION 'CE_EVALUATION_NOT_FOUND'; END IF;
  v_company := public.ce_assert_scope(v_conv, 'qa');

  INSERT INTO public.ce_evaluation_review
    (evaluation_id, company_id, review_status, reviewer_id, notes)
  VALUES (p_evaluation_id, v_company, p_review_status, v_uid, left(coalesce(p_notes,''),2000))
  ON CONFLICT (evaluation_id) DO UPDATE
    SET review_status = EXCLUDED.review_status,
        reviewer_id   = EXCLUDED.reviewer_id,
        notes         = EXCLUDED.notes,
        updated_at    = now();

  -- accepted + eligible => queue for the downstream training consumer
  IF p_review_status = 'accepted' AND v_eligible THEN
    INSERT INTO public.ce_training_result (evaluation_id, company_id, result_status)
    VALUES (p_evaluation_id, v_company, 'pending')
    ON CONFLICT (evaluation_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true, 'evaluation_id', p_evaluation_id,
                            'review_status', p_review_status);
END $fn$;

CREATE OR REPLACE FUNCTION public.ce_get_replay_bundle(p_attempt_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE b public.ce_replay_bundle; v_uid uuid := auth.uid(); v_is_admin boolean;
BEGIN
  SELECT * INTO b FROM public.ce_replay_bundle
   WHERE attempt_id = p_attempt_id ORDER BY bundle_version DESC LIMIT 1;
  IF b.id IS NULL THEN RAISE EXCEPTION 'CE_REPLAY_BUNDLE_UNAVAILABLE'; END IF;
  PERFORM public.ce_assert_scope(b.conversation_id, 'qa');
  v_is_admin := public.has_role(v_uid,'admin'::public.app_role);

  RETURN jsonb_build_object(
    'ok', true,
    'bundle', jsonb_build_object(
      'id', b.id, 'attempt_id', b.attempt_id, 'evaluation_id', b.evaluation_id,
      'conversation_id', b.conversation_id, 'company_id', b.company_id,
      'bundle_version', b.bundle_version,
      'transcript_redacted', b.transcript_redacted,
      'evaluated_reply_message_id', b.evaluated_reply_message_id,
      'human_response_message_id', b.human_response_message_id,
      'truncation_manifest', b.truncation_manifest,
      'evaluation_contract_version', b.evaluation_contract_version,
      'model_version', b.model_version, 'prompt_version', b.prompt_version,
      'kb_snapshot_id', b.kb_snapshot_id, 'policy_snapshot_id', b.policy_snapshot_id,
      'snapshot_hash', b.snapshot_hash, 'purged_at', b.purged_at,
      'retention_expires_at', b.retention_expires_at),
    'grounding', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'chunk_id', c.chunk_id, 'company_id', c.company_id,
               'workspace_id', c.workspace_id, 'tenant_id', c.tenant_id,
               'content_hash', c.content_hash,
               'chunk_text_redacted', c.chunk_text_redacted,
               'score', c.score, 'source_ref', c.source_ref) ORDER BY c.chunk_id)
        FROM public.ce_replay_chunk c WHERE c.bundle_id = b.id), '[]'::jsonb),
    'raw_evaluator_payload',
      CASE WHEN v_is_admin THEN b.raw_evaluator_payload ELSE NULL END);
END $fn$;

REVOKE ALL ON FUNCTION public.ce_assert_scope(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ce_initiate_evaluation(uuid,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ce_complete_evaluation(uuid,jsonb,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ce_submit_review(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ce_get_replay_bundle(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ce_assert_scope(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ce_initiate_evaluation(uuid,text,text,text,text,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ce_complete_evaluation(uuid,jsonb,jsonb,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ce_submit_review(uuid,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ce_get_replay_bundle(uuid) TO authenticated, service_role;

INSERT INTO public.ce_migration_provenance
  (migration_key, object_type, object_identity, created_by_migration)
VALUES
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_assert_scope(uuid,text)',true),
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_initiate_evaluation(uuid,text,text,text,text,text,text,text)',true),
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_complete_evaluation(uuid,jsonb,jsonb,text)',true),
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_submit_review(uuid,text,text)',true),
  ('20260805012800_task1_ce_grounding_replay','function','public.ce_get_replay_bundle(uuid)',true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 11. Feature flags for this slice — default OFF, no behaviour change on apply
-- ---------------------------------------------------------------------------
INSERT INTO public.ce_feature_flags (key, enabled, updated_at)
VALUES ('ce_grounding_fail_closed_enabled', false, now()),
       ('ce_replay_bundle_enabled',         false, now()),
       ('ce_console_ui_enabled',            false, now())
ON CONFLICT (key) DO NOTHING;

COMMIT;
