-- PROPOSAL ONLY. Outside S01/S02/S03; NOT approved for production execution.
-- Requires separate scoped authorization plus real multi-session race validation.
BEGIN;
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.agent_send_reply_tx(uuid,uuid,text,text)'::regprocedure)) <> '2491450055223f90ff932b0faf64c560' THEN RAISE EXCEPTION 'Four-argument baseline drift'; END IF;
 IF has_function_privilege('anon','public.agent_send_reply_tx(uuid,uuid,text,text)','EXECUTE') OR has_function_privilege('authenticated','public.agent_send_reply_tx(uuid,uuid,text,text)','EXECUTE') OR NOT has_function_privilege('service_role','public.agent_send_reply_tx(uuid,uuid,text,text)','EXECUTE') THEN RAISE EXCEPTION 'Four-argument ACL drift'; END IF;
 IF to_regprocedure('public.agent_send_reply_tx(uuid,uuid,text,text,uuid)') IS NOT NULL OR to_regclass('public.c3_agent_reply_request') IS NOT NULL THEN RAISE EXCEPTION 'Proposed objects already exist; compare instead of replacing'; END IF;
END $guard$;
CREATE TABLE public.c3_agent_reply_request (
 company_id uuid NOT NULL REFERENCES public.company(id),
 client_request_id uuid NOT NULL,
 conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL REFERENCES public.agent_profile(id),
 payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
 message_id uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,client_request_id)
);
ALTER TABLE public.c3_agent_reply_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.c3_agent_reply_request FROM PUBLIC,anon,authenticated,service_role;
-- Only SECURITY DEFINER RPC owner accesses receipts. No direct service DML grant.
CREATE FUNCTION public.agent_send_reply_tx(p_conversation_id uuid,p_agent_id uuid,p_content text,p_agent_name text,p_client_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $function$
DECLARE
 c public.conversations%rowtype; a public.agent_profile%rowtype;
 receipt public.c3_agent_reply_request%rowtype;
 company uuid; v_content text := btrim(coalesce(p_content,'')); digest text; message uuid;
BEGIN
 IF p_client_request_id IS NULL THEN RETURN jsonb_build_object('result','invalid_request_id'); END IF;
 IF v_content='' OR v_content='__THINKING__' OR length(v_content)>4000 THEN RETURN jsonb_build_object('result','invalid_content'); END IF;
 SELECT company_id INTO company FROM public.conversations WHERE id=p_conversation_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
 IF company IS NULL THEN RETURN jsonb_build_object('result','tenant_unresolved'); END IF;
 -- One request lock first, then ticket lock. Retries on different tickets share
 -- the same tenant/request lock; different tenants have independent identity.
 PERFORM pg_advisory_xact_lock(hashtextextended(company::text||':'||p_client_request_id::text,0));
 SELECT * INTO c FROM public.conversations WHERE id=p_conversation_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
 IF c.company_id IS DISTINCT FROM company THEN RETURN jsonb_build_object('result','tenant_unresolved'); END IF;
 SELECT * INTO a FROM public.agent_profile WHERE id=p_agent_id FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('result','agent_not_found'); END IF;
 IF a.status IS DISTINCT FROM 'active' THEN RETURN jsonb_build_object('result','agent_inactive'); END IF;
 PERFORM 1 FROM public.company_membership cm JOIN public.company co ON co.id=cm.company_id
 WHERE cm.company_id=company AND cm.user_id=a.user_id AND cm.is_active AND co.is_active
 AND cm.role IN ('admin','supervisor','agent') FOR SHARE OF cm,co;
 IF NOT FOUND THEN RETURN jsonb_build_object('result','membership_required'); END IF;
 digest := encode(sha256(convert_to(jsonb_build_array(company,p_conversation_id,p_agent_id,v_content,coalesce(p_agent_name,''))::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM public.c3_agent_reply_request WHERE company_id=company AND client_request_id=p_client_request_id;
 IF FOUND THEN
  IF receipt.conversation_id IS DISTINCT FROM p_conversation_id OR receipt.agent_id IS DISTINCT FROM p_agent_id OR receipt.payload_sha256 IS DISTINCT FROM digest THEN RETURN jsonb_build_object('result','request_id_conflict'); END IF;
  -- Already committed receipt may be acknowledged after transfer/resolution.
  -- This path writes nothing; active trusted membership is still required.
  RETURN jsonb_build_object('result','success','message_id',receipt.message_id,'replayed',true);
 END IF;
 IF c.status IN ('resolved','closed') THEN RETURN jsonb_build_object('result','resolved'); END IF;
 IF c.assigned_agent_id IS NULL THEN RETURN jsonb_build_object('result','takeover_required'); END IF;
 IF c.assigned_agent_id IS DISTINCT FROM p_agent_id THEN RETURN jsonb_build_object('result','owned_by_another_agent'); END IF;
 IF c.status IS DISTINCT FROM 'pending' THEN RETURN jsonb_build_object('result','human_control_required'); END IF;
 DELETE FROM public.messages WHERE conversation_id=p_conversation_id AND content='__THINKING__';
 INSERT INTO public.messages(conversation_id,role,content,content_type,status,sender_id,is_recalled,metadata)
 VALUES(p_conversation_id,'agent',v_content,'text','delivered',p_agent_id,false,jsonb_build_object('agent_id',p_agent_id,'agent_name',coalesce(p_agent_name,''),'control_commit','human','client_request_id',p_client_request_id)) RETURNING id INTO message;
 UPDATE public.conversations SET updated_at=now() WHERE id=p_conversation_id;
 INSERT INTO public.audit_log(actor_id,actor_type,action,resource_type,resource_id,diff)
 VALUES(p_agent_id,'agent','agent_send_reply','messages',message,jsonb_build_object('conversation_id',p_conversation_id,'control_state','pending','owner_agent_id',p_agent_id,'client_request_id',p_client_request_id));
 INSERT INTO public.c3_agent_reply_request(company_id,client_request_id,conversation_id,agent_id,payload_sha256,message_id)
 VALUES(company,p_client_request_id,p_conversation_id,p_agent_id,digest,message);
 RETURN jsonb_build_object('result','success','message_id',message,'replayed',false);
END $function$;
REVOKE ALL ON FUNCTION public.agent_send_reply_tx(uuid,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.agent_send_reply_tx(uuid,uuid,text,text,uuid) TO service_role;
COMMIT;
