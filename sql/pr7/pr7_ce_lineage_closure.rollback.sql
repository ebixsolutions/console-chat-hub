-- PR7 CE canonical lineage closure rollback
BEGIN;
DROP TRIGGER IF EXISTS trg_pr7_ce_outbox_lineage ON public.evaluation_training_outbox;
DROP TRIGGER IF EXISTS trg_pr7_ce_snapshot_lineage ON public.ce_bundle_snapshot;
DROP TRIGGER IF EXISTS trg_pr7_ce_evaluation_lineage ON public.conversation_evaluation;
DROP FUNCTION IF EXISTS public.pr7_ce_guard_outbox_lineage();
DROP FUNCTION IF EXISTS public.pr7_ce_guard_snapshot_lineage();
DROP FUNCTION IF EXISTS public.pr7_ce_guard_evaluation_lineage();
DROP FUNCTION IF EXISTS public.pr7_ce_canonical_company(uuid);
COMMIT;
