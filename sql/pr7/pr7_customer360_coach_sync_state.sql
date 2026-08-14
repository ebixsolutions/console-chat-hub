-- Workflow 5 / Task 5.3 — Customer360 ↔ SU CoachAI sync state
-- Source-only migration. No production apply without explicit authorization.

BEGIN;
SET LOCAL lock_timeout='10s';

CREATE TABLE IF NOT EXISTS public.customer360_coach_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL
    REFERENCES public.company(id) ON DELETE RESTRICT,
  customer_ref_sha256 text NOT NULL,
  outbound_payload_sha256 text NOT NULL,
  outbound_version text NOT NULL,
  inbound_payload_sha256 text,
  inbound_version text,
  coaching_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_status text NOT NULL
    CHECK (last_status IN ('applied','no_op','failed')),
  last_error_code text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT customer360_coach_sync_customer_hash_format
    CHECK (customer_ref_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer360_coach_sync_outbound_hash_format
    CHECK (outbound_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer360_coach_sync_inbound_hash_format
    CHECK (inbound_payload_sha256 IS NULL OR inbound_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer360_coach_sync_error_consistency
    CHECK (
      (last_status='failed' AND last_error_code IS NOT NULL)
      OR
      (last_status<>'failed' AND last_error_code IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer360_coach_sync_company_customer
  ON public.customer360_coach_sync_state(company_id, customer_ref_sha256);

CREATE INDEX IF NOT EXISTS idx_customer360_coach_sync_company_updated
  ON public.customer360_coach_sync_state(company_id, updated_at DESC);

ALTER TABLE public.customer360_coach_sync_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.customer360_coach_sync_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.customer360_coach_sync_state TO service_role;

COMMENT ON TABLE public.customer360_coach_sync_state IS
  'Company-scoped Customer360↔CoachAI idempotency state. Stores hashes and sanitized coaching signals only; never raw customer identity/PII.';

COMMIT;
