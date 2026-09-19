-- C3 exact-ID synthetic KB/CRM/HTTP fixture. Nonproduction project only.
-- The test-agent password is generated inside Vault and never committed or returned.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name='c3_test_agent_password') THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(24),'base64'),'c3_test_agent_password','C3 synthetic test agent password');
  END IF;
END $$;

INSERT INTO auth.users (
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at,
  confirmation_token,email_change,email_change_token_new,recovery_token
)
SELECT
  '00000000-0000-0000-0000-000000000000',
  'c3000000-0000-4000-8000-000000000101','authenticated','authenticated',
  'c3-agent-2c1b9566@example.invalid',crypt(decrypted_secret,gen_salt('bf')),now(),
  '{"provider":"email","providers":["email"]}'::jsonb,'{"synthetic":true,"c3":true}'::jsonb,
  now(),now(),'','','',''
FROM vault.decrypted_secrets WHERE name='c3_test_agent_password'
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (id,user_id,identity_data,provider,provider_id,last_sign_in_at,created_at,updated_at)
VALUES (
  'c3000000-0000-4000-8000-000000000102',
  'c3000000-0000-4000-8000-000000000101',
  '{"sub":"c3000000-0000-4000-8000-000000000101","email":"c3-agent-2c1b9566@example.invalid","email_verified":true,"synthetic":true}'::jsonb,
  'email','c3000000-0000-4000-8000-000000000101',now(),now(),now()
) ON CONFLICT DO NOTHING;

INSERT INTO public.company (id,slug,display_name,external_workspace_id,external_tenant_id,is_active,platform_company_id)
VALUES
 ('c3000000-0000-4000-8000-000000000001','c3-synthetic-a','C3 Synthetic Company A','c3-workspace-a','c3-tenant-a',true,93001),
 ('c3000000-0000-4000-8000-000000000002','c3-synthetic-b','C3 Synthetic Company B','c3-workspace-b','c3-tenant-b',true,93002)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.agent_profile (id,user_id,display_name,email,role,status)
