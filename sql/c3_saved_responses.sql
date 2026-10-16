-- Candidate only. New Production object requires its own exact-byte authorization.
BEGIN;
CREATE TABLE public.saved_response (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.company(id),
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 100),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 4000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_response_owner_idx ON public.saved_response(company_id,owner_id,title,id);
ALTER TABLE public.saved_response ENABLE ROW LEVEL SECURITY;
CREATE POLICY saved_response_owner_scope ON public.saved_response TO authenticated
USING (owner_id=auth.uid() AND EXISTS (
  SELECT 1 FROM public.company_membership m JOIN public.company c ON c.id=m.company_id
  WHERE m.user_id=auth.uid() AND m.company_id=saved_response.company_id
    AND m.is_active AND c.is_active AND m.role IN ('admin','supervisor','agent')
) AND (SELECT count(DISTINCT company_id) FROM public.company_membership WHERE user_id=auth.uid() AND is_active)=1)
WITH CHECK (owner_id=auth.uid() AND EXISTS (
  SELECT 1 FROM public.company_membership m JOIN public.company c ON c.id=m.company_id
  WHERE m.user_id=auth.uid() AND m.company_id=saved_response.company_id
    AND m.is_active AND c.is_active AND m.role IN ('admin','supervisor','agent')
) AND (SELECT count(DISTINCT company_id) FROM public.company_membership WHERE user_id=auth.uid() AND is_active)=1);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.saved_response TO authenticated;
REVOKE ALL ON public.saved_response FROM anon;
CREATE FUNCTION public.c3_saved_response_revision() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.owner_id<>OLD.owner_id OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'saved_response_revision_conflict';
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.c3_saved_response_revision() FROM PUBLIC;
CREATE TRIGGER saved_response_revision BEFORE UPDATE ON public.saved_response FOR EACH ROW EXECUTE FUNCTION public.c3_saved_response_revision();
COMMIT;
