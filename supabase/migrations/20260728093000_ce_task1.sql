-- =====================================================================
-- Task 1 — Conversation Evaluation (single atomic transaction)
-- Migration id: 20260728093000_ce_task1
-- =====================================================================
BEGIN;
SET LOCAL client_min_messages = WARNING;

-- 0. Ledger bootstrap
DO $boot$
DECLARE v_pre boolean;
BEGIN
  v_pre := to_regclass('public.migration_object_ledger') IS NOT NULL;
  IF NOT v_pre THEN
    CREATE TABLE public.migration_object_ledger (
      migration_id text NOT NULL, object_kind text NOT NULL, object_ident text NOT NULL,
      disposition text NOT NULL CHECK (disposition IN ('created','replaced','revoked','pre_existing')),
      pre_definition text, pre_owner text, pre_acl text, pre_rls_enabled boolean,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (migration_id, object_kind, object_ident));
  END IF;
  INSERT INTO public.migration_object_ledger (migration_id, object_kind, object_ident, disposition)
  VALUES ('20260728093000_ce_task1', 'table', 'public.migration_object_ledger',
          CASE WHEN v_pre THEN 'pre_existing' ELSE 'created' END)
  ON CONFLICT DO NOTHING;
END $boot$;

CREATE OR REPLACE FUNCTION public._ce_ledger(p_kind text, p_ident text, p_disp text,
  p_def text DEFAULT NULL, p_owner text DEFAULT NULL, p_acl text DEFAULT NULL, p_rls boolean DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.migration_object_ledger (migration_id, object_kind, object_ident, disposition,
    pre_definition, pre_owner, pre_acl, pre_rls_enabled)
  VALUES ('20260728093000_ce_task1', p_kind, p_ident, p_disp, p_def, p_owner, p_acl, p_rls)
  ON CONFLICT (migration_id, object_kind, object_ident) DO NOTHING;
$$;

-- Helper: check existence
CREATE OR REPLACE FUNCTION public._ce_exists(p_kind text, p_ident text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE a text; b text;
BEGIN
  CASE p_kind
    WHEN 'table' THEN RETURN to_regclass(p_ident) IS NOT NULL;
    WHEN 'column' THEN
      a := split_part(p_ident, '.', 2); b := split_part(p_ident, '.', 3);
      RETURN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=a AND column_name=b);
    WHEN 'index' THEN RETURN EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=p_ident);
    WHEN 'function' THEN RETURN to_regprocedure(p_ident) IS NOT NULL;
    WHEN 'trigger' THEN
      a := split_part(p_ident, ' ON ', 1); b := split_part(p_ident, ' ON ', 2);
      RETURN EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname=a AND c.oid=b::regclass AND NOT t.tgisinternal);
    WHEN 'constraint' THEN
      a := split_part(p_ident, ' ON ', 1); b := split_part(p_ident, ' ON ', 2);
      RETURN EXISTS (SELECT 1 FROM pg_constraint WHERE conname=a AND conrelid=b::regclass);
    WHEN 'policy' THEN
      a := split_part(p_ident, ' ON ', 1); b := replace(split_part(p_ident, ' ON ', 2), 'public.', '');
      RETURN EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=b AND policyname=a);
    ELSE RAISE EXCEPTION 'unknown kind %', p_kind;
  END CASE;
END $$;

