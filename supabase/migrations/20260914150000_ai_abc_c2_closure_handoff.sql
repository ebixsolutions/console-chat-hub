-- AI-ABC-C2: atomic, source-bound handoff package and conservative AI closure.
-- Rollback: DROP TRIGGER IF EXISTS c2_handoff_package_before_insert ON public.handoff_event;
-- DROP FUNCTION IF EXISTS public.c2_populate_handoff_package_tg();
-- DROP FUNCTION IF EXISTS public.c2_commit_closure_tx(uuid,uuid,uuid,bigint,text,jsonb);

CREATE OR REPLACE FUNCTION public.c2_populate_handoff_package_tg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv record;
  v_latest_source record;
  v_commerce record;
  v_state jsonb := NULL;
  v_source_id uuid;
  v_goal text;
  v_authority text;
  v_reason_code text;
  v_entities jsonb := '[]'::jsonb;
  v_history jsonb := '[]'::jsonb;
  v_confirmed jsonb := '[]'::jsonb;
  v_open jsonb := '[]'::jsonb;
  v_pending jsonb := '[]'::jsonb;
  v_installation text := 'unknown';
  v_package jsonb;
  v_summary text;
BEGIN
  IF NEW.handoff_type IS DISTINCT FROM 'ai_to_agent' THEN
    RETURN NEW;
  END IF;

  SELECT id, company_id, status, assigned_agent_id
    INTO v_conv
    FROM public.conversations
   WHERE id = NEW.conversation_id
   FOR SHARE;
  IF NOT FOUND OR v_conv.company_id IS NULL THEN
    RAISE EXCEPTION 'C2_CONVERSATION_TENANT_UNRESOLVED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, content, created_at
    INTO v_latest_source
    FROM public.messages
   WHERE conversation_id = NEW.conversation_id
     AND role = 'visitor'
     AND COALESCE(is_recalled, false) = false
     AND content <> '__THINKING__'
   ORDER BY created_at DESC, id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'C2_SOURCE_MESSAGE_MISSING' USING ERRCODE = 'P0001';
  END IF;

  v_source_id := COALESCE(NEW.source_message_id, v_latest_source.id);
  IF v_source_id IS DISTINCT FROM v_latest_source.id THEN
    RAISE EXCEPTION 'C2_STALE_SOURCE_MESSAGE' USING ERRCODE = '40001';
  END IF;
  NEW.source_message_id := v_source_id;

  SELECT revision, source_message_id, state, state_hash
    INTO v_commerce
    FROM public.conversation_commerce_state
   WHERE conversation_id = NEW.conversation_id
     AND company_id = v_conv.company_id
   FOR SHARE;
  IF FOUND THEN v_state := v_commerce.state; END IF;

  v_goal := left(COALESCE(
    NULLIF(btrim(v_state->>'current_intent'), ''),
    NULLIF(btrim(v_state->>'current_topic'), ''),
    NULLIF(btrim(v_latest_source.content), ''),
    'unknown'
  ), 1000);
  v_authority := COALESCE(NULLIF(NEW.escalation_rule, ''), NULLIF(NEW.branch_tag, ''), 'existing_escalation_authority');
  v_reason_code := CASE upper(v_authority)
    WHEN 'R1' THEN 'explicit_customer_request'
    WHEN 'E1' THEN 'professional_or_safety_confirmation'
    WHEN 'E2' THEN 'professional_or_safety_confirmation'
    WHEN 'S0' THEN 'operational_follow_up'
    WHEN 'R2' THEN 'unresolved_authority_or_repeated_failure'
    WHEN 'R4' THEN 'policy_exception'
    WHEN 'P2' THEN 'policy_exception'
    ELSE 'existing_escalation_authority'
  END;

  IF v_state IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'entity_id', left(COALESCE(e->>'entity_id',''), 200),
        'category', left(COALESCE(e->>'category',''), 120),
        'brand', NULLIF(left(COALESCE(e->>'brand',''), 120), ''),
        'model', NULLIF(left(COALESCE(e->>'model',''), 120), ''),
        'quantity', COALESCE((e->>'quantity')::numeric, 0),
        'status', e->>'status',
        'current_quote', (
          SELECT jsonb_build_object(
            'amount', (q->>'amount')::numeric,
            'currency', left(COALESCE(q->>'currency',''), 20),
            'status', q->>'validity_status'
          )
          FROM jsonb_array_elements(COALESCE(v_state->'quotes','[]'::jsonb)) q
          WHERE q->>'entity_id' = e->>'entity_id'
            AND q->>'quote_type' = 'current_verified'
            AND q->>'validity_status' = 'current'
          LIMIT 1
        ),
        'pending_issues', '[]'::jsonb
      )
      ORDER BY e->>'entity_id'
    ), '[]'::jsonb)
    INTO v_entities
    FROM jsonb_array_elements(COALESCE(v_state->'entities','[]'::jsonb)) e
    WHERE e->>'status' NOT IN ('cancelled','deferred');

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'key', 'quote:' || left(COALESCE(q->>'quote_id','unknown'),120),
      'value', left(COALESCE(q->>'currency',''),20) || ' ' || left(COALESCE(q->>'amount',''),50),
      'state', q->>'validity_status'
    )), '[]'::jsonb)
    INTO v_history
    FROM jsonb_array_elements(COALESCE(v_state->'quotes','[]'::jsonb)) q
    WHERE COALESCE(q->>'quote_type','') LIKE '%historical%'
       OR q->>'validity_status' IN ('historical','expired','superseded','invalid');

    v_open := COALESCE(v_state->'unresolved_items','[]'::jsonb);
    v_pending := v_open || COALESCE(v_state->'installation'->'pending_checks','[]'::jsonb);
    IF NULLIF(btrim(v_state->'conversion'->>'next_best_action'),'') IS NOT NULL THEN
      v_pending := v_pending || jsonb_build_array(left(v_state->'conversion'->>'next_best_action',500));
    END IF;

    IF v_state->'conversion'->>'order_status' = 'confirmed' THEN
      v_confirmed := v_confirmed || jsonb_build_array(jsonb_build_object('key','order','value','confirmed','source','canonical_commerce_state'));
    END IF;
    IF v_state->'conversion'->>'payment_status' = 'paid' THEN
      v_confirmed := v_confirmed || jsonb_build_array(jsonb_build_object('key','payment','value','paid','source','canonical_commerce_state'));
    END IF;
    IF COALESCE((v_state->'delivery'->>'confirmed')::boolean, false) THEN
      v_confirmed := v_confirmed || jsonb_build_array(jsonb_build_object('key','delivery','value','confirmed','source','canonical_commerce_state'));
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(v_state->'installation'->'items','[]'::jsonb)) i
      WHERE i->>'status' = 'pending'
    ) THEN v_installation := 'pending';
    ELSIF jsonb_array_length(COALESCE(v_state->'installation'->'items','[]'::jsonb)) > 0 THEN
      v_installation := 'confirmed';
    END IF;
  END IF;

  v_package := jsonb_build_object(
    'schema_version', 'c2-handoff-1.0.0',
    'conversation_id', NEW.conversation_id,
    'company_id', v_conv.company_id,
    'handoff_reason', left(COALESCE(NEW.handoff_reason,'Existing handoff authority'),500),
    'handoff_reason_code', v_reason_code,
    'handoff_authority', v_authority,
    'current_customer_goal', v_goal,
    'active_entities', v_entities,
    'latest_corrections', COALESCE(v_state->'latest_corrections','[]'::jsonb),
    'confirmed_facts', v_confirmed,
    'historical_or_superseded_facts', v_history,
    'transaction_state', jsonb_build_object(
      'quotation', COALESCE(v_state->'conversion'->>'quotation_status','unknown'),
      'order', COALESCE(v_state->'conversion'->>'order_status','unknown'),
      'payment', COALESCE(v_state->'conversion'->>'payment_status','unknown'),
      'delivery', CASE WHEN v_state IS NULL THEN 'unknown'
        WHEN COALESCE((v_state->'delivery'->>'confirmed')::boolean,false) THEN 'confirmed'
        ELSE 'not_confirmed' END,
      'installation', v_installation
    ),
    'open_questions', v_open,
    'pending_actions', v_pending,
    'customer_preferences', '[]'::jsonb,
    'current_authoritative_kb_facts', '[]'::jsonb,
    'citations', '[]'::jsonb,
    'safety_or_professional_requirements',
      CASE WHEN upper(v_authority) IN ('E1','E2')
        THEN jsonb_build_array(left(COALESCE(NEW.handoff_reason,'Human confirmation required'),500))
        ELSE '[]'::jsonb END,
    'recommended_next_human_action', COALESCE(
      NULLIF(left(v_state->'conversion'->>'next_best_action',500),''),
      CASE WHEN jsonb_array_length(v_pending)>0
        THEN 'Confirm: ' || left(v_pending->>0,450)
        ELSE 'Review the current request and confirm the next authorized action.' END
    ),
    'generated_from_source_message_id', v_source_id,
    'commerce_state_revision', CASE WHEN v_state IS NULL THEN NULL ELSE v_commerce.revision END,
    'generated_at', now()
  );

  v_summary := concat_ws(E'\n',
    '### Customer Goal', v_goal, '',
    '### Current State',
    '- Active entities: ' || jsonb_array_length(v_entities),
    '- Order: ' || COALESCE(v_state->'conversion'->>'order_status','unknown'),
    '- Payment: ' || COALESCE(v_state->'conversion'->>'payment_status','unknown'),
    '- Delivery: ' || CASE WHEN v_state IS NULL THEN 'unknown'
      WHEN COALESCE((v_state->'delivery'->>'confirmed')::boolean,false) THEN 'confirmed' ELSE 'not_confirmed' END,
    '- Installation: ' || v_installation, '',
    '### Latest Correction',
    CASE WHEN jsonb_array_length(COALESCE(v_state->'latest_corrections','[]'::jsonb))>0
      THEN '- ' || left(COALESCE(v_state->'latest_corrections'->>-1,''),800) ELSE '- —' END, '',
    '### Pending',
    CASE WHEN jsonb_array_length(v_pending)>0 THEN '- ' || left(v_pending->>0,800) ELSE '- —' END, '',
    '### Handoff Reason', left(COALESCE(NEW.handoff_reason,'Existing handoff authority'),500), '',
    '### Recommended Next Action', v_package->>'recommended_next_human_action'
  );

  NEW.ai_summary := jsonb_build_object(
    'schema_version','c2-handoff-1.0.0',
    'structured_package',v_package,
    'summary_markdown',v_summary
  )::text;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS c2_handoff_package_before_insert ON public.handoff_event;
