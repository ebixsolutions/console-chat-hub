-- PROPOSED ONLY: common dependency for BOTH temporary UAT SQL packages.
-- No leases, users, memberships, channels, messages or permanent accounting are created.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION public.c3_uat_lease_authority(p_company_id uuid,p_revision text,p_lease jsonb,p_conversation_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE channel uuid; actor uuid;
BEGIN
 channel:=CASE
  WHEN p_company_id='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec' AND p_revision='c3-3322877-bounded-uat-r2' THEN '0405282f-77dc-47cf-8074-99dd3dc6c393'::uuid
  WHEN p_company_id='3d6e17b5-ec79-4f75-aa7f-eaa824ff8493' AND p_revision='c3-frankie-tenant-bounded-demo-v1' THEN 'b0000000-0000-0000-0000-000000000001'::uuid END;
 actor:=(p_lease->>'actor_id')::uuid;
 IF channel IS NULL OR actor IS NULL OR p_lease->>'revision' IS DISTINCT FROM p_revision
 OR p_lease->>'channel_id' IS DISTINCT FROM channel::text
 OR coalesce(p_lease->>'source_head','') !~ '^[a-f0-9]{40}$'
 OR coalesce(p_lease->>'source_tree','') !~ '^[a-f0-9]{40}$'
 OR coalesce(p_lease->>'authorization_sha256','') !~ '^[a-f0-9]{64}$'
 OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company_id AND c.is_active)
 OR NOT EXISTS(SELECT 1 FROM public.company_membership m WHERE m.company_id=p_company_id AND m.user_id=actor AND m.is_active AND m.role IN ('admin','supervisor'))
 OR EXISTS(SELECT 1 FROM public.company_membership m WHERE m.user_id=actor AND m.is_active AND m.company_id<>p_company_id)
 OR NOT EXISTS(SELECT 1 FROM public.channel_config c WHERE c.id=channel AND c.company_id=p_company_id AND c.is_active AND c.channel_type='web_widget')
 THEN RETURN false; END IF;
 IF p_conversation_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.conversations c JOIN public.visitor_session s ON s.id=c.visitor_session_id
  WHERE c.id=p_conversation_id AND c.company_id=p_company_id AND c.channel_config_id=channel AND s.channel_config_id=channel
  AND c.metadata_source->>'source'='c3_uat_widget' AND c.metadata_source->>'synthetic'='true'
  AND c.metadata_source->>'exclude_training'='true' AND c.metadata_source->>'owner_user_id'=actor::text
  AND s.visitor_metadata->>'source'='c3_uat_widget' AND s.visitor_metadata->>'owner_user_id'=actor::text
  AND s.visitor_metadata->>'exclude_training'='true'
  AND c.created_at>=(p_lease->>'issued_at')::timestamptz
  AND p_lease->'allowed_conversations' ? c.id::text
 ) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.c3_uat_lease_authority(uuid,text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.c3_uat_lease_authority(uuid,text,jsonb,uuid) TO service_role;
COMMIT;
