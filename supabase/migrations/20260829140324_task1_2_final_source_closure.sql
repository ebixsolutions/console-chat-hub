-- Task 1.2 final consolidated source closure.
-- Idempotently backfill deterministic tenant lineage, then enforce the final
-- authenticated/service-role RPC contracts for channel, widget and agent updates.
UPDATE public.ce_evaluation_state s
SET company_id=c.company_id, updated_at=now()
FROM public.conversations c
WHERE c.id=s.conversation_id AND s.company_id IS NULL AND c.company_id IS NOT NULL;
UPDATE public.ce_evaluation_job j
SET company_id=c.company_id, updated_at=now()
FROM public.conversations c
WHERE c.id=j.conversation_id AND j.company_id IS NULL AND c.company_id IS NOT NULL;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.ce_evaluation_state s JOIN public.conversations c ON c.id=s.conversation_id WHERE s.company_id IS DISTINCT FROM c.company_id) THEN RAISE EXCEPTION 'ce_evaluation_state tenant mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM public.ce_evaluation_job j JOIN public.conversations c ON c.id=j.conversation_id WHERE j.company_id IS DISTINCT FROM c.company_id) THEN RAISE EXCEPTION 'ce_evaluation_job tenant mismatch'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_update_channel_config(p_channel_id uuid, p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_uid uuid:=auth.uid(); v_role text:=coalesce(auth.role(),''); v_channel_type text; v_company_id uuid; v_origin text; v_norm text; v_normalized text[]:=ARRAY[]::text[]; v_target_widget uuid; v_row public.channel_config%ROWTYPE;
BEGIN
 IF v_role<>'service_role' AND v_uid IS NULL THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','UNAUTHENTICATED','message','Authentication required')); END IF;
 SELECT channel_type,company_id INTO v_channel_type,v_company_id FROM public.channel_config WHERE id=p_channel_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','Channel config not found')); END IF;
 IF v_role<>'service_role' AND NOT public.has_company_role(v_company_id,v_uid,'admin'::public.app_role) THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Company admin role required')); END IF;
 IF v_channel_type<>'web_widget' THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_SUPPORTED','message','Only web_widget channel configs are editable here')); END IF;
 IF NOT (p_changes ?| ARRAY['name','allowed_origins','is_active','widget_config_id']) THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','NO_CHANGES','message','No supported changes supplied')); END IF;
 IF p_changes?'allowed_origins' THEN
   IF jsonb_typeof(p_changes->'allowed_origins')<>'array' THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','allowed_origins must be an array')); END IF;
   FOR v_origin IN SELECT jsonb_array_elements_text(p_changes->'allowed_origins') LOOP
     IF v_origin IS NULL OR position(' ' in v_origin)>0 THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid origin format')); END IF;
     v_norm:=lower(v_origin); IF right(v_norm,1)='/' THEN v_norm:=left(v_norm,char_length(v_norm)-1); END IF;
     IF v_norm~'^(javascript|data):' OR position('*' in v_norm)>0 THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid origin')); END IF;
     IF v_norm~'^https://[a-z0-9.-]+(:[0-9]+)?$' THEN NULL;
     ELSIF v_norm~'^http://localhost(:[0-9]+)?$' THEN
       IF NOT EXISTS(SELECT 1 FROM public.channel_config WHERE id=p_channel_id AND allowed_origins IS NOT NULL AND v_norm=ANY(allowed_origins)) THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid origin')); END IF;
     ELSE RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid origin')); END IF;
     v_normalized:=v_normalized||v_norm;
   END LOOP;
 END IF;
 IF p_changes?'widget_config_id' THEN
   BEGIN v_target_widget:=nullif(p_changes->>'widget_config_id','')::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid widget_config_id')); END;
   IF v_target_widget IS NULL OR NOT EXISTS(SELECT 1 FROM public.widget_config WHERE id=v_target_widget) THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Widget config not found')); END IF;
   IF EXISTS(SELECT 1 FROM public.channel_config cc WHERE cc.widget_config_id=v_target_widget AND cc.company_id IS DISTINCT FROM v_company_id) THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','TENANT_SCOPE_VIOLATION','message','Widget config belongs to another company')); END IF;
 END IF;
 UPDATE public.channel_config SET name=CASE WHEN p_changes?'name' THEN left(btrim(p_changes->>'name'),100) ELSE name END, allowed_origins=CASE WHEN p_changes?'allowed_origins' THEN v_normalized ELSE allowed_origins END, is_active=CASE WHEN p_changes?'is_active' THEN (p_changes->>'is_active')::boolean ELSE is_active END, widget_config_id=CASE WHEN p_changes?'widget_config_id' THEN v_target_widget ELSE widget_config_id END, updated_at=now() WHERE id=p_channel_id RETURNING * INTO v_row;
 RETURN jsonb_build_object('ok',true,'data',to_jsonb(v_row));