CREATE TRIGGER c2_handoff_package_before_insert
BEFORE INSERT ON public.handoff_event
FOR EACH ROW EXECUTE FUNCTION public.c2_populate_handoff_package_tg();

CREATE OR REPLACE FUNCTION public.c2_commit_closure_tx(
  p_conversation_id uuid,
  p_company_id uuid,
  p_source_message_id uuid,
  p_expected_commerce_revision bigint,
  p_content text,
  p_metadata jsonb DEFAULT NULL::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv record;
  v_source record;
  v_latest_source_id uuid;
  v_commerce record;
  v_message_id uuid;
  v_blocked boolean := false;
BEGIN
  IF p_content IS NULL OR btrim(p_content)='' OR p_content='__THINKING__' OR length(p_content)>4000 THEN
    RETURN jsonb_build_object('result','invalid_content');
  END IF;
  SELECT id, company_id, status, assigned_agent_id
    INTO v_conv FROM public.conversations
   WHERE id=p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF v_conv.company_id IS DISTINCT FROM p_company_id THEN
    RETURN jsonb_build_object('result','tenant_forbidden');
  END IF;

  SELECT id, conversation_id, role, is_recalled, created_at
    INTO v_source FROM public.messages WHERE id=p_source_message_id FOR SHARE;
  IF NOT FOUND OR v_source.conversation_id IS DISTINCT FROM p_conversation_id
     OR v_source.role IS DISTINCT FROM 'visitor' OR COALESCE(v_source.is_recalled,false) THEN
    RETURN jsonb_build_object('result','invalid_source_message');
  END IF;
  SELECT id INTO v_latest_source_id
    FROM public.messages
   WHERE conversation_id=p_conversation_id AND role='visitor'
     AND COALESCE(is_recalled,false)=false AND content<>'__THINKING__'
   ORDER BY created_at DESC,id DESC LIMIT 1;
  IF v_latest_source_id IS DISTINCT FROM p_source_message_id THEN
    RETURN jsonb_build_object('result','superseded_source');
  END IF;

  IF v_conv.status IN ('resolved','closed') THEN
    SELECT id INTO v_message_id FROM public.messages
     WHERE conversation_id=p_conversation_id AND role='assistant'
       AND COALESCE(metadata->>'source_message_id','')=p_source_message_id::text
       AND metadata->>'response_route'='c2_transaction_closure'
     ORDER BY created_at,id LIMIT 1;
    IF FOUND THEN RETURN jsonb_build_object('result','idempotent','message_id',v_message_id); END IF;
    RETURN jsonb_build_object('result','resolved');
  END IF;
  IF v_conv.assigned_agent_id IS NOT NULL OR v_conv.status IN
    ('pending','transferred','human_needed','human_control','escalation_risk','unresolved') THEN
    RETURN jsonb_build_object('result','human_control');
  END IF;
  IF EXISTS (SELECT 1 FROM public.handoff_event WHERE conversation_id=p_conversation_id) THEN
    RETURN jsonb_build_object('result','handoff_pending');
  END IF;

  SELECT revision, source_message_id, state
    INTO v_commerce FROM public.conversation_commerce_state
   WHERE conversation_id=p_conversation_id AND company_id=p_company_id
   FOR SHARE;
  IF FOUND THEN
    IF p_expected_commerce_revision IS NULL OR v_commerce.revision IS DISTINCT FROM p_expected_commerce_revision THEN
      RETURN jsonb_build_object('result','stale_commerce_revision','current_revision',v_commerce.revision);
    END IF;
    v_blocked :=
      jsonb_array_length(COALESCE(v_commerce.state->'unresolved_items','[]'::jsonb))>0
      OR jsonb_array_length(COALESCE(v_commerce.state->'installation'->'pending_checks','[]'::jsonb))>0
      OR COALESCE(v_commerce.state->'conversion'->>'quotation_status','none') IN ('draft','pending_verification')
      OR COALESCE(v_commerce.state->'conversion'->>'order_status','none') IN ('draft','pending_confirmation')
      OR COALESCE(v_commerce.state->'conversion'->>'payment_status','none') IN ('pending_quote','pending_payment')
      OR NULLIF(btrim(COALESCE(v_commerce.state->'conversion'->>'next_best_action','')),'') IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_commerce.state->'entities','[]'::jsonb)) e
        WHERE e->>'status'='tentative'
      )
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_commerce.state->'installation'->'items','[]'::jsonb)) i
        WHERE i->>'status'='pending'
      );
    IF v_blocked THEN RETURN jsonb_build_object('result','transaction_pending'); END IF;
  ELSIF p_expected_commerce_revision IS NOT NULL THEN
    RETURN jsonb_build_object('result','stale_commerce_revision','current_revision',NULL);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.messages WHERE conversation_id=p_conversation_id
      AND role='assistant' AND COALESCE(is_recalled,false)=false
      AND COALESCE(metadata->>'source_message_id','')=p_source_message_id::text
      AND content<>'__THINKING__'
  ) THEN RETURN jsonb_build_object('result','source_already_replied'); END IF;

  DELETE FROM public.messages WHERE conversation_id=p_conversation_id
    AND content='__THINKING__'
    AND COALESCE(metadata->>'source_message_id','')=p_source_message_id::text;

  INSERT INTO public.messages(conversation_id,role,content,status,is_recalled,metadata)
  VALUES (
    p_conversation_id,'assistant',p_content,'delivered',false,
    COALESCE(p_metadata,'{}'::jsonb)
      || jsonb_build_object(
        'source_message_id',p_source_message_id::text,
        'control_commit','ai',
        'response_route','c2_transaction_closure',
        'closure_state','RESOLVED',
        'commerce_state_revision',CASE WHEN v_commerce IS NULL THEN NULL ELSE v_commerce.revision END
      )
  ) RETURNING id INTO v_message_id;

  UPDATE public.conversations SET status='resolved',resolved_at=now(),updated_at=now()
   WHERE id=p_conversation_id;
  INSERT INTO public.conversation_status_log(
    conversation_id,old_status,new_status,changed_by,changed_by_type,reason
  ) VALUES (p_conversation_id,v_conv.status,'resolved',NULL,'ai','C2 canonical closure');
  INSERT INTO public.audit_log(actor_id,actor_type,action,resource_type,resource_id,diff)
  VALUES (
    NULL,'ai','c2_resolve_conversation','conversations',p_conversation_id,
    jsonb_build_object(
      'company_id',p_company_id,'source_message_id',p_source_message_id,
      'commerce_state_revision',CASE WHEN v_commerce IS NULL THEN NULL ELSE v_commerce.revision END,
      'old_status',v_conv.status,'new_status','resolved','message_id',v_message_id
    )
  );
  RETURN jsonb_build_object('result','success','message_id',v_message_id,'new_status','resolved');
END;
$function$;

REVOKE ALL ON FUNCTION public.c2_commit_closure_tx(uuid,uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.c2_commit_closure_tx(uuid,uuid,uuid,bigint,text,jsonb) TO service_role;