VALUES ('c3000000-0000-4000-8000-000000000110','c3000000-0000-4000-8000-000000000101','C3 Synthetic Agent','c3-agent-2c1b9566@example.invalid','agent','active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (id,user_id,role)
VALUES ('c3000000-0000-4000-8000-000000000112','c3000000-0000-4000-8000-000000000101','agent')
ON CONFLICT DO NOTHING;
INSERT INTO public.company_membership (id,company_id,user_id,role,is_active)
VALUES ('c3000000-0000-4000-8000-000000000111','c3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000101','agent',true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.widget_config (id,name,header_title,is_active)
VALUES ('c3000000-0000-4000-8000-000000000120','C3 Synthetic Widget','C3 Synthetic Support',true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.channel_config (id,name,channel_type,widget_config_id,allowed_origins,is_active,company_id)
VALUES ('c3000000-0000-4000-8000-000000000130','C3 Synthetic Channel','web_widget','c3000000-0000-4000-8000-000000000120',ARRAY['https://nonproduction.invalid'],true,'c3000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.visitor_session (id,session_token,channel_config_id,visitor_fingerprint,visitor_metadata)
VALUES ('c3000000-0000-4000-8000-000000000140','c3-synthetic-session-2c1b9566','c3000000-0000-4000-8000-000000000130','c3-synthetic-fingerprint','{"synthetic":true,"customer_ref":"cus_c3synthetic00000001"}'::jsonb)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.conversations (id,visitor_session_id,channel_config_id,status,assigned_agent_id,company_id,language,metadata_source)
VALUES
 ('c3000000-0000-4000-8000-000000000005','c3000000-0000-4000-8000-000000000140','c3000000-0000-4000-8000-000000000130','open',null,'c3000000-0000-4000-8000-000000000001','en','{"source":"c3_nonproduction_smoke","synthetic":true}'::jsonb),
 ('c3000000-0000-4000-8000-000000000150','c3000000-0000-4000-8000-000000000140','c3000000-0000-4000-8000-000000000130','pending','c3000000-0000-4000-8000-000000000110','c3000000-0000-4000-8000-000000000001','en','{"source":"c3_nonproduction_smoke","synthetic":true}'::jsonb)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.messages (id,conversation_id,role,content,metadata)
VALUES
 ('c3000000-0000-4000-8000-000000000006','c3000000-0000-4000-8000-000000000005','visitor','Can you confirm the synthetic island delivery policy and my support entitlement?','{"synthetic":true}'::jsonb),
 ('c3000000-0000-4000-8000-000000000151','c3000000-0000-4000-8000-000000000150','visitor','Draft a reply about the synthetic island delivery policy and entitlement.','{"synthetic":true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.c3_nonprod_kb_tenant (id,company_id,external_tenant_id,name,is_active)
VALUES
 ('c3000000-0000-4000-8000-000000001001','c3000000-0000-4000-8000-000000000001',93001,'C3 KB Tenant A',true),
 ('c3000000-0000-4000-8000-000000001002','c3000000-0000-4000-8000-000000000002',93002,'C3 KB Tenant B',true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.c3_nonprod_kb_document
 (id,tenant_id,title,source_type,language,status,publication_state,currentness,version,version_rank,source_priority,authority_scope,effective_at,published_at,claims)
VALUES
 ('c3000000-0000-4000-8000-000000001101','c3000000-0000-4000-8000-000000001001','Synthetic Island Delivery Policy','policy','en','published','published','current','v1',1,100,'customer_support','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','[{"key":"island_delivery_days","value":"3"}]'::jsonb),
 ('c3000000-0000-4000-8000-000000001102','c3000000-0000-4000-8000-000000001001','Synthetic Draft Secret','policy','en','draft','draft','current','v1',1,100,'customer_support','2026-01-01T00:00:00Z',null,'[]'::jsonb),
 ('c3000000-0000-4000-8000-000000001103','c3000000-0000-4000-8000-000000001002','Other Tenant Island Delivery','policy','en','published','published','current','v1',1,100,'customer_support','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','[]'::jsonb),
 ('c3000000-0000-4000-8000-000000001104','c3000000-0000-4000-8000-000000001001','Synthetic Conflict Policy A','policy','en','published','published','current','v1',1,100,'customer_support','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','[{"key":"conflict-policy","value":"A"}]'::jsonb),
 ('c3000000-0000-4000-8000-000000001105','c3000000-0000-4000-8000-000000001001','Synthetic Conflict Policy B','policy','en','published','published','current','v1',1,100,'customer_support','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','[{"key":"conflict-policy","value":"B"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.c3_nonprod_kb_document_version
 (id,document_id,version,version_rank,raw_content_snapshot,rag_summary,content_hash,review_status,vector_status)
SELECT v.id,v.document_id,'v1',1,v.body,null,encode(digest(v.body,'sha256'),'hex'),'approved','not_generated'
FROM (VALUES
 ('c3000000-0000-4000-8000-000000001201'::uuid,'c3000000-0000-4000-8000-000000001101'::uuid,'Synthetic island delivery takes three business days and requires address confirmation.'),
 ('c3000000-0000-4000-8000-000000001202'::uuid,'c3000000-0000-4000-8000-000000001102'::uuid,'DRAFT-SYNTHETIC-SECRET must never be retrieved.'),
 ('c3000000-0000-4000-8000-000000001203'::uuid,'c3000000-0000-4000-8000-000000001103'::uuid,'OTHER-TENANT-SYNTHETIC-CONTENT must never cross tenant boundaries.'),
 ('c3000000-0000-4000-8000-000000001204'::uuid,'c3000000-0000-4000-8000-000000001104'::uuid,'conflict-policy synthetic answer A'),
 ('c3000000-0000-4000-8000-000000001205'::uuid,'c3000000-0000-4000-8000-000000001105'::uuid,'conflict-policy synthetic answer B')
) AS v(id,document_id,body)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.c3_nonprod_kb_chunk
 (id,document_id,version_id,chunk_index,chunk_text,chunk_type,status,embedding_status)
SELECT id,document_id,version_id,0,body,'full_content','active','pending'
FROM (VALUES
 ('c3000000-0000-4000-8000-000000001301'::uuid,'c3000000-0000-4000-8000-000000001101'::uuid,'c3000000-0000-4000-8000-000000001201'::uuid,'Synthetic island delivery takes three business days and requires address confirmation.'),
 ('c3000000-0000-4000-8000-000000001302'::uuid,'c3000000-0000-4000-8000-000000001102'::uuid,'c3000000-0000-4000-8000-000000001202'::uuid,'DRAFT-SYNTHETIC-SECRET must never be retrieved.'),
 ('c3000000-0000-4000-8000-000000001303'::uuid,'c3000000-0000-4000-8000-000000001103'::uuid,'c3000000-0000-4000-8000-000000001203'::uuid,'OTHER-TENANT-SYNTHETIC-CONTENT must never cross tenant boundaries.'),
 ('c3000000-0000-4000-8000-000000001304'::uuid,'c3000000-0000-4000-8000-000000001104'::uuid,'c3000000-0000-4000-8000-000000001204'::uuid,'conflict-policy synthetic answer A'),
 ('c3000000-0000-4000-8000-000000001305'::uuid,'c3000000-0000-4000-8000-000000001105'::uuid,'c3000000-0000-4000-8000-000000001205'::uuid,'conflict-policy synthetic answer B')
) AS c(id,document_id,version_id,body)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.c3_nonprod_crm_customer
 (id,company_id,conversation_id,customer_ref,source_identity,context,is_active)
VALUES
 ('c3000000-0000-4000-8000-000000001401','c3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000005','cus_c3synthetic00000001','c3-customer360-db-v1','{"tier":"synthetic-priority","language_preference":"en","context_quality":"verified_synthetic"}'::jsonb,true),
 ('c3000000-0000-4000-8000-000000001402','c3000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000150','cus_c3synthetic00000001','c3-customer360-db-v1','{"tier":"synthetic-priority","language_preference":"en","context_quality":"verified_synthetic"}'::jsonb,true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.c3_nonprod_crm_entitlement
 (id,customer_id,name,value,scope,status,valid_from,valid_until)
VALUES
 ('c3000000-0000-4000-8000-000000001501','c3000000-0000-4000-8000-000000001401','priority_support','eligible','customer_support','active','2026-01-01T00:00:00Z','2099-01-01T00:00:00Z'),
 ('c3000000-0000-4000-8000-000000001502','c3000000-0000-4000-8000-000000001402','priority_support','eligible','customer_support','active','2026-01-01T00:00:00Z','2099-01-01T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

COMMIT;
