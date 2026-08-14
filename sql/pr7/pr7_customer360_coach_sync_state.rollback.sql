-- Workflow 5 / Task 5.3 rollback
BEGIN;
DROP TABLE IF EXISTS public.customer360_coach_sync_state;
COMMIT;
