ALTER VIEW public.ce_conversation_status_v SET (security_invoker = true);
REVOKE ALL ON public.ce_conversation_status_v FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.ce_conversation_status_v FROM authenticated;
GRANT SELECT ON public.ce_conversation_status_v TO authenticated;
GRANT ALL ON public.ce_conversation_status_v TO service_role;