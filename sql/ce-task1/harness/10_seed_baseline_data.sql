-- Baseline (pre-migration) seed data for the disposable harness.
-- Mirrors a small but realistic production-like tenant-less starting point.

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111','admin.a@example.test'),
  ('22222222-2222-4222-8222-222222222222','qa.a@example.test'),
  ('33333333-3333-4333-8333-333333333333','agent.a@example.test'),
  ('44444444-4444-4444-8444-444444444444','admin.b@example.test'),
  ('55555555-5555-4555-8555-555555555555','qa.nomember@example.test')
ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles (user_id, role) VALUES
  ('11111111-1111-4111-8111-111111111111','admin'),
  ('22222222-2222-4222-8222-222222222222','qa'),
  ('33333333-3333-4333-8333-333333333333','agent'),
  ('44444444-4444-4444-8444-444444444444','admin'),
  ('55555555-5555-4555-8555-555555555555','qa')
ON CONFLICT DO NOTHING;

INSERT INTO public.agent_profile (id, user_id, display_name, email, role) VALUES
  ('a3333333-3333-4333-8333-333333333333','33333333-3333-4333-8333-333333333333',
   'Agent A','agent.a@example.test','agent')
ON CONFLICT DO NOTHING;

INSERT INTO public.widget_config (id, name) VALUES
  ('c0000000-0000-4000-8000-000000000001','Widget A')
ON CONFLICT DO NOTHING;

INSERT INTO public.channel_config (id, name, widget_config_id) VALUES
  ('c1000000-0000-4000-8000-000000000001','Channel A','c0000000-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;

INSERT INTO public.visitor_session (id, channel_config_id) VALUES
  ('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001')
ON CONFLICT DO NOTHING;

INSERT INTO public.conversations (id, visitor_session_id, channel_config_id, status) VALUES
  ('c3000000-0000-4000-8000-00000000000a','c2000000-0000-4000-8000-000000000001',
   'c1000000-0000-4000-8000-000000000001','resolved')
ON CONFLICT DO NOTHING;

INSERT INTO public.messages (id, conversation_id, role, content, sender_id,
                             sender_identity_verified_at, sender_identity_source) VALUES
  ('c4000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-00000000000a',
   'visitor','Do you ship to Taiwan and what is the refund window?',NULL,NULL,NULL),
  ('c4000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-00000000000a',
   'assistant','We ship worldwide and refunds are always unlimited.',NULL,NULL,NULL),
  ('c4000000-0000-4000-8000-000000000003','c3000000-0000-4000-8000-00000000000a',
   'agent','We ship to Taiwan; refunds are accepted within 30 days of delivery.',
   'a3333333-3333-4333-8333-333333333333', now(), 'agent_send_reply_v1')
ON CONFLICT DO NOTHING;

INSERT INTO public.upstream_call_log (conversation_id, upstream_service, request_payload, response_status)
VALUES ('c3000000-0000-4000-8000-00000000000a','llm',
        '{"tokens_in":120,"tokens_out":48}'::jsonb, 200);
