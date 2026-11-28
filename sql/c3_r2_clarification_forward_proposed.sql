-- SAME Task3C R2 proposed forward; no Production approval.
-- Activate with matching caller under separately approved controlled release.
-- No changes to the frozen canonical commit function, tables, or RLS.
BEGIN;
DO $guard$
BEGIN
 IF to_regprocedure('public.required_escalation_clarification_tx(uuid,uuid,text,text,text,jsonb)') IS NOT NULL
    OR md5(pg_get_functiondef('public.required_escalation_clarification_tx(uuid,uuid,text,text,text)'::regprocedure)) IS DISTINCT FROM '98b2d2e627df51228d4bcb248afe7d63'
    OR md5(pg_get_functiondef('public.commit_ai_reply_tx(uuid,uuid,text,jsonb)'::regprocedure)) IS DISTINCT FROM 'f3ba6240d2453729ce073b7e87ed665c'
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.required_escalation_clarification_tx(uuid,uuid,text,text,text)'::regprocedure
       AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND pg_get_userbyid(proowner)='postgres' AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.commit_ai_reply_tx(uuid,uuid,text,jsonb)'::regprocedure
       AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND pg_get_userbyid(proowner)='postgres' AND prosecdef)
 THEN RAISE EXCEPTION 'R2 guarded forward baseline mismatch'; END IF;
