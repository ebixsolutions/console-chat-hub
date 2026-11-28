-- Execute only on the isolated C3 nonproduction database. All fixture writes roll back.
BEGIN;
DO $test$
DECLARE
  tenant uuid := '00000000-0000-4000-8000-000000002201';
  conv uuid := '00000000-0000-4000-8000-000000002202';
  source uuid := '00000000-0000-4000-8000-000000002203';
  other_source uuid := '00000000-0000-4000-8000-000000002204';
  reply text := '好，雪櫃先暫停；而家繼續處理冷氣，之前嘅要求同數量會保留。';
  digest_hex text;
  proof jsonb;
  outcome jsonb;
  alternate_hash text;
  alternate_proof jsonb;
  response_id uuid;
BEGIN
  INSERT INTO public.company(id,slug,display_name,external_workspace_id,external_tenant_id,platform_company_id)
    VALUES(tenant,'c3-t11-reply-test','C3 Test','c3-t11-reply-test','c3-t11-reply-test',99002201);
  INSERT INTO public.conversations(id,company_id,status) VALUES(conv,tenant,'open');
  INSERT INTO public.messages(id,conversation_id,role,content,is_recalled)
    VALUES(source,conv,'visitor','雪櫃暫時唔換住，先搞冷氣。',false);
  INSERT INTO public.messages(conversation_id,role,content,status,is_recalled,metadata)
    VALUES(conv,'assistant','__THINKING__','sending',false,jsonb_build_object('source_message_id',source::text));
  INSERT INTO public.conversation_commerce_state(conversation_id,company_id,revision,source_message_id,state,state_hash)
    SELECT conv,tenant,9,source,'{"version":"commerce-state-1.0.0"}'::jsonb,
      encode(extensions.digest('{"version": "commerce-state-1.0.0"}'::jsonb::text,'sha256'),'hex');

  digest_hex := encode(extensions.digest(convert_to(reply,'UTF8'),'sha256'),'hex');
  proof := jsonb_build_object(
    'b2_gate_contract','executeB2PersistenceGate:allow_after_revalidation',
    'b2_commit_source','commit_ai_reply_tx',
    'b2_expected_company_id',tenant::text,
    'b2_source_message_id',source::text,
    'b2_expected_revision',9,
    'b2_response_hash',digest_hex,
    'b2_idempotency_key',encode(extensions.digest(convert_to(
      tenant::text || ':' || conv::text || ':' || source::text || ':9:' || digest_hex,
      'UTF8'),'sha256'),'hex'));

  outcome := public.commit_ai_reply_tx(conv,source,reply,proof);
  IF outcome->>'result' <> 'success' THEN RAISE EXCEPTION 'normal reply: %',outcome; END IF;
  response_id := (outcome->>'message_id')::uuid;
  IF EXISTS(SELECT 1 FROM public.messages WHERE conversation_id=conv AND content='__THINKING__')
     OR (SELECT count(*) FROM public.messages WHERE conversation_id=conv AND role='assistant') <> 1 THEN
    RAISE EXCEPTION 'placeholder/assistant cardinality violated';
  END IF;
  outcome := public.commit_ai_reply_tx(conv,source,reply,proof);
  IF outcome->>'result' <> 'idempotent' OR (outcome->>'message_id')::uuid <> response_id THEN
    RAISE EXCEPTION 'network retry: %',outcome;
  END IF;
  outcome := public.commit_ai_reply_tx(conv,source,reply || ' altered',proof);
  IF outcome->>'result' <> 'response_hash_mismatch' THEN RAISE EXCEPTION 'hash substitution: %',outcome; END IF;
  alternate_hash := encode(extensions.digest(convert_to(reply || ' altered','UTF8'),'sha256'),'hex');
  alternate_proof := proof || jsonb_build_object(
    'b2_response_hash',alternate_hash,
    'b2_idempotency_key',encode(extensions.digest(convert_to(
      tenant::text || ':' || conv::text || ':' || source::text || ':9:' || alternate_hash,
      'UTF8'),'sha256'),'hex'));
  outcome := public.commit_ai_reply_tx(conv,source,reply || ' altered',alternate_proof);
  IF outcome->>'result' <> 'response_substitution' THEN RAISE EXCEPTION 'same source alternate response: %',outcome; END IF;
  outcome := public.commit_ai_reply_tx(conv,source,reply,proof || jsonb_build_object('b2_expected_company_id',gen_random_uuid()::text));
  IF outcome->>'result' <> 'invalid_b2_revision_proof' THEN RAISE EXCEPTION 'wrong tenant: %',outcome; END IF;
  outcome := public.commit_ai_reply_tx(conv,source,reply,proof || jsonb_build_object('b2_expected_revision',8));
  IF outcome->>'result' <> 'response_hash_mismatch' THEN RAISE EXCEPTION 'wrong revision/key: %',outcome; END IF;
  outcome := public.commit_ai_reply_tx(gen_random_uuid(),source,reply,proof);
  IF outcome->>'result' <> 'not_found' THEN RAISE EXCEPTION 'wrong conversation: %',outcome; END IF;
  outcome := public.commit_ai_reply_tx(conv,gen_random_uuid(),reply,proof);
  IF outcome->>'result' <> 'invalid_source_message' THEN RAISE EXCEPTION 'wrong source: %',outcome; END IF;
  UPDATE public.conversation_commerce_state SET revision=10 WHERE conversation_id=conv;
  outcome := public.commit_ai_reply_tx(conv,source,reply,proof);
  IF outcome->>'result' <> 'stale_authorized_revision' THEN RAISE EXCEPTION 'revision race: %',outcome; END IF;
  INSERT INTO public.messages(id,conversation_id,role,content,is_recalled)
    VALUES(other_source,conv,'visitor','Newer turn',false);
  outcome := public.commit_ai_reply_tx(conv,source,reply,proof);
  IF outcome->>'result' <> 'superseded_source' THEN RAISE EXCEPTION 'newer source: %',outcome; END IF;
  UPDATE public.conversations SET status='pending' WHERE id=conv;
  outcome := public.commit_ai_reply_tx(conv,source,reply,proof);
  IF outcome->>'result' <> 'human_control' THEN RAISE EXCEPTION 'human guard: %',outcome; END IF;
  UPDATE public.conversations SET status='resolved' WHERE id=conv;
  outcome := public.commit_ai_reply_tx(conv,source,reply,proof);
  IF outcome->>'result' <> 'resolved' THEN RAISE EXCEPTION 'resolved guard: %',outcome; END IF;
  IF (SELECT count(*) FROM public.messages WHERE conversation_id=conv AND role='assistant') <> 1 THEN
    RAISE EXCEPTION 'duplicate assistant';
  END IF;
END;
$test$;
ROLLBACK;
