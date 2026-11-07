-- Disposable native test schema ONLY. Never a Production migration/fixture.
CREATE TABLE company(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true);
CREATE TABLE company_membership(user_id uuid,company_id uuid,is_active boolean,role text);
CREATE TABLE channel_config(id uuid PRIMARY KEY,company_id uuid,is_active boolean,channel_type text);
CREATE TABLE visitor_session(id uuid PRIMARY KEY,session_token text,visitor_fingerprint text,visitor_metadata jsonb,last_seen_at timestamptz,channel_config_id uuid);
ALTER TABLE conversations ADD COLUMN visitor_session_id uuid,ADD COLUMN channel_config_id uuid,ADD COLUMN status text;
INSERT INTO company VALUES('4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec',true),('3d6e17b5-ec79-4f75-aa7f-eaa824ff8493',true);
INSERT INTO company_membership VALUES('4348ee35-9632-4626-a846-e313bcc4a5f9','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec',true,'admin'),('11111111-2222-4333-8444-555555555555','3d6e17b5-ec79-4f75-aa7f-eaa824ff8493',true,'admin');
INSERT INTO channel_config VALUES('0405282f-77dc-47cf-8074-99dd3dc6c393','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec',true,'web_widget'),('b0000000-0000-0000-0000-000000000001','3d6e17b5-ec79-4f75-aa7f-eaa824ff8493',true,'web_widget');
-- Original narrow fixtures predate channel/session fields. Materialize these
-- solely in the native harness, preserving explicit negative-test overrides.
CREATE FUNCTION native_bind_test_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text; channel uuid;
BEGIN
 IF NEW.metadata_source->>'exclude_training'='true' THEN
  actor:=CASE WHEN NEW.company_id='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec' THEN '4348ee35-9632-4626-a846-e313bcc4a5f9' ELSE '11111111-2222-4333-8444-555555555555' END;
  channel:=CASE WHEN NEW.company_id='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec' THEN '0405282f-77dc-47cf-8074-99dd3dc6c393'::uuid ELSE 'b0000000-0000-0000-0000-000000000001'::uuid END;
  NEW.channel_config_id:=coalesce(NEW.channel_config_id,channel);
  NEW.visitor_session_id:=coalesce(NEW.visitor_session_id,gen_random_uuid());
  NEW.metadata_source:=jsonb_build_object('source','c3_uat_widget','synthetic',true,'owner_user_id',actor)||NEW.metadata_source;
  INSERT INTO visitor_session(id,channel_config_id,visitor_metadata) VALUES(NEW.visitor_session_id,NEW.channel_config_id,jsonb_build_object('source','c3_uat_widget','owner_user_id',actor,'exclude_training',true)) ON CONFLICT(id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_bind_test_ticket BEFORE INSERT ON conversations FOR EACH ROW EXECUTE FUNCTION native_bind_test_ticket();
