DROP POLICY IF EXISTS conversations_update_auth ON public.conversations;
CREATE POLICY "conversations_update_staff" ON public.conversations
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid()));