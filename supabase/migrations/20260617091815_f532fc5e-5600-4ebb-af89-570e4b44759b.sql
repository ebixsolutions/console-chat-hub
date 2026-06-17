DROP POLICY IF EXISTS feedback_request_read ON public.feedback_request;
CREATE POLICY feedback_request_read_admin ON public.feedback_request FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS auth_read_rag_trace ON public.rag_trace;
CREATE POLICY rag_trace_read_admin ON public.rag_trace FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));