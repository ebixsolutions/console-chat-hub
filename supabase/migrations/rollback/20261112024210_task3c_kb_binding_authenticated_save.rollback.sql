-- Disable only the new authenticated entry point; preserve all original data.
BEGIN;
REVOKE ALL ON FUNCTION public.kb_binding_write_self_v1(uuid,text,text,boolean,bigint,text,boolean) FROM PUBLIC,anon,authenticated;
DROP FUNCTION public.kb_binding_write_self_v1(uuid,text,text,boolean,bigint,text,boolean);
COMMIT;
