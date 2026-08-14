-- PR7 Workflow 3 / Task 3.3 rollback
BEGIN;
DROP TRIGGER IF EXISTS trg_pr7_feedback_tenant_lineage ON public.feedback_request;
DROP TRIGGER IF EXISTS trg_pr7_conversation_tenant_lineage ON public.conversations;
DROP FUNCTION IF EXISTS public.pr7_guard_feedback_tenant_lineage();
DROP FUNCTION IF EXISTS public.pr7_guard_conversation_tenant_lineage();
COMMIT;
