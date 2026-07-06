ALTER TABLE public.feedback_request
  ADD COLUMN IF NOT EXISTS response_token_hash text,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS token_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS token_created_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_request_response_token_hash
  ON public.feedback_request (response_token_hash)
  WHERE response_token_hash IS NOT NULL;