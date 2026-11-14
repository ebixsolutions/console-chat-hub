-- C3 isolated nonproduction KB and Customer360 contract.
-- This file is intentionally outside supabase/migrations: it must never run in production.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE TABLE IF NOT EXISTS public.c3_nonprod_kb_tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL UNIQUE REFERENCES public.company(id) ON DELETE CASCADE,
  external_tenant_id bigint NOT NULL UNIQUE CHECK (external_tenant_id > 0),
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.c3_nonprod_kb_document (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.c3_nonprod_kb_tenant(id) ON DELETE CASCADE,
  title text NOT NULL,
  source_type text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  status text NOT NULL CHECK (status IN ('draft','pending_review','approved','published','archived')),
  publication_state text NOT NULL CHECK (publication_state IN ('draft','unpublished','published')),
  currentness text NOT NULL CHECK (currentness IN ('current','historical','superseded','cancelled')),
  version text NOT NULL,
  version_rank integer NOT NULL CHECK (version_rank > 0),
  source_priority integer NOT NULL DEFAULT 100,
  authority_scope text NOT NULL DEFAULT 'customer_support',
  effective_at timestamptz,
  expires_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  claims jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(claims) = 'array')
);

CREATE TABLE IF NOT EXISTS public.c3_nonprod_kb_document_version (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES public.c3_nonprod_kb_document(id) ON DELETE CASCADE,
  version text NOT NULL,
  version_rank integer NOT NULL CHECK (version_rank > 0),
  raw_content_snapshot text NOT NULL,
  rag_summary text,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  review_status text NOT NULL CHECK (review_status IN ('pending','approved','rejected')),
  vector_status text NOT NULL DEFAULT 'not_generated'
    CHECK (vector_status IN ('not_generated','generating','generated','failed','outdated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id, version_rank)
);

CREATE TABLE IF NOT EXISTS public.c3_nonprod_kb_chunk (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES public.c3_nonprod_kb_document(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES public.c3_nonprod_kb_document_version(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  chunk_text text NOT NULL,
  chunk_type text NOT NULL CHECK (chunk_type IN ('rag_summary','full_content','faq_pair','section')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived','failed')),
  embedding_status text NOT NULL DEFAULT 'pending'
    CHECK (embedding_status IN ('pending','generating','generated','failed')),
  embedding_model text,
  embedding_dimensions integer,
  embedded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(version_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS public.c3_nonprod_crm_customer (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  customer_ref text NOT NULL CHECK (customer_ref ~ '^cus_[A-Za-z0-9_-]{16,64}$'),
  source_identity text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, conversation_id, customer_ref)
);

CREATE TABLE IF NOT EXISTS public.c3_nonprod_crm_entitlement (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.c3_nonprod_crm_customer(id) ON DELETE CASCADE,
  name text NOT NULL,
  value text NOT NULL,
  scope text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','inactive')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK (valid_until > valid_from),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.c3_nonprod_kb_tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.c3_nonprod_kb_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.c3_nonprod_kb_document_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.c3_nonprod_kb_chunk ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.c3_nonprod_crm_customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.c3_nonprod_crm_entitlement ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.c3_nonprod_kb_tenant FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.c3_nonprod_kb_document FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.c3_nonprod_kb_document_version FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.c3_nonprod_kb_chunk FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.c3_nonprod_crm_customer FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.c3_nonprod_crm_entitlement FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.c3_nonprod_kb_tenant TO service_role;
GRANT ALL ON public.c3_nonprod_kb_document TO service_role;
GRANT ALL ON public.c3_nonprod_kb_document_version TO service_role;
GRANT ALL ON public.c3_nonprod_kb_chunk TO service_role;
GRANT ALL ON public.c3_nonprod_crm_customer TO service_role;
GRANT ALL ON public.c3_nonprod_crm_entitlement TO service_role;

CREATE OR REPLACE FUNCTION public.c3_nonprod_resolve_secret(p_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_claims text := current_setting('request.jwt.claims', true);
DECLARE v_role text := COALESCE(
  NULLIF(current_setting('request.jwt.claim.role', true), ''),
  CASE WHEN COALESCE(v_claims, '') <> '' THEN v_claims::jsonb ->> 'role' END,
  auth.role()::text
);
DECLARE v_secret text;
BEGIN
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501';
  END IF;
  IF p_name NOT IN ('c3_customer360_internal_token','c3_customer360_upstream_token','c3_kb_internal_token') THEN
    RAISE EXCEPTION 'secret_name_not_allowed' USING ERRCODE = '42501';
  END IF;
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = p_name;
  RETURN v_secret;
END;
$$;
REVOKE ALL ON FUNCTION public.c3_nonprod_resolve_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.c3_nonprod_resolve_secret(text) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name='c3_customer360_internal_token') THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(32),'hex'),'c3_customer360_internal_token','C3 isolated adapter internal token');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name='c3_customer360_upstream_token') THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(32),'hex'),'c3_customer360_upstream_token','C3 isolated Customer360 upstream token');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name='c3_kb_internal_token') THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(32),'hex'),'c3_kb_internal_token','C3 isolated KB internal token');
  END IF;
END $$;
