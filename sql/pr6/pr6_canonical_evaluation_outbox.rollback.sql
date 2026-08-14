-- PR-6 canonical evaluation transactional outbox rollback
-- Does not delete already-created outbox rows.
BEGIN;
DROP TRIGGER IF EXISTS trg_pr6_enqueue_canonical_evaluation
  ON public.conversation_evaluation;
DROP FUNCTION IF EXISTS public.pr6_enqueue_canonical_evaluation();
COMMIT;