EXCEPTION WHEN invalid_text_representation OR datatype_mismatch THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid field value'));
END $function$;

CREATE OR REPLACE FUNCTION public.rpc_update_widget_config(p_widget_id uuid,p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_uid uuid:=auth.uid(); v_role text:=coalesce(auth.role(),''); v_name text; v_header text; v_welcome text; v_placeholder text; v_logo text; v_color text; v_row public.widget_config%ROWTYPE;
BEGIN
 IF v_role<>'service_role' AND v_uid IS NULL THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','UNAUTHENTICATED','message','Authentication required')); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.widget_config WHERE id=p_widget_id) THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','Widget config not found')); END IF;
 IF v_role<>'service_role' AND (NOT EXISTS(SELECT 1 FROM public.channel_config cc WHERE cc.widget_config_id=p_widget_id) OR EXISTS(SELECT 1 FROM public.channel_config cc WHERE cc.widget_config_id=p_widget_id AND NOT public.has_company_role(cc.company_id,v_uid,'admin'::public.app_role))) THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Company admin role required for every linked channel')); END IF;
 IF NOT (p_changes ?| ARRAY['name','header_title','welcome_message','placeholder_text','primary_color','logo_url','is_active']) THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','NO_CHANGES','message','No supported changes supplied')); END IF;
 IF p_changes?'name' THEN v_name:=btrim(p_changes->>'name'); IF char_length(v_name)>100 THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid name')); END IF; END IF;
 IF p_changes?'header_title' THEN v_header:=btrim(p_changes->>'header_title'); IF char_length(v_header)>100 THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid header title')); END IF; END IF;
 IF p_changes?'welcome_message' THEN v_welcome:=btrim(p_changes->>'welcome_message'); IF char_length(v_welcome)>500 THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid welcome message')); END IF; END IF;
 IF p_changes?'placeholder_text' THEN v_placeholder:=btrim(p_changes->>'placeholder_text'); IF char_length(v_placeholder)>200 THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid placeholder text')); END IF; END IF;
 IF p_changes?'primary_color' THEN v_color:=p_changes->>'primary_color'; IF v_color!~'^#[0-9A-Fa-f]{6}$' THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid color value')); END IF; END IF;
 IF p_changes?'logo_url' THEN v_logo:=p_changes->>'logo_url'; IF v_logo IS NOT NULL AND v_logo<>'' AND v_logo!~'^https://' THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid logo URL')); END IF; END IF;
 UPDATE public.widget_config SET name=CASE WHEN p_changes?'name' THEN v_name ELSE name END, header_title=CASE WHEN p_changes?'header_title' THEN v_header ELSE header_title END, welcome_message=CASE WHEN p_changes?'welcome_message' THEN v_welcome ELSE welcome_message END, placeholder_text=CASE WHEN p_changes?'placeholder_text' THEN v_placeholder ELSE placeholder_text END, primary_color=CASE WHEN p_changes?'primary_color' THEN v_color ELSE primary_color END, logo_url=CASE WHEN p_changes?'logo_url' THEN nullif(v_logo,'') ELSE logo_url END, is_active=CASE WHEN p_changes?'is_active' THEN (p_changes->>'is_active')::boolean ELSE is_active END, updated_at=now() WHERE id=p_widget_id RETURNING * INTO v_row;
 RETURN jsonb_build_object('ok',true,'data',to_jsonb(v_row));
