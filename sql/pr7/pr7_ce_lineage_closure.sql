-- PR7 Workflow 1 / Task 1.3 — CE canonical lineage closure
-- SOURCE-ONLY. No production apply without explicit authorization.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.pr7_ce_canonical_company(p_conversation_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_conv_company uuid;
  v_channel_company uuid;
  v_company uuid;
BEGIN
  SELECT c.company_id, ch.company_id
    INTO v_conv_company, v_channel_company
  FROM public.conversations c
  LEFT JOIN public.channel_config ch ON ch.id = c.channel_config_id
  WHERE c.id = p_conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CE_LINEAGE_CONVERSATION_NOT_FOUND'
      USING ERRCODE='foreign_key_violation';
  END IF;

  IF v_conv_company IS NOT NULL
     AND v_channel_company IS NOT NULL
     AND v_conv_company <> v_channel_company THEN
    RAISE EXCEPTION 'CE_LINEAGE_TENANT_IDENTITY_CONFLICT'
      USING ERRCODE='check_violation';
  END IF;

  v_company := COALESCE(v_conv_company, v_channel_company);
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'CE_LINEAGE_TENANT_UNRESOLVED'
      USING ERRCODE='check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.company c
    WHERE c.id=v_company AND c.is_active=true
  ) THEN
    RAISE EXCEPTION 'CE_LINEAGE_COMPANY_INACTIVE'
      USING ERRCODE='check_violation';
  END IF;

  RETURN v_company;
END;
$function$;

CREATE OR REPLACE FUNCTION public.pr7_ce_guard_evaluation_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_company uuid;
  v_attempt record;
BEGIN
  v_company := public.pr7_ce_canonical_company(NEW.conversation_id);
  IF NEW.company_id IS NULL OR NEW.company_id <> v_company THEN
    RAISE EXCEPTION 'CE_LINEAGE_EVALUATION_COMPANY_MISMATCH'
      USING ERRCODE='check_violation';
  END IF;

  SELECT id,conversation_id,company_id,bundle_hash,evaluation_contract_version
    INTO v_attempt
  FROM public.conversation_evaluation_attempt
  WHERE id=NEW.attempt_id;

  IF v_attempt IS NULL
     OR v_attempt.conversation_id <> NEW.conversation_id
     OR v_attempt.company_id IS NULL
     OR v_attempt.company_id <> v_company
     OR v_attempt.bundle_hash IS DISTINCT FROM NEW.bundle_hash
     OR v_attempt.evaluation_contract_version IS DISTINCT FROM NEW.evaluation_contract_version THEN
    RAISE EXCEPTION 'CE_LINEAGE_ATTEMPT_EVALUATION_MISMATCH'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.pr7_ce_guard_snapshot_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_company uuid;
  v_attempt record;
BEGIN
  v_company := public.pr7_ce_canonical_company(NEW.conversation_id);
  SELECT id,conversation_id,company_id,bundle_hash,evaluation_contract_version
    INTO v_attempt
  FROM public.conversation_evaluation_attempt
  WHERE id=NEW.attempt_id;

  IF NEW.company_id IS NULL
     OR NEW.company_id <> v_company
     OR v_attempt IS NULL
     OR v_attempt.conversation_id <> NEW.conversation_id
     OR v_attempt.company_id IS NULL
     OR v_attempt.company_id <> v_company
     OR v_attempt.bundle_hash IS DISTINCT FROM NEW.bundle_hash
     OR v_attempt.evaluation_contract_version IS DISTINCT FROM NEW.evaluation_contract_version THEN
    RAISE EXCEPTION 'CE_LINEAGE_SNAPSHOT_MISMATCH'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.pr7_ce_guard_outbox_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_eval record;
  v_company uuid;
BEGIN
  SELECT id,conversation_id,company_id,evaluation_contract_version,source_deployment
    INTO v_eval
  FROM public.conversation_evaluation
  WHERE id=NEW.evaluation_id;

  IF v_eval IS NULL THEN
    RAISE EXCEPTION 'CE_LINEAGE_OUTBOX_EVALUATION_NOT_FOUND'
      USING ERRCODE='foreign_key_violation';
  END IF;

  v_company := public.pr7_ce_canonical_company(v_eval.conversation_id);
  IF NEW.company_id IS NULL
     OR NEW.company_id <> v_company
     OR v_eval.company_id IS NULL
     OR v_eval.company_id <> v_company
     OR NEW.evaluation_contract_version IS DISTINCT FROM v_eval.evaluation_contract_version
     OR NEW.source_deployment IS DISTINCT FROM v_eval.source_deployment THEN
    RAISE EXCEPTION 'CE_LINEAGE_OUTBOX_MISMATCH'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_pr7_ce_evaluation_lineage
  ON public.conversation_evaluation;
CREATE TRIGGER trg_pr7_ce_evaluation_lineage
BEFORE INSERT OR UPDATE ON public.conversation_evaluation
FOR EACH ROW EXECUTE FUNCTION public.pr7_ce_guard_evaluation_lineage();

DROP TRIGGER IF EXISTS trg_pr7_ce_snapshot_lineage
  ON public.ce_bundle_snapshot;
CREATE TRIGGER trg_pr7_ce_snapshot_lineage
BEFORE INSERT OR UPDATE ON public.ce_bundle_snapshot
FOR EACH ROW EXECUTE FUNCTION public.pr7_ce_guard_snapshot_lineage();

DROP TRIGGER IF EXISTS trg_pr7_ce_outbox_lineage
  ON public.evaluation_training_outbox;
CREATE TRIGGER trg_pr7_ce_outbox_lineage
BEFORE INSERT OR UPDATE ON public.evaluation_training_outbox
FOR EACH ROW EXECUTE FUNCTION public.pr7_ce_guard_outbox_lineage();

ALTER FUNCTION public.pr7_ce_canonical_company(uuid) OWNER TO postgres;
ALTER FUNCTION public.pr7_ce_guard_evaluation_lineage() OWNER TO postgres;
ALTER FUNCTION public.pr7_ce_guard_snapshot_lineage() OWNER TO postgres;
ALTER FUNCTION public.pr7_ce_guard_outbox_lineage() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.pr7_ce_canonical_company(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pr7_ce_guard_evaluation_lineage() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pr7_ce_guard_snapshot_lineage() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.pr7_ce_guard_outbox_lineage() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pr7_ce_canonical_company(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pr7_ce_guard_evaluation_lineage() TO service_role;
GRANT EXECUTE ON FUNCTION public.pr7_ce_guard_snapshot_lineage() TO service_role;
GRANT EXECUTE ON FUNCTION public.pr7_ce_guard_outbox_lineage() TO service_role;

DO $assert$
BEGIN
  IF to_regprocedure('public.pr7_ce_canonical_company(uuid)') IS NULL
     OR to_regprocedure('public.pr7_ce_guard_evaluation_lineage()') IS NULL
     OR to_regprocedure('public.pr7_ce_guard_snapshot_lineage()') IS NULL
     OR to_regprocedure('public.pr7_ce_guard_outbox_lineage()') IS NULL THEN
    RAISE EXCEPTION 'ASSERT: CE lineage functions missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.conversation_evaluation'::regclass
      AND tgname='trg_pr7_ce_evaluation_lineage' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.ce_bundle_snapshot'::regclass
      AND tgname='trg_pr7_ce_snapshot_lineage' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.evaluation_training_outbox'::regclass
      AND tgname='trg_pr7_ce_outbox_lineage' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'ASSERT: CE lineage triggers missing';
  END IF;
END
$assert$;

COMMIT;
