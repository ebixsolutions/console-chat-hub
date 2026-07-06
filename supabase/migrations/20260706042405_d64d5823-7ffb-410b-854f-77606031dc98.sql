-- P3-FB: Add scheduling columns to feedback_request (existing-row-safe)
ALTER TABLE public.feedback_request
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS rating_type text NOT NULL DEFAULT 'stars_1_5',
  ADD COLUMN IF NOT EXISTS config_version_id uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- P3-FB: Extend RLS. Existing admin policies (feedback_request_read_admin SELECT,
-- feedback_request_write_admin ALL) are PRESERVED. Add supervisor + agent scoping
-- as additional permissive policies (OR semantics).

-- SELECT: supervisor broad (KL-P3FB-4)
CREATE POLICY "feedback_request_read_supervisor"
  ON public.feedback_request
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'supervisor'::public.app_role));

-- SELECT: agent scoped to assigned conversations
CREATE POLICY "feedback_request_read_agent_scoped"
  ON public.feedback_request
  FOR SELECT TO authenticated
  USING (
    conversation_id IN (
      SELECT c.id
      FROM public.conversations c
      JOIN public.agent_profile ap ON c.assigned_agent_id = ap.id
      WHERE ap.user_id = auth.uid()
    )
  );

-- INSERT: supervisor broad
CREATE POLICY "feedback_request_insert_supervisor"
  ON public.feedback_request
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'supervisor'::public.app_role));

-- INSERT: agent scoped to assigned conversations
CREATE POLICY "feedback_request_insert_agent_scoped"
  ON public.feedback_request
  FOR INSERT TO authenticated
  WITH CHECK (
    conversation_id IN (
      SELECT c.id
      FROM public.conversations c
      JOIN public.agent_profile ap ON c.assigned_agent_id = ap.id
      WHERE ap.user_id = auth.uid()
    )
  );

-- Admin INSERT/UPDATE/DELETE remain covered by existing feedback_request_write_admin (ALL).