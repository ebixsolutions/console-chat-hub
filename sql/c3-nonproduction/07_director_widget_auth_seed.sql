\set ON_ERROR_STOP on
-- Match the production SELECT ACL readback; RLS remains authoritative.
GRANT SELECT ON public.company, public.company_membership,
  public.channel_config, public.widget_config TO authenticated;
INSERT INTO public.company (id,slug,display_name,external_workspace_id,external_tenant_id)
VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','c3-widget-owned','C3 widget owner','widget-isolated','owned'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','c3-widget-other','C3 widget other','widget-isolated','other');
INSERT INTO public.company_membership(company_id,user_id,role)
VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', :'owner_id'::uuid, 'admin'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', :'agent_id'::uuid, 'agent'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', :'outsider_id'::uuid, 'admin');
INSERT INTO public.widget_config(id,name,header_title)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','C3 owned widget','Owned widget');
INSERT INTO public.channel_config(id,name,channel_type,widget_config_id,company_id,is_active)
VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','C3 owned channel','web_widget',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Other tenant channel','web_widget',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true);
