-- PR-6 — canonical evaluation transactional outbox
-- SOURCE-ONLY. Do not apply to production without explicit Director authorization.
--
-- Goal:
--   Every successfully inserted canonical conversation_evaluation receives one
--   evaluation_training_outbox row in the SAME database transaction.
--
-- IMPORTANT:
--   complete_evaluation_v2 inserts conversation_evaluation before ce_bundle_snapshot.
--   Therefore this MUST be a DEFERRABLE constraint trigger. An immediate AFTER
--   INSERT trigger would reject every valid completion before its snapshot exists.

BEGIN;

CREATE OR REPLACE FUNCTION public.pr6_enqueue_canonical_evaluation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.id IS NULL
     OR NEW.company_id IS NULL
     OR NEW.conversation_id IS NULL
     OR NEW.evaluation_contract_version IS NULL
     OR NEW.source_deployment IS NULL THEN
    RAISE EXCEPTION 'PR6_OUTBOX_SCOPE_INVALID'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.conversation_evaluation_attempt a
    JOIN public.ce_bundle_snapshot s
      ON s.attempt_id = a.id
    WHERE a.id = NEW.attempt_id
      AND a.conversation_id = NEW.conversation_id
      AND a.company_id = NEW.company_id
      AND a.status IN ('running', 'complete')
      AND s.conversation_id = NEW.conversation_id
      AND s.company_id = NEW.company_id
      AND s.bundle_hash = NEW.bundle_hash
      AND s.evaluation_contract_version = NEW.evaluation_contract_version
  ) THEN
    RAISE EXCEPTION 'PR6_CANONICAL_SNAPSHOT_MISSING'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.evaluation_training_outbox (
    evaluation_id,
    status,
    delivery_idempotency_key,
    source_app,
    source_deployment,
    evaluation_contract_version,
    company_id
  )
  VALUES (
    NEW.id,
    'pending',
    NEW.id::text,
    'ai_chatbot',
    NEW.source_deployment,
    NEW.evaluation_contract_version,
    NEW.company_id
  )
  ON CONFLICT (evaluation_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.pr6_enqueue_canonical_evaluation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.pr6_enqueue_canonical_evaluation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pr6_enqueue_canonical_evaluation() FROM anon;
REVOKE ALL ON FUNCTION public.pr6_enqueue_canonical_evaluation() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.pr6_enqueue_canonical_evaluation() TO service_role;

DROP TRIGGER IF EXISTS trg_pr6_enqueue_canonical_evaluation
  ON public.conversation_evaluation;

CREATE CONSTRAINT TRIGGER trg_pr6_enqueue_canonical_evaluation
AFTER INSERT ON public.conversation_evaluation
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.pr6_enqueue_canonical_evaluation();

DO $assert$
DECLARE
  v_unique boolean;
  v_trigger boolean;
  v_deferred boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a
      ON a.attrelid = t.oid
     AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = 'public'
      AND t.relname = 'evaluation_training_outbox'
      AND i.indisunique
      AND a.attname = 'evaluation_id'
  ) INTO v_unique;
  IF NOT v_unique THEN
    RAISE EXCEPTION 'ASSERT: evaluation_training_outbox.evaluation_id must be unique';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_trigger tr
    WHERE tr.tgrelid = 'public.conversation_evaluation'::regclass
      AND tr.tgname = 'trg_pr6_enqueue_canonical_evaluation'
      AND NOT tr.tgisinternal
      AND (tr.tgtype::int & 4) > 0
      AND (tr.tgtype::int & 1) > 0
  ), COALESCE((
    SELECT tr.tgdeferrable AND tr.tginitdeferred
    FROM pg_trigger tr
    WHERE tr.tgrelid = 'public.conversation_evaluation'::regclass
      AND tr.tgname = 'trg_pr6_enqueue_canonical_evaluation'
      AND NOT tr.tgisinternal
  ), false)
  INTO v_trigger, v_deferred;

  IF NOT v_trigger THEN
    RAISE EXCEPTION 'ASSERT: PR6 canonical outbox trigger missing';
  END IF;
  IF NOT v_deferred THEN
    RAISE EXCEPTION 'ASSERT: PR6 canonical outbox trigger must be initially deferred';
  END IF;

  IF has_function_privilege('authenticated',
      'public.pr6_enqueue_canonical_evaluation()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT: authenticated must not execute PR6 trigger function directly';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.pr6_enqueue_canonical_evaluation()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSERT: service_role execute missing';
  END IF;
END
$assert$;

COMMIT;
