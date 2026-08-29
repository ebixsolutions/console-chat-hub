-- Task 1: Security Definer View + View/RLS closure
-- Production target: nrfxhqabwblzxoushgnm
-- Preserve view definition, owner, grants, and dependencies; only change execution semantics.

alter view public.ce_conversation_status_v
set (security_invoker = true);

-- Rollback:
-- alter view public.ce_conversation_status_v
-- reset (security_invoker);
