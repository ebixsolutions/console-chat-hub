-- Dev21 UAT Seed Recovery: widget_config + channel_config default data
-- Idempotent: ON CONFLICT updates all seed fields to ensure deterministic recovery.

INSERT INTO widget_config (
  id,
  name,
  header_title,
  is_active,
  primary_color,
  welcome_message,
  placeholder_text
) VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'Default Web Widget',
  'Customer Support',
  true,
  '#6B5CE7',
  'Hi! How can we help you today?',
  'Type a message…'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  header_title = EXCLUDED.header_title,
  is_active = true,
  primary_color = EXCLUDED.primary_color,
  welcome_message = EXCLUDED.welcome_message,
  placeholder_text = EXCLUDED.placeholder_text,
  updated_at = now();

INSERT INTO channel_config (
  id,
  name,
  channel_type,
  is_active,
  widget_config_id,
  allowed_origins
) VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'Website Live Chat',
  'web_widget',
  true,
  'a0000000-0000-0000-0000-000000000001',
  ARRAY['https://console-chat-hub.lovable.app']
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  channel_type = 'web_widget',
  is_active = true,
  widget_config_id = EXCLUDED.widget_config_id,
  allowed_origins = EXCLUDED.allowed_origins,
  updated_at = now();