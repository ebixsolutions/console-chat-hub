-- Disposable local native test schema only. Not a migration or hosted product.
CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
GRANT USAGE ON SCHEMA public,extensions TO service_role;
CREATE TABLE company(id uuid PRIMARY KEY);
CREATE TABLE conversations(id uuid PRIMARY KEY,company_id uuid);
CREATE TABLE messages(id uuid PRIMARY KEY,conversation_id uuid,role text,content text,is_recalled boolean DEFAULT false,metadata jsonb,created_at timestamptz DEFAULT now());
CREATE TABLE conversation_commerce_state(conversation_id uuid PRIMARY KEY,company_id uuid,revision bigint);
CREATE TABLE conversation_memory_state(conversation_id uuid PRIMARY KEY,company_id uuid,revision bigint,source_message_id uuid,commerce_state_revision bigint,memory jsonb,markdown_projection text,memory_hash text,updated_from_turn bigint,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE conversation_memory_state_event(source_message_id uuid PRIMARY KEY,conversation_id uuid,company_id uuid,applied_revision bigint,commerce_state_revision bigint,memory_hash text);
