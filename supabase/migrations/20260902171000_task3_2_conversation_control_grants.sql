-- Task 3.2 — authenticated console users may edit non-control presentation fields,
-- but status/ownership/tenant identity must cross the audited service-role RPC boundary.
REVOKE UPDATE ON TABLE public.conversations FROM anon;
REVOKE UPDATE ON TABLE public.conversations FROM authenticated;

GRANT UPDATE (
  priority,
  tags,
  customer_tier,
  intent,
  language,
  metadata_source,
  metadata_updated_at,
  updated_at
) ON TABLE public.conversations TO authenticated;
