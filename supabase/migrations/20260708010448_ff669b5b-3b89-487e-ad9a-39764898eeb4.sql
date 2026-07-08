ALTER TABLE public.feedback_request
  ADD COLUMN IF NOT EXISTS delivery_status text DEFAULT 'pending';

ALTER TABLE public.feedback_request
  ADD COLUMN IF NOT EXISTS delivery_error_type text;

ALTER TABLE public.feedback_request
  DROP CONSTRAINT IF EXISTS feedback_request_delivery_status_check;

ALTER TABLE public.feedback_request
  ADD CONSTRAINT feedback_request_delivery_status_check
  CHECK (delivery_status IN (
    'pending',
    'token_generated',
    'sent',
    'delivery_failed',
    'bounced',
    'complained'
  ));

ALTER TABLE public.feedback_request
  DROP CONSTRAINT IF EXISTS feedback_request_delivery_error_type_check;

ALTER TABLE public.feedback_request
  ADD CONSTRAINT feedback_request_delivery_error_type_check
  CHECK (
    delivery_error_type IS NULL OR delivery_error_type IN (
      'resend_auth_error',
      'resend_validation_error',
      'resend_rate_limited',
      'email_send_failed',
      'config_error',
      'missing_recipient_email'
    )
  );

UPDATE public.feedback_request
SET delivery_status = 'sent'
WHERE sent_at IS NOT NULL
  AND delivery_status = 'pending';