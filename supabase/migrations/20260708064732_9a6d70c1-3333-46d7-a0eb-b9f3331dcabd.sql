-- M2: Add provider-neutral tracking columns
ALTER TABLE public.feedback_request
  ADD COLUMN IF NOT EXISTS email_provider text,
  ADD COLUMN IF NOT EXISTS email_provider_message_id text,
  ADD COLUMN IF NOT EXISTS delivery_event_received_at timestamptz;

-- M2: Extend delivery_error_type CHECK to include provider_* values
-- Preserves all existing resend_* values for historical rows
ALTER TABLE public.feedback_request
  DROP CONSTRAINT IF EXISTS feedback_request_delivery_error_type_check;

ALTER TABLE public.feedback_request
  ADD CONSTRAINT feedback_request_delivery_error_type_check
  CHECK (
    delivery_error_type IS NULL
    OR delivery_error_type IN (
      'resend_auth_error',
      'resend_validation_error',
      'resend_rate_limited',
      'email_send_failed',
      'config_error',
      'missing_recipient_email',
      'provider_auth_error',
      'provider_validation_error',
      'provider_rate_limited',
      'provider_send_failed'
    )
  );