-- HF-2 Director takeover: secure delivery scheduler + DB-backed worker authentication.
-- Raw worker token lives only in Supabase Vault. public schema stores SHA-256 only.

CREATE TABLE IF NOT EXISTS public.feedback_delivery_runtime_auth (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  token_hash text NOT NULL CHECK (length(token_hash) = 64),
  vault_secret_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.feedback_delivery_runtime_auth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.feedback_delivery_runtime_auth FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.authorize_feedback_delivery_tx(p_token_hash text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.feedback_delivery_runtime_auth a
    WHERE a.singleton IS TRUE
      AND a.token_hash = p_token_hash
      AND length(p_token_hash) = 64
  );
$function$;

REVOKE ALL ON FUNCTION public.authorize_feedback_delivery_tx(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_feedback_delivery_tx(text) TO service_role;

DO $block$
DECLARE
  v_secret_name text := 'hf2_feedback_delivery_internal_token';
  v_raw text;
  v_hash text;
BEGIN
  SELECT decrypted_secret
    INTO v_raw
  FROM vault.decrypted_secrets
  WHERE name = v_secret_name
  LIMIT 1;

  IF v_raw IS NULL OR btrim(v_raw) = '' THEN
    v_raw := encode(gen_random_bytes(32), 'hex');
    PERFORM vault.create_secret(
      v_raw,
      v_secret_name,
      'HF-2 feedback delivery worker token; raw value must remain Vault-only'
    );
  END IF;

  v_hash := encode(digest(convert_to(v_raw, 'utf8'), 'sha256'), 'hex');

  INSERT INTO public.feedback_delivery_runtime_auth(
    singleton, token_hash, vault_secret_name, updated_at
  ) VALUES (
    true, v_hash, v_secret_name, now()
  )
  ON CONFLICT (singleton) DO UPDATE
    SET token_hash = EXCLUDED.token_hash,
        vault_secret_name = EXCLUDED.vault_secret_name,
        updated_at = now();
END
$block$;

DO $block$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid FROM cron.job WHERE jobname = 'hf2_feedback_delivery'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END
$block$;

SELECT cron.schedule(
  'hf2_feedback_delivery',
  '*/5 * * * *',
  $cron$
    SELECT net.http_post(
      url := 'https://nrfxhqabwblzxoushgnm.supabase.co/functions/v1/deliver-feedback-request',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Feedback-Delivery-Token', (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'hf2_feedback_delivery_internal_token'
          LIMIT 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 15000
    );
  $cron$
);