END;
$guard$;
CREATE FUNCTION public.required_escalation_clarification_tx(
 p_conversation_id uuid,p_source_message_id uuid,p_escalation_rule text,
 p_clarification_content text,p_reason_code text,p_metadata jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
 AS $r2bound$
DECLARE
 v_conv record;
 v_prior integer;
 v_existing record;
 v_action text := 'clarification';
 v_meta jsonb;
 v_result jsonb;
 v_code text;
 v_id uuid;
BEGIN
 IF p_conversation_id IS NULL OR p_source_message_id IS NULL
    OR p_clarification_content IS NULL OR btrim(p_clarification_content)='' OR
    p_clarification_content<>btrim(p_clarification_content) OR
    p_clarification_content='__THINKING__' OR char_length(p_clarification_content)>1200
    OR p_reason_code IS NULL OR p_reason_code NOT IN
       ('clarification_required_before_r2','clarification_new_intent_no_kb_match') THEN
   RETURN jsonb_build_object('result','invalid_input');
 END IF;
 IF p_escalation_rule IS DISTINCT FROM 'R2' THEN RETURN jsonb_build_object('result','invalid_rule'); END IF;
 IF jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN
   RETURN jsonb_build_object('result','invalid_b2_revision_proof');
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_metadata))<>7
    OR NOT (p_metadata ?& ARRAY['b2_gate_contract','b2_commit_source','b2_source_message_id',
       'b2_expected_company_id','b2_expected_revision','b2_response_hash','b2_idempotency_key'])
    OR jsonb_typeof(p_metadata->'b2_expected_revision') IS DISTINCT FROM 'number'
    OR COALESCE(p_metadata->>'b2_expected_revision','') !~ '^[0-9]{1,18}$'
    OR p_metadata->>'b2_source_message_id' IS DISTINCT FROM p_source_message_id::text
    OR p_metadata->>'b2_gate_contract' IS DISTINCT FROM 'executeB2PersistenceGate:allow_after_revalidation'
    OR p_metadata->>'b2_commit_source' IS DISTINCT FROM 'commit_ai_reply_tx'
    OR COALESCE(p_metadata->>'b2_response_hash','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(p_metadata->>'b2_idempotency_key','') !~ '^[0-9a-f]{64}$' THEN
   RETURN jsonb_build_object('result','invalid_b2_revision_proof');
 END IF;
 -- The cap, existing canonical writer and audit share a single transaction.
 SELECT id,company_id,status,assigned_agent_id INTO v_conv
 FROM public.conversations WHERE id=p_conversation_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
 IF p_metadata->>'b2_expected_company_id' IS DISTINCT FROM v_conv.company_id::text THEN
   RETURN jsonb_build_object('result','tenant_mismatch');
 END IF;
 IF v_conv.status IN ('resolved','closed') THEN RETURN jsonb_build_object('result','already_resolved'); END IF;
 IF v_conv.assigned_agent_id IS NOT NULL OR v_conv.status IN
   ('pending','transferred','human_needed','human_control','escalation_risk','unresolved') THEN
   RETURN jsonb_build_object('result','already_under_human_control');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.messages WHERE id=p_source_message_id
   AND conversation_id=p_conversation_id AND role='visitor' AND COALESCE(is_recalled,false)=false) THEN
   RETURN jsonb_build_object('result','invalid_source_message');
 END IF;
 SELECT id,metadata INTO v_existing FROM public.messages
   WHERE conversation_id=p_conversation_id AND role='assistant' AND is_recalled=false
     AND content<>'__THINKING__' AND metadata->>'source_message_id'=p_source_message_id::text
   ORDER BY created_at,id LIMIT 1;
 IF FOUND THEN
   IF v_existing.metadata->>'escalation_rule' IS DISTINCT FROM 'R2'
      OR COALESCE(v_existing.metadata->>'escalation_action','') NOT IN ('clarification','new_intent_clarification')
      OR v_existing.metadata->>'reason_code' IS DISTINCT FROM p_reason_code
      OR v_existing.metadata->>'b2_response_hash' IS DISTINCT FROM p_metadata->>'b2_response_hash'
      OR v_existing.metadata->>'b2_idempotency_key' IS DISTINCT FROM p_metadata->>'b2_idempotency_key' THEN
     RETURN jsonb_build_object('result','response_substitution');
   END IF;
   v_action:=v_existing.metadata->>'escalation_action';
 ELSE
   SELECT count(*) INTO v_prior FROM public.messages WHERE conversation_id=p_conversation_id
     AND role='assistant' AND COALESCE(is_recalled,false)=false
     AND metadata->>'escalation_rule'='R2' AND metadata->>'escalation_action'='clarification';
   IF v_prior>=1 THEN
     IF p_reason_code IS DISTINCT FROM 'clarification_new_intent_no_kb_match' THEN
       RETURN jsonb_build_object('result','max_clarifications_reached','clarification_attempts',v_prior);
     END IF;
     v_action:='new_intent_clarification';
   END IF;
 END IF;
 v_meta:=p_metadata||jsonb_build_object('escalation_rule','R2','escalation_action',v_action,
    'reason_code',p_reason_code,'handoff_required',false);
 IF v_action='new_intent_clarification' THEN
   v_meta:=v_meta||jsonb_build_object('response_route','kb_no_match_recovery');
 END IF;
 v_result:=public.commit_ai_reply_tx(p_conversation_id,p_source_message_id,p_clarification_content,v_meta);
 v_code:=v_result->>'result';
 IF v_code='idempotent' THEN
   RETURN jsonb_build_object('result','already_handled','message_id',v_result->>'message_id');
 END IF;
 IF v_code='human_control' THEN RETURN jsonb_build_object('result','already_under_human_control'); END IF;
 IF v_code='resolved' THEN RETURN jsonb_build_object('result','already_resolved'); END IF;
 IF v_code IS DISTINCT FROM 'success' THEN RETURN v_result; END IF;
 v_id:=(v_result->>'message_id')::uuid;
 IF v_id IS NULL THEN RAISE EXCEPTION 'R2 canonical success missing message ID'; END IF;
 INSERT INTO public.audit_log(actor_id,actor_type,action,resource_type,resource_id,diff)
 VALUES(NULL,'ai','required_escalation_clarification','message',v_id,
   jsonb_build_object('conversation_id',p_conversation_id,'source_message_id',p_source_message_id,
    'escalation_rule','R2','reason_code',p_reason_code,'clarification_attempt',1,'escalation_action',v_action));
 RETURN jsonb_build_object('result','success','message_id',v_id,'escalation_rule','R2',
    'clarification_attempt',1,'escalation_action',v_action);
END;
$r2bound$;
ALTER FUNCTION public.required_escalation_clarification_tx(uuid,uuid,text,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.required_escalation_clarification_tx(uuid,uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.required_escalation_clarification_tx(uuid,uuid,text,text,text,jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.required_escalation_clarification_tx(uuid,uuid,text,text,text) FROM service_role;
COMMIT;
