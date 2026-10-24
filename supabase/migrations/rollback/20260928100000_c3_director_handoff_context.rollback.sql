-- Restore the exact prior C2 trigger function body without touching its ledger or trigger.
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
REVOKE ALL ON FUNCTION public.c2_populate_handoff_package_tg() FROM PUBLIC, anon, authenticated, service_role;
