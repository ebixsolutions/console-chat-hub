-- Exact-ID cleanup for the C3 provisioning smoke fixture only.
-- Held-out runner fixtures are deterministically generated and cleaned by
-- c3_nonproduction_external_quality.mjs.
BEGIN;

DELETE FROM public.conversation_memory_state_event WHERE conversation_id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.conversation_memory_state WHERE conversation_id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.conversation_commerce_state_event WHERE conversation_id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.conversation_commerce_state WHERE conversation_id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.ce_evaluation_job WHERE conversation_id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.ce_evaluation_state WHERE conversation_id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.human_support_queue WHERE conversation_id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.handoff_event WHERE conversation_id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.ai_reply_draft WHERE conversation_id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.upstream_call_log WHERE conversation_id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.messages WHERE conversation_id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.conversations WHERE id IN (
  'c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000150');
DELETE FROM public.visitor_session WHERE id='c3000000-0000-4000-8000-000000000140';
DELETE FROM public.channel_config WHERE id='c3000000-0000-4000-8000-000000000130';
DELETE FROM public.widget_config WHERE id='c3000000-0000-4000-8000-000000000120';
DELETE FROM public.company_membership WHERE id='c3000000-0000-4000-8000-000000000111';
DELETE FROM public.user_roles WHERE user_id='c3000000-0000-4000-8000-000000000101';
DELETE FROM public.agent_profile WHERE id='c3000000-0000-4000-8000-000000000110';
DELETE FROM auth.identities WHERE user_id='c3000000-0000-4000-8000-000000000101';
DELETE FROM auth.users WHERE id='c3000000-0000-4000-8000-000000000101';
DELETE FROM public.company WHERE id IN (
  'c3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000002');
DELETE FROM net._http_response WHERE id IN (
  SELECT request_id FROM public.c3_nonproduction_http_probe WHERE run_id='c3-smoke-2c1b9566');
DELETE FROM public.c3_nonproduction_http_probe WHERE run_id='c3-smoke-2c1b9566';

COMMIT;