-- Helper: function ACL as text
CREATE OR REPLACE FUNCTION public._ce_facl(p_sig text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(string_agg(a.grantee::regrole::text || ':' || a.privilege_type, ',' ORDER BY 1), '')
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid = to_regprocedure(p_sig);
$$;

-- Helper: table RLS state
CREATE OR REPLACE FUNCTION public._ce_rls(p_table text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT relrowsecurity FROM pg_class WHERE oid = p_table::regclass;
$$;

DO $$ BEGIN PERFORM public._ce_ledger('function', 'public._ce_ledger(text,text,text,text,text,text,boolean)', 'created');
PERFORM public._ce_ledger('function', 'public._ce_exists(text,text)', 'created');
PERFORM public._ce_ledger('function', 'public._ce_facl(text)', 'created');
PERFORM public._ce_ledger('function', 'public._ce_rls(text)', 'created'); END $$;

-- =================================================================
-- 1. Guarded table creation
-- =================================================================
DO $tables$
DECLARE
  v_tbl record;
  v_tables text[][] := ARRAY[
    ARRAY['public.company', $t$CREATE TABLE public.company (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
      display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
      external_workspace_id text NOT NULL CHECK (length(btrim(external_workspace_id)) > 0),
      external_tenant_id text NOT NULL CHECK (length(btrim(external_tenant_id)) > 0),
      is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (external_workspace_id, external_tenant_id))$t$],
    ARRAY['public.company_membership', $t$CREATE TABLE public.company_membership (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
      user_id uuid NOT NULL, role public.app_role NOT NULL,
      is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, user_id, role))$t$],
    ARRAY['public.company_backfill_contract', $t$CREATE TABLE public.company_backfill_contract (
      id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      state text NOT NULL DEFAULT 'awaiting_owner_mapping' CHECK (state IN ('awaiting_owner_mapping','mapping_in_progress','complete')),
      authority text NOT NULL DEFAULT 'production_owner',
      unassigned_conversations bigint,
      notes text NOT NULL DEFAULT 'Existing rows must not be assigned by inference.',
      updated_at timestamptz NOT NULL DEFAULT now())$t$],
    ARRAY['public.ce_bundle_snapshot', $t$CREATE TABLE public.ce_bundle_snapshot (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      attempt_id uuid NOT NULL UNIQUE REFERENCES public.conversation_evaluation_attempt(id) ON DELETE CASCADE,
      conversation_id uuid NOT NULL, company_id uuid NOT NULL,
      bundle_hash text NOT NULL CHECK (bundle_hash ~ '^[0-9a-f]{64}$'),
      transcript_hash text NOT NULL CHECK (transcript_hash ~ '^[0-9a-f]{64}$'),
      evaluation_contract_version text NOT NULL, model_version text NOT NULL, prompt_version text NOT NULL,
      kb_snapshot_id text NOT NULL, policy_snapshot_id text NOT NULL,
      canonical_input text NOT NULL, normalized_transcript jsonb NOT NULL,
      evaluated_ai_reply jsonb, verified_human_response jsonb,
      grounding_evidence jsonb NOT NULL, grounding_manifest jsonb NOT NULL, truncation_manifest jsonb NOT NULL,
      redaction_applied boolean NOT NULL DEFAULT true,
      retention_expires_at timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
      created_at timestamptz NOT NULL DEFAULT now())$t$],
    ARRAY['public.ce_raw_provider_output', $t$CREATE TABLE public.ce_raw_provider_output (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id uuid NOT NULL REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
      evaluator_type text NOT NULL CHECK (evaluator_type IN ('accuracy','policy','tone','sales','context','hallucination','signals')),
      company_id uuid NOT NULL, raw_response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(evaluation_id, evaluator_type))$t$],
    ARRAY['public.ce_emotion_point', $t$CREATE TABLE public.ce_emotion_point (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id uuid NOT NULL REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
      company_id uuid NOT NULL, message_id uuid NOT NULL, turn_index int NOT NULL CHECK (turn_index >= 0),
      occurred_at timestamptz NOT NULL,
      sentiment text NOT NULL CHECK (sentiment IN ('very_negative','negative','neutral','positive','very_positive')),
      sentiment_score numeric(5,2) NOT NULL CHECK (sentiment_score >= -100 AND sentiment_score <= 100),
      trigger_label text, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (evaluation_id, message_id))$t$],
    ARRAY['public.ce_next_step', $t$CREATE TABLE public.ce_next_step (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id uuid NOT NULL REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
      company_id uuid NOT NULL, ordinal int NOT NULL CHECK (ordinal >= 0),
      title text NOT NULL CHECK (length(btrim(title)) > 0), detail text,
      owner_role public.app_role, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (evaluation_id, ordinal))$t$],
    ARRAY['public.ce_discrepancy', $t$CREATE TABLE public.ce_discrepancy (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id uuid NOT NULL REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
      company_id uuid NOT NULL, dimension text NOT NULL CHECK (dimension IN ('accuracy','policy','tone','sales','context','hallucination')),
      ai_claim text NOT NULL, human_claim text, grounded_claim text,
      divergence_kind text NOT NULL CHECK (divergence_kind IN ('contradiction','omission','overreach','unsupported','style')),
      severity text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
      grounding_refs jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now())$t$],
    ARRAY['public.ce_root_cause', $t$CREATE TABLE public.ce_root_cause (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id uuid NOT NULL REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
      company_id uuid NOT NULL,
      category text NOT NULL CHECK (category IN ('kb_gap','kb_stale','policy_gap','prompt_defect','model_limitation','routing_error','human_error','unknown')),
      summary text NOT NULL CHECK (length(btrim(summary)) > 0), evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      recorded_by uuid NOT NULL, remote_sync_state text NOT NULL DEFAULT 'pending' CHECK (remote_sync_state IN ('pending','synced','failed','not_applicable')),
      remote_ref text, created_at timestamptz NOT NULL DEFAULT now())$t$],
    ARRAY['public.ce_qa_case', $t$CREATE TABLE public.ce_qa_case (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id uuid NOT NULL REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
      company_id uuid NOT NULL, case_number text NOT NULL, title text NOT NULL CHECK (length(btrim(title)) > 0),
      description text, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
      priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('urgent','high','medium','low')),
      created_by uuid NOT NULL, remote_sync_state text NOT NULL DEFAULT 'pending' CHECK (remote_sync_state IN ('pending','synced','failed','not_applicable')),
      remote_ref text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (company_id, case_number))$t$],
    ARRAY['public.ce_kb_publish_state', $t$CREATE TABLE public.ce_kb_publish_state (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id uuid NOT NULL REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
      company_id uuid NOT NULL, kb_document_ref text NOT NULL,
      action text NOT NULL CHECK (action IN ('publish','rollback')),
      state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','in_progress','published','rolled_back','failed')),
      requested_by uuid NOT NULL, remote_sync_state text NOT NULL DEFAULT 'pending' CHECK (remote_sync_state IN ('pending','synced','failed','not_applicable')),
      remote_ref text, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())$t$],
    ARRAY['public.ce_training_link', $t$CREATE TABLE public.ce_training_link (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id uuid NOT NULL REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
      company_id uuid NOT NULL, link_kind text NOT NULL CHECK (link_kind IN ('training_candidate','kb_gap')),
      local_state text NOT NULL DEFAULT 'proposed' CHECK (local_state IN ('proposed','accepted','rejected','delivered')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, improved_result jsonb,
      improved_state text NOT NULL DEFAULT 'pending' CHECK (improved_state IN ('pending','received','not_applicable')),
      remote_sync_state text NOT NULL DEFAULT 'pending' CHECK (remote_sync_state IN ('pending','synced','failed','not_applicable')),
      remote_ref text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (evaluation_id, link_kind))$t$]
  ];
  v_n text; v_ddl text; v_rls boolean;
BEGIN
  FOR i IN 1..array_length(v_tables, 1) LOOP
    v_n := v_tables[i][1]; v_ddl := v_tables[i][2];
    IF to_regclass(v_n) IS NOT NULL THEN
      v_rls := (SELECT relrowsecurity FROM pg_class WHERE oid = v_n::regclass);
      PERFORM public._ce_ledger('table', v_n, 'pre_existing', NULL,
        (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename=split_part(v_n,'.',2)),
        NULL, v_rls);
    ELSE
      EXECUTE v_ddl;
      IF to_regclass(v_n) IS NULL THEN RAISE EXCEPTION 'ASSERT: table % not created', v_n; END IF;
      PERFORM public._ce_ledger('table', v_n, 'created');
    END IF;
  END LOOP;
END $tables$;

-- RLS + indexes on new tables
DO $rls$
DECLARE t text; v_rls boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['company','company_membership','company_backfill_contract',
    'ce_bundle_snapshot','ce_raw_provider_output','ce_emotion_point','ce_next_step','ce_discrepancy',
    'ce_root_cause','ce_qa_case','ce_kb_publish_state','ce_training_link'] LOOP
    v_rls := public._ce_rls('public.' || t);
    IF NOT v_rls THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      PERFORM public._ce_ledger('rls', 'public.' || t, 'created', NULL, NULL, NULL, false);
    ELSE
      PERFORM public._ce_ledger('rls', 'public.' || t, 'pre_existing', NULL, NULL, NULL, true);
    END IF;
  END LOOP;
  -- upstream_call_log
  IF NOT public._ce_rls('public.upstream_call_log') THEN
    ALTER TABLE public.upstream_call_log ENABLE ROW LEVEL SECURITY;
    PERFORM public._ce_ledger('rls', 'public.upstream_call_log', 'created', NULL, NULL, NULL, false);
  ELSE
    PERFORM public._ce_ledger('rls', 'public.upstream_call_log', 'pre_existing', NULL, NULL, NULL, true);
  END IF;
END $rls$;

-- =================================================================
-- 2. Column propagation
-- =================================================================
DO $cols$
DECLARE
  v_col record;
  v_cols text[][] := ARRAY[
    ARRAY['public.channel_config', 'company_id', 'uuid REFERENCES public.company(id)'],
    ARRAY['public.conversations', 'company_id', 'uuid REFERENCES public.company(id)'],
    ARRAY['public.conversation_evaluation_attempt', 'company_id', 'uuid REFERENCES public.company(id)'],
    ARRAY['public.conversation_evaluation', 'company_id', 'uuid REFERENCES public.company(id)'],
    ARRAY['public.evaluation_training_outbox', 'company_id', 'uuid REFERENCES public.company(id)'],
    ARRAY['public.upstream_call_log', 'company_id', 'uuid REFERENCES public.company(id)'],
    ARRAY['public.conversation_evaluation', 'review_status', $$text NOT NULL DEFAULT 'pending'$$],
    ARRAY['public.conversation_evaluation', 'review_note', 'text'],
    ARRAY['public.conversation_evaluation', 'reviewed_by', 'uuid'],
    ARRAY['public.conversation_evaluation', 'reviewed_at', 'timestamptz'],
    ARRAY['public.conversation_evaluation', 'bundle_hash', 'text'],
    ARRAY['public.conversation_evaluation', 'grounding_manifest', 'jsonb'],
    ARRAY['public.conversation_evaluation_attempt', 'bundle_hash', 'text'],
    ARRAY['public.conversation_evaluation_attempt', 'grounding_manifest', 'jsonb'],
    ARRAY['public.conversation_evaluation_detail', 'recommended_correction', 'text'],
    ARRAY['public.conversation_evaluation_detail', 'evaluator_model_version', 'text'],
    ARRAY['public.conversation_evaluation_detail', 'evaluator_prompt_version', 'text'],
    ARRAY['public.conversation_evaluation_detail', 'grounding_refs', 'jsonb']
  ];
  v_ident text;
BEGIN
  FOR i IN 1..array_length(v_cols, 1) LOOP
    v_ident := v_cols[i][1] || '.' || v_cols[i][2];
    IF public._ce_exists('column', v_ident) THEN
      PERFORM public._ce_ledger('column', v_ident, 'pre_existing',
        (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
          WHERE a.attrelid = v_cols[i][1]::regclass AND a.attname = v_cols[i][2]));
    ELSE
      EXECUTE format('ALTER TABLE %s ADD COLUMN %I %s', v_cols[i][1], v_cols[i][2], v_cols[i][3]);
      IF NOT public._ce_exists('column', v_ident) THEN
        RAISE EXCEPTION 'ASSERT: column % not created', v_ident; END IF;
      PERFORM public._ce_ledger('column', v_ident, 'created');
    END IF;
  END LOOP;
END $cols$;

-- Constraints
DO $con$
DECLARE v_n text; v_tbl text; v_ddl text; v_ident text;
  v_cons text[][] := ARRAY[
    ARRAY['public.conversation_evaluation', 'ce_review_status_check',
      $$ALTER TABLE public.conversation_evaluation ADD CONSTRAINT ce_review_status_check CHECK (review_status = ANY (ARRAY['pending','accepted','rejected']))$$],
    ARRAY['public.conversation_evaluation', 'ce_review_consistency_check',
      $$ALTER TABLE public.conversation_evaluation ADD CONSTRAINT ce_review_consistency_check CHECK ((review_status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (review_status <> 'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))$$]
  ];
BEGIN
  FOR i IN 1..array_length(v_cons, 1) LOOP
    v_tbl := v_cons[i][1]; v_n := v_cons[i][2]; v_ddl := v_cons[i][3];
    v_ident := v_n || ' ON ' || v_tbl;
    IF public._ce_exists('constraint', v_ident) THEN
      PERFORM public._ce_ledger('constraint', v_ident, 'pre_existing',
        (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname=v_n AND conrelid=v_tbl::regclass));
    ELSE
      EXECUTE v_ddl;
      IF NOT public._ce_exists('constraint', v_ident) THEN
        RAISE EXCEPTION 'ASSERT: constraint % not created', v_ident; END IF;
      PERFORM public._ce_ledger('constraint', v_ident, 'created');
    END IF;
  END LOOP;
END $con$;

-- Feature indexes
DO $idx$
DECLARE
  v_idx record;
  v_idxs text[][] := ARRAY[
    ARRAY['idx_company_membership_user', $d$CREATE INDEX idx_company_membership_user ON public.company_membership (user_id) WHERE is_active$d$],
    ARRAY['idx_conversations_company', $d$CREATE INDEX idx_conversations_company ON public.conversations (company_id)$d$],
    ARRAY['idx_ce_company_created', $d$CREATE INDEX idx_ce_company_created ON public.conversation_evaluation (company_id, created_at DESC)$d$],
    ARRAY['idx_ucl_company_created', $d$CREATE INDEX idx_ucl_company_created ON public.upstream_call_log (company_id, created_at DESC)$d$],
    ARRAY['idx_ce_review_status_created', $d$CREATE INDEX idx_ce_review_status_created ON public.conversation_evaluation (review_status, created_at DESC)$d$],
    ARRAY['idx_bundle_snapshot_conversation', $d$CREATE INDEX idx_bundle_snapshot_conversation ON public.ce_bundle_snapshot (conversation_id, created_at DESC)$d$],
    ARRAY['idx_bundle_snapshot_retention', $d$CREATE INDEX idx_bundle_snapshot_retention ON public.ce_bundle_snapshot (retention_expires_at)$d$]
  ];
BEGIN
  FOR i IN 1..array_length(v_idxs, 1) LOOP
    IF public._ce_exists('index', v_idxs[i][1]) THEN
      PERFORM public._ce_ledger('index', v_idxs[i][1], 'pre_existing',
        (SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=v_idxs[i][1]));
    ELSE
      EXECUTE v_idxs[i][2];
      IF NOT public._ce_exists('index', v_idxs[i][1]) THEN
        RAISE EXCEPTION 'ASSERT: index % not created', v_idxs[i][1]; END IF;
      PERFORM public._ce_ledger('index', v_idxs[i][1], 'created');
    END IF;
  END LOOP;
END $idx$;

DO $idx2$
DECLARE ft text;
BEGIN
  FOREACH ft IN ARRAY ARRAY['ce_emotion_point','ce_next_step','ce_discrepancy','ce_root_cause',
                            'ce_qa_case','ce_kb_publish_state','ce_training_link','ce_raw_provider_output'] LOOP
    IF NOT public._ce_exists('index', 'idx_'||ft||'_eval') THEN
      EXECUTE format('CREATE INDEX %I ON public.%I (evaluation_id)', 'idx_'||ft||'_eval', ft);
      PERFORM public._ce_ledger('index', 'idx_'||ft||'_eval', 'created');
    ELSE
      PERFORM public._ce_ledger('index', 'idx_'||ft||'_eval', 'pre_existing');
    END IF;
  END LOOP;
END $idx2$;

-- Backfill contract
INSERT INTO public.company_backfill_contract (id, unassigned_conversations)
SELECT 1, (SELECT count(*) FROM public.conversations WHERE company_id IS NULL)
ON CONFLICT (id) DO NOTHING;

-- Conversation tenant trigger (INSERT + UPDATE)
DO $trg$
DECLARE v_ident text := 'trg_conversations_company ON public.conversations';
BEGIN
  IF public._ce_exists('trigger', v_ident) THEN
    PERFORM public._ce_ledger('trigger', v_ident, 'pre_existing',
      (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE t.tgname='trg_conversations_company' AND c.oid='public.conversations'::regclass AND NOT t.tgisinternal));
  ELSE
    CREATE OR REPLACE FUNCTION public._ce_enforce_conversation_company()
    RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $fn$
    BEGIN
      IF NEW.company_id IS NULL THEN
        SELECT cc.company_id INTO NEW.company_id
          FROM public.channel_config cc WHERE cc.id = NEW.channel_config_id;
      END IF;
      IF NEW.company_id IS NULL THEN
        RAISE EXCEPTION 'TENANT_UNRESOLVED: conversation requires company_id (channel_config %)', NEW.channel_config_id
          USING ERRCODE = 'check_violation';
      END IF;
      IF TG_OP = 'UPDATE' AND OLD.company_id IS NOT NULL AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
        RAISE EXCEPTION 'TENANT_REASSIGNMENT: conversation company_id cannot change from % to %', OLD.company_id, NEW.company_id
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.channel_config_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.channel_config cc WHERE cc.id = NEW.channel_config_id
                    AND cc.company_id IS NOT NULL AND cc.company_id IS DISTINCT FROM NEW.company_id) THEN
          RAISE EXCEPTION 'TENANT_CHANNEL_MISMATCH: conversation.company_id % vs channel_config.company_id',
            NEW.company_id USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $fn$;

    EXECUTE 'CREATE TRIGGER trg_conversations_company BEFORE INSERT OR UPDATE ON public.conversations
      FOR EACH ROW EXECUTE FUNCTION public._ce_enforce_conversation_company()';
    IF NOT public._ce_exists('trigger', v_ident) THEN
      RAISE EXCEPTION 'ASSERT: trigger not created'; END IF;
    PERFORM public._ce_ledger('trigger', v_ident, 'created');
    PERFORM public._ce_ledger('function', 'public._ce_enforce_conversation_company()', 'created');
  END IF;
END $trg$;

-- Snapshot immutability trigger
DO $si$
DECLARE v_ident text := 'trg_ce_snapshot_immutable ON public.ce_bundle_snapshot';
BEGIN
  IF public._ce_exists('trigger', v_ident) THEN
    PERFORM public._ce_ledger('trigger', v_ident, 'pre_existing');
  ELSE
    CREATE OR REPLACE FUNCTION public._ce_snapshot_immutable()
    RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $fn$
    BEGIN RAISE EXCEPTION 'CE_SNAPSHOT_IMMUTABLE'; END $fn$;
    EXECUTE 'CREATE TRIGGER trg_ce_snapshot_immutable BEFORE UPDATE ON public.ce_bundle_snapshot
      FOR EACH ROW EXECUTE FUNCTION public._ce_snapshot_immutable()';
    PERFORM public._ce_ledger('trigger', v_ident, 'created');
    PERFORM public._ce_ledger('function', 'public._ce_snapshot_immutable()', 'created');
  END IF;
END $si$;

-- =================================================================
-- 3. Membership helpers + policies + legacy bypass + ownership
-- =================================================================
-- Membership/auth helpers, feature RPCs, review, zombie reaper, purge
-- Each is guarded: if the function already exists, capture its definition,
-- owner and ACL as 'replaced'; otherwise record 'created'.

DO $fn_block$
DECLARE
  v_fn record;
  v_fns text[][] := ARRAY[
    ARRAY['public.is_company_member(uuid,uuid)', $body$
CREATE OR REPLACE FUNCTION public.is_company_member(p_company_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.company_membership m JOIN public.company c ON c.id = m.company_id
    WHERE m.company_id = p_company_id AND m.user_id = p_user_id AND m.is_active AND c.is_active); $f$;
$body$],
    ARRAY['public.has_company_role(uuid,uuid,public.app_role)', $body$
CREATE OR REPLACE FUNCTION public.has_company_role(p_company_id uuid, p_user_id uuid, p_role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.company_membership m JOIN public.company c ON c.id = m.company_id
    WHERE m.company_id = p_company_id AND m.user_id = p_user_id AND m.role = p_role
      AND m.is_active AND c.is_active); $f$;
$body$],
    ARRAY['public.ce_company_read(uuid)', $body$
CREATE OR REPLACE FUNCTION public.ce_company_read(p_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $f$
  SELECT p_company_id IS NOT NULL AND public.is_company_member(p_company_id, auth.uid())
    AND (public.has_company_role(p_company_id, auth.uid(), 'admin')
      OR public.has_company_role(p_company_id, auth.uid(), 'supervisor')
      OR public.has_company_role(p_company_id, auth.uid(), 'qa')); $f$;
$body$],
    ARRAY['public.ce_company_elevated(uuid)', $body$
CREATE OR REPLACE FUNCTION public.ce_company_elevated(p_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $f$
  SELECT p_company_id IS NOT NULL
    AND (public.has_company_role(p_company_id, auth.uid(), 'admin')
      OR public.has_company_role(p_company_id, auth.uid(), 'supervisor')); $f$;
$body$],
    ARRAY['public.ce_purge_expired_snapshots()', $body$
CREATE OR REPLACE FUNCTION public.ce_purge_expired_snapshots()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $f$
DECLARE v_n int;
BEGIN
  WITH gone AS (DELETE FROM public.ce_bundle_snapshot WHERE retention_expires_at < now() RETURNING 1)
  SELECT count(*) INTO v_n FROM gone;
  RETURN jsonb_build_object('result','success','purged',v_n);
END $f$;
$body$],
    ARRAY['public.reap_stale_evaluation_attempts(interval)', $body$
CREATE OR REPLACE FUNCTION public.reap_stale_evaluation_attempts(p_older_than interval DEFAULT '15 minutes')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $f$
DECLARE v_n int;
BEGIN
  WITH reaped AS (
    UPDATE public.conversation_evaluation_attempt SET status='failed',
           error_message='CE_ATTEMPT_ABANDONED', updated_at=now()
     WHERE status='running' AND created_at < now() - p_older_than
       AND NOT EXISTS (SELECT 1 FROM public.conversation_evaluation ce WHERE ce.attempt_id = conversation_evaluation_attempt.id)
    RETURNING 1)
  SELECT count(*) INTO v_n FROM reaped;
  RETURN jsonb_build_object('result','success','reaped',v_n);
END $f$;
$body$]
  ];
  v_sig text; v_ddl text; v_pre_def text; v_pre_owner text; v_pre_acl text;
BEGIN
  FOR i IN 1..array_length(v_fns, 1) LOOP
    v_sig := v_fns[i][1]; v_ddl := v_fns[i][2];
    IF public._ce_exists('function', v_sig) THEN
      v_pre_def := pg_get_functiondef(to_regprocedure(v_sig));
      v_pre_owner := (SELECT proowner::regrole::text FROM pg_proc WHERE oid = to_regprocedure(v_sig));
      v_pre_acl := public._ce_facl(v_sig);
      EXECUTE v_ddl;
      PERFORM public._ce_ledger('function', v_sig, 'replaced', v_pre_def, v_pre_owner, v_pre_acl);
    ELSE
      EXECUTE v_ddl;
      IF NOT public._ce_exists('function', v_sig) THEN
        RAISE EXCEPTION 'ASSERT: function % not created', v_sig; END IF;
      PERFORM public._ce_ledger('function', v_sig, 'created');
    END IF;
  END LOOP;
END $fn_block$;

-- Policies (capture pre-state for replaced policies including permissive/restrictive)
DO $pol_block$
DECLARE
  v_pol record;
  v_pols text[][] := ARRAY[
    ARRAY['company', 'company_sel', $p$CREATE POLICY company_sel ON public.company FOR SELECT TO authenticated
      USING (public.is_company_member(id, auth.uid()))$p$],
    ARRAY['company', 'company_nw', $p$CREATE POLICY company_nw ON public.company FOR ALL TO authenticated USING (false) WITH CHECK (false)$p$],
    ARRAY['company_membership', 'cm_sel', $p$CREATE POLICY cm_sel ON public.company_membership FOR SELECT TO authenticated
      USING (user_id = auth.uid() OR public.has_company_role(company_id, auth.uid(), 'admin'))$p$],
    ARRAY['company_membership', 'cm_nw', $p$CREATE POLICY cm_nw ON public.company_membership FOR ALL TO authenticated USING (false) WITH CHECK (false)$p$],
    ARRAY['conversation_evaluation', 'ev_sel', $p$CREATE POLICY ev_sel ON public.conversation_evaluation FOR SELECT TO authenticated
      USING (company_id IS NOT NULL AND public.is_company_member(company_id, auth.uid())
        AND (public.ce_company_read(company_id)
          OR (public.has_company_role(company_id, auth.uid(), 'agent')
              AND EXISTS (SELECT 1 FROM public.conversations c JOIN public.agent_profile ap ON ap.id = c.assigned_agent_id
                WHERE c.id = conversation_evaluation.conversation_id AND ap.user_id = auth.uid() AND ap.status = 'active'))))$p$],
    ARRAY['conversation_evaluation_detail', 'dt_sel', $p$CREATE POLICY dt_sel ON public.conversation_evaluation_detail FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.conversation_evaluation ce
        WHERE ce.id = conversation_evaluation_detail.evaluation_id AND ce.company_id IS NOT NULL
          AND public.is_company_member(ce.company_id, auth.uid())
          AND (public.ce_company_read(ce.company_id)
            OR (public.has_company_role(ce.company_id, auth.uid(), 'agent')
                AND EXISTS (SELECT 1 FROM public.conversations c JOIN public.agent_profile ap ON ap.id = c.assigned_agent_id
                  WHERE c.id = ce.conversation_id AND ap.user_id = auth.uid() AND ap.status = 'active')))))$p$],
    ARRAY['conversation_evaluation_attempt', 'att_sel', $p$CREATE POLICY att_sel ON public.conversation_evaluation_attempt FOR SELECT TO authenticated
      USING (public.ce_company_read(company_id))$p$],
    ARRAY['evaluation_training_outbox', 'ob_sel', $p$CREATE POLICY ob_sel ON public.evaluation_training_outbox FOR SELECT TO authenticated
      USING (public.ce_company_elevated(company_id))$p$],
    ARRAY['ce_bundle_snapshot', 'bs_sel', $p$CREATE POLICY bs_sel ON public.ce_bundle_snapshot FOR SELECT TO authenticated
      USING (public.ce_company_read(company_id))$p$],
    ARRAY['ce_bundle_snapshot', 'bs_nw', $p$CREATE POLICY bs_nw ON public.ce_bundle_snapshot FOR ALL TO authenticated USING (false) WITH CHECK (false)$p$],
    ARRAY['ce_raw_provider_output', 'rpo_sel', $p$CREATE POLICY rpo_sel ON public.ce_raw_provider_output FOR SELECT TO authenticated
      USING (public.has_company_role(company_id, auth.uid(), 'admin'))$p$],
    ARRAY['ce_raw_provider_output', 'rpo_nw', $p$CREATE POLICY rpo_nw ON public.ce_raw_provider_output FOR ALL TO authenticated USING (false) WITH CHECK (false)$p$],
    ARRAY['upstream_call_log', 'ucl_sel', $p$CREATE POLICY ucl_sel ON public.upstream_call_log FOR SELECT TO authenticated
      USING (public.ce_company_elevated(company_id))$p$],
    ARRAY['upstream_call_log', 'ucl_nw', $p$CREATE POLICY ucl_nw ON public.upstream_call_log FOR ALL TO authenticated USING (false) WITH CHECK (false)$p$]
  ];
  v_table text; v_name text; v_ddl text; v_ident text; v_pre text;
BEGIN
  FOR i IN 1..array_length(v_pols, 1) LOOP
    v_table := v_pols[i][1]; v_name := v_pols[i][2]; v_ddl := v_pols[i][3];
    v_ident := v_name || ' ON public.' || v_table;
    IF public._ce_exists('policy', v_ident) THEN
      -- Capture the full pre-definition including permissive/restrictive and roles
      SELECT format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
        pol.polname, c.relname,
        CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
        CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
             WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END,
        (SELECT string_agg(CASE WHEN r = 0 THEN 'public' ELSE r::regrole::text END, ', ') FROM unnest(pol.polroles) r),
        CASE WHEN pol.polqual IS NULL THEN '' ELSE ' USING (' || pg_get_expr(pol.polqual, pol.polrelid) || ')' END,
        CASE WHEN pol.polwithcheck IS NULL THEN '' ELSE ' WITH CHECK (' || pg_get_expr(pol.polwithcheck, pol.polrelid) || ')' END)
      INTO v_pre
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_table AND pol.polname = v_name;
      EXECUTE format('DROP POLICY %I ON public.%I', v_name, v_table);
      EXECUTE v_ddl;
      PERFORM public._ce_ledger('policy', v_ident, 'replaced', v_pre);
    ELSE
      EXECUTE v_ddl;
      IF NOT public._ce_exists('policy', v_ident) THEN
        RAISE EXCEPTION 'ASSERT: policy % not created', v_ident; END IF;
      PERFORM public._ce_ledger('policy', v_ident, 'created');
    END IF;
  END LOOP;

END $pol_block$;

DO $pol_feat$
DECLARE ft text; v_ident text;
BEGIN
    FOREACH ft IN ARRAY ARRAY['ce_emotion_point','ce_next_step','ce_discrepancy','ce_training_link'] LOOP
      v_ident := ft||'_sel ON public.'||ft;
      IF NOT public._ce_exists('policy', v_ident) THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.ce_company_read(company_id))', ft||'_sel', ft);
        PERFORM public._ce_ledger('policy', v_ident, 'created');
      ELSE PERFORM public._ce_ledger('policy', v_ident, 'pre_existing'); END IF;
      v_ident := ft||'_nw ON public.'||ft;
      IF NOT public._ce_exists('policy', v_ident) THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (false) WITH CHECK (false)', ft||'_nw', ft);
        PERFORM public._ce_ledger('policy', v_ident, 'created');
      ELSE PERFORM public._ce_ledger('policy', v_ident, 'pre_existing'); END IF;
    END LOOP;
    FOREACH ft IN ARRAY ARRAY['ce_root_cause','ce_qa_case','ce_kb_publish_state'] LOOP
      v_ident := ft||'_sel ON public.'||ft;
      IF NOT public._ce_exists('policy', v_ident) THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.ce_company_elevated(company_id))', ft||'_sel', ft);
        PERFORM public._ce_ledger('policy', v_ident, 'created');
      ELSE PERFORM public._ce_ledger('policy', v_ident, 'pre_existing'); END IF;
      v_ident := ft||'_nw ON public.'||ft;
      IF NOT public._ce_exists('policy', v_ident) THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (false) WITH CHECK (false)', ft||'_nw', ft);
        PERFORM public._ce_ledger('policy', v_ident, 'created');
      ELSE PERFORM public._ce_ledger('policy', v_ident, 'pre_existing'); END IF;
    END LOOP;
END $pol_feat$;

-- Legacy bypass closure
DO $legacy$
DECLARE v_acl text;
BEGIN
  IF public._ce_exists('function', 'public.complete_evaluation(uuid,jsonb)') THEN
    v_acl := public._ce_facl('public.complete_evaluation(uuid,jsonb)');
    IF v_acl LIKE '%service_role:EXECUTE%' THEN
      REVOKE EXECUTE ON FUNCTION public.complete_evaluation(uuid, jsonb) FROM service_role;
      PERFORM public._ce_ledger('grant', 'EXECUTE public.complete_evaluation(uuid,jsonb) TO service_role', 'revoked', NULL, NULL, v_acl);
    END IF;
  END IF;
END $legacy$;

-- Ownership + ACL on all new/replaced functions
DO $own$
DECLARE v_sig text;
  v_service text[] := ARRAY[
    'public.is_company_member(uuid,uuid)', 'public.has_company_role(uuid,uuid,public.app_role)',
    'public.ce_company_read(uuid)', 'public.ce_company_elevated(uuid)',
    'public.ce_purge_expired_snapshots()', 'public.reap_stale_evaluation_attempts(interval)'];
BEGIN
  FOREACH v_sig IN ARRAY v_service LOOP
    IF to_regprocedure(v_sig) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v_sig);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_sig);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_sig);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sandbox_exec') THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM sandbox_exec', v_sig);
      END IF;
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_sig);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
    END IF;
  END LOOP;