EXCEPTION WHEN invalid_text_representation OR datatype_mismatch THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid field value'));
END $function$;

CREATE OR REPLACE FUNCTION public.rpc_update_agent_profile(p_agent_id uuid,p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_uid uuid:=auth.uid(); v_role text:=coalesce(auth.role(),''); v_target_user_id uuid; v_is_self boolean:=false; v_scoped_elevated boolean:=false; v_display text; v_avatar text; v_status text; v_row public.agent_profile%ROWTYPE;
BEGIN
 IF v_role<>'service_role' AND v_uid IS NULL THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','UNAUTHENTICATED','message','Authentication required')); END IF;
 SELECT user_id INTO v_target_user_id FROM public.agent_profile WHERE id=p_agent_id; IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','Agent profile not found')); END IF;
 IF v_role<>'service_role' THEN
   v_is_self:=v_target_user_id=v_uid;
   IF NOT v_is_self AND (public.has_role(v_uid,'admin'::public.app_role) OR public.has_role(v_uid,'supervisor'::public.app_role)) THEN SELECT EXISTS(SELECT 1 FROM public.company_membership a JOIN public.company_membership t ON t.company_id=a.company_id AND t.user_id=v_target_user_id AND t.is_active WHERE a.user_id=v_uid AND a.is_active AND a.role IN ('admin'::public.app_role,'supervisor'::public.app_role)) INTO v_scoped_elevated; END IF;
   IF NOT v_is_self AND NOT v_scoped_elevated THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Self or same-company elevated role required')); END IF;
 END IF;
 IF NOT (p_changes ?| ARRAY['display_name','avatar_url','status']) THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','NO_CHANGES','message','No supported changes supplied')); END IF;
 IF p_changes?'display_name' THEN v_display:=btrim(regexp_replace(p_changes->>'display_name','[[:cntrl:]]','','g')); IF char_length(v_display)=0 OR char_length(v_display)>100 THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid display name')); END IF; END IF;
 IF p_changes?'avatar_url' THEN v_avatar:=p_changes->>'avatar_url'; IF v_avatar IS NOT NULL AND v_avatar<>'' AND v_avatar!~'^https://' THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid avatar URL')); END IF; END IF;
 IF p_changes?'status' THEN v_status:=p_changes->>'status'; IF v_status NOT IN ('active','inactive','suspended') THEN RETURN jsonb_build_object('ok',false,'error',jsonb_build_object('code','VALIDATION_ERROR','message','Invalid status')); END IF; END IF;
 UPDATE public.agent_profile SET display_name=CASE WHEN p_changes?'display_name' THEN v_display ELSE display_name END, avatar_url=CASE WHEN p_changes?'avatar_url' THEN nullif(v_avatar,'') ELSE avatar_url END, status=CASE WHEN p_changes?'status' THEN v_status ELSE status END, updated_at=now() WHERE id=p_agent_id RETURNING * INTO v_row;
 RETURN jsonb_build_object('ok',true,'data',to_jsonb(v_row));
END $function$;

CREATE OR REPLACE FUNCTION public.rpc_update_channel_config(p_channel_config_id uuid,p_is_active boolean DEFAULT NULL::boolean,p_allowed_origins text[] DEFAULT NULL::text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$ DECLARE v_request_id text:=md5(clock_timestamp()::text||random()::text); v_result jsonb; v_changes jsonb:='{}'::jsonb; BEGIN IF p_is_active IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('is_active',p_is_active); END IF; IF p_allowed_origins IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('allowed_origins',to_jsonb(p_allowed_origins)); END IF; IF v_changes='{}'::jsonb THEN RETURN jsonb_build_object('ok',false,'error_code','NO_CHANGES','message_safe','No supported changes supplied.','request_id',v_request_id,'retryable',false); END IF; v_result:=public.rpc_update_channel_config(p_channel_config_id,v_changes); IF coalesce((v_result->>'ok')::boolean,false) THEN RETURN jsonb_build_object('ok',true,'request_id',v_request_id,'data',jsonb_build_object('updated_id',p_channel_config_id)); END IF; RETURN jsonb_build_object('ok',false,'error_code',coalesce(v_result#>>'{error,code}','INTERNAL'),'message_safe',coalesce(v_result#>>'{error,message}','Config update failed.'),'request_id',v_request_id,'retryable',false); END $function$;
CREATE OR REPLACE FUNCTION public.rpc_update_widget_config(p_widget_config_id uuid,p_name text DEFAULT NULL::text,p_header_title text DEFAULT NULL::text,p_welcome_message text DEFAULT NULL::text,p_placeholder_text text DEFAULT NULL::text,p_primary_color text DEFAULT NULL::text,p_logo_url text DEFAULT NULL::text,p_is_active boolean DEFAULT NULL::boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$ DECLARE v_request_id text:=md5(clock_timestamp()::text||random()::text); v_result jsonb; v_changes jsonb:='{}'::jsonb; BEGIN IF p_name IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('name',p_name); END IF; IF p_header_title IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('header_title',p_header_title); END IF; IF p_welcome_message IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('welcome_message',p_welcome_message); END IF; IF p_placeholder_text IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('placeholder_text',p_placeholder_text); END IF; IF p_primary_color IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('primary_color',p_primary_color); END IF; IF p_logo_url IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('logo_url',p_logo_url); END IF; IF p_is_active IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('is_active',p_is_active); END IF; IF v_changes='{}'::jsonb THEN RETURN jsonb_build_object('ok',false,'error_code','NO_CHANGES','message_safe','No supported changes supplied.','request_id',v_request_id,'retryable',false); END IF; v_result:=public.rpc_update_widget_config(p_widget_config_id,v_changes); IF coalesce((v_result->>'ok')::boolean,false) THEN RETURN jsonb_build_object('ok',true,'request_id',v_request_id,'data',jsonb_build_object('updated_id',p_widget_config_id)); END IF; RETURN jsonb_build_object('ok',false,'error_code',coalesce(v_result#>>'{error,code}','INTERNAL'),'message_safe',coalesce(v_result#>>'{error,message}','Config update failed.'),'request_id',v_request_id,'retryable',false); END $function$;
CREATE OR REPLACE FUNCTION public.rpc_update_agent_profile(p_agent_id uuid,p_display_name text DEFAULT NULL::text,p_avatar_url text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$ DECLARE v_request_id text:=md5(clock_timestamp()::text||random()::text); v_result jsonb; v_changes jsonb:='{}'::jsonb; BEGIN IF p_display_name IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('display_name',p_display_name); END IF; IF p_avatar_url IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('avatar_url',p_avatar_url); END IF; IF v_changes='{}'::jsonb THEN RETURN jsonb_build_object('ok',false,'error_code','NO_CHANGES','message_safe','No supported changes supplied.','request_id',v_request_id,'retryable',false); END IF; v_result:=public.rpc_update_agent_profile(p_agent_id,v_changes); IF coalesce((v_result->>'ok')::boolean,false) THEN RETURN jsonb_build_object('ok',true,'request_id',v_request_id,'data',jsonb_build_object('updated_id',p_agent_id)); END IF; RETURN jsonb_build_object('ok',false,'error_code',coalesce(v_result#>>'{error,code}','INTERNAL'),'message_safe',coalesce(v_result#>>'{error,message}','Profile update failed.'),'request_id',v_request_id,'retryable',false); END $function$;

REVOKE ALL ON FUNCTION public.rpc_update_channel_config(uuid,jsonb) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.rpc_update_channel_config(uuid,boolean,text[]) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.rpc_update_widget_config(uuid,jsonb) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.rpc_update_widget_config(uuid,text,text,text,text,text,text,boolean) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.rpc_update_agent_profile(uuid,jsonb) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.rpc_update_agent_profile(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_channel_config(uuid,jsonb) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.rpc_update_channel_config(uuid,boolean,text[]) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.rpc_update_widget_config(uuid,jsonb) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.rpc_update_widget_config(uuid,text,text,text,text,text,text,boolean) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.rpc_update_agent_profile(uuid,jsonb) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.rpc_update_agent_profile(uuid,text,text) TO authenticated,service_role;
