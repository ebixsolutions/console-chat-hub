-- P5-S6A: Remove unintended DEFAULT from feedback_request.sent_at
-- This column should only be set explicitly by the deliver-feedback-request Edge Function.
ALTER TABLE public.feedback_request ALTER COLUMN sent_at DROP DEFAULT;