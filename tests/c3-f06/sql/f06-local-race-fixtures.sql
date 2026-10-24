-- DISPOSABLE local DB only, synthetic rows. Never production.
DO $$ BEGIN IF current_database() NOT LIKE 'c3_f06_isolated_%' THEN RAISE EXCEPTION 'Refuse nonisolated database'; END IF; END $$;
INSERT INTO public.company(id,slug,display_name,external_workspace_id,external_tenant_id,platform_company_id) VALUES('f7000000-0000-4000-8000-000000000001','synthetic-1','Synthetic','Synthetic','Synthetic',1);
INSERT INTO auth.users(id,email) VALUES('f7000000-0000-4000-8000-000000000010','synthetic10@example.invalid');
INSERT INTO public.agent_profile(id,user_id,display_name,email,status) VALUES('f7000000-0000-4000-8000-000000000010','f7000000-0000-4000-8000-000000000010','Agent','synthetic10@example.invalid','active');
INSERT INTO public.company_membership(company_id,user_id,role) VALUES('f7000000-0000-4000-8000-000000000001','f7000000-0000-4000-8000-000000000010','agent');
INSERT INTO public.conversations(id,company_id,status,assigned_agent_id) VALUES('f7000000-0000-4000-8000-000000000020','f7000000-0000-4000-8000-000000000001','pending','f7000000-0000-4000-8000-000000000010');