END $own$;

-- =================================================================
-- 4. Assertions
-- =================================================================
DO $assert$
DECLARE v_txt text; v_n int; v_extra text;
BEGIN
  FOREACH v_txt IN ARRAY ARRAY['company','company_membership','company_backfill_contract',
    'ce_bundle_snapshot','ce_raw_provider_output','ce_emotion_point','ce_next_step','ce_discrepancy',
    'ce_root_cause','ce_qa_case','ce_kb_publish_state','ce_training_link','migration_object_ledger'] LOOP
    IF to_regclass('public.'||v_txt) IS NULL THEN RAISE EXCEPTION 'ASSERT: table % missing', v_txt; END IF;
  END LOOP;

  FOREACH v_txt IN ARRAY ARRAY['channel_config','conversations','conversation_evaluation',
    'conversation_evaluation_attempt','evaluation_training_outbox','upstream_call_log'] LOOP
    IF NOT public._ce_exists('column','public.'||v_txt||'.company_id') THEN
      RAISE EXCEPTION 'ASSERT: %.company_id missing', v_txt; END IF;
  END LOOP;

  -- RLS enabled on all feature tables
  FOREACH v_txt IN ARRAY ARRAY['company','company_membership','company_backfill_contract',
    'ce_bundle_snapshot','ce_raw_provider_output','ce_emotion_point','ce_next_step','ce_discrepancy',
    'ce_root_cause','ce_qa_case','ce_kb_publish_state','ce_training_link','upstream_call_log'] LOOP
    IF NOT public._ce_rls('public.'||v_txt) THEN
      RAISE EXCEPTION 'ASSERT: RLS not enabled on %', v_txt; END IF;
  END LOOP;

  -- raw_provider_output is admin-only
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                  AND tablename='ce_raw_provider_output' AND policyname='rpo_sel'
                  AND qual LIKE '%admin%' AND qual NOT LIKE '%supervisor%' AND qual NOT LIKE '%qa%') THEN
    RAISE EXCEPTION 'ASSERT: rpo_sel not admin-only';
  END IF;

  -- Pre-existing functions survived
  FOREACH v_txt IN ARRAY ARRAY['initiate_evaluation','complete_evaluation','fail_evaluation',
    'ce_is_flag_enabled','verified_human_response','has_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND p.proname=v_txt) THEN
      RAISE EXCEPTION 'ASSERT: pre-existing function % destroyed', v_txt; END IF;
  END LOOP;

  -- Backfill contract
  IF NOT EXISTS (SELECT 1 FROM public.company_backfill_contract WHERE id=1 AND state='awaiting_owner_mapping') THEN
    RAISE EXCEPTION 'ASSERT: backfill contract missing'; END IF;

  -- Ledger populated
  SELECT count(*) INTO v_n FROM public.migration_object_ledger
   WHERE migration_id='20260728093000_ce_task1' AND disposition='created';
  IF v_n < 40 THEN RAISE EXCEPTION 'ASSERT: ledger under-populated (% created)', v_n; END IF;

  -- Conversation trigger fires on INSERT and UPDATE
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  WHERE t.tgname='trg_conversations_company' AND NOT t.tgisinternal
                    AND c.relname='conversations'
                    AND t.tgtype::int & 2 > 0  -- BEFORE
                    AND t.tgtype::int & 4 > 0  -- INSERT
                    AND t.tgtype::int & 16 > 0 -- UPDATE
                ) THEN
    RAISE EXCEPTION 'ASSERT: conversation trigger not configured for INSERT+UPDATE';
  END IF;

  -- ce_bundle_snapshot.canonical_input column exists (for true replay)
  IF NOT public._ce_exists('column','public.ce_bundle_snapshot.canonical_input') THEN
    RAISE EXCEPTION 'ASSERT: ce_bundle_snapshot.canonical_input missing'; END IF;
  IF NOT public._ce_exists('column','public.ce_bundle_snapshot.grounding_evidence') THEN
    RAISE EXCEPTION 'ASSERT: ce_bundle_snapshot.grounding_evidence missing'; END IF;

  RAISE NOTICE 'CE Task 1 assertions complete (% created objects)', v_n;
END $assert$;

COMMIT;
