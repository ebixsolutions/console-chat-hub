-- HF-2 Director takeover: database-native feedback delivery scheduler.
-- The cron job is installed INACTIVE. It is enabled only after production smoke passes.
-- No shared worker secret, Vault decryption, or HTTP callback is required.

CREATE OR REPLACE FUNCTION public.process_feedback_delivery_batch_tx(
  p_max_batch integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_limit integer := LEAST(20, GREATEST(1, COALESCE(p_max_batch, 20)));
  v_i integer;
  v_claim jsonb;
  v_result text;
  v_feedback_request_id uuid;
  v_conversation_id uuid;
  v_company_id uuid;
  v_channel text;
  v_rating_type text;
  v_raw_token text;
  v_token_hash text;
  v_now timestamptz;
  v_expires timestamptz;
  v_base_url text;
  v_feedback_link text;
  v_complete jsonb;
  v_processed integer := 0;
  v_delivered integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
BEGIN
  FOR v_i IN 1..v_limit LOOP
    v_claim := public.claim_feedback_delivery_tx();
    v_result := COALESCE(v_claim->>'result', 'none');
    EXIT WHEN v_result = 'none';

    IF v_result <> 'claimed' THEN
      v_failed := v_failed + 1;
      EXIT;
    END IF;

    v_processed := v_processed + 1;
    v_feedback_request_id := NULLIF(v_claim->>'feedback_request_id', '')::uuid;
    v_conversation_id := NULLIF(v_claim->>'conversation_id', '')::uuid;
    v_company_id := NULLIF(v_claim->>'company_id', '')::uuid;
    v_channel := COALESCE(v_claim->>'channel', '');
    v_rating_type := COALESCE(v_claim->>'rating_type', 'stars_1_5');

    IF v_feedback_request_id IS NULL OR v_conversation_id IS NULL OR v_company_id IS NULL THEN
      PERFORM public.finish_feedback_delivery_tx(
        v_feedback_request_id, 'failed', 'invalid_claim_scope', NULL, NULL, NULL, NULL
      );
      v_failed := v_failed + 1;
      CONTINUE;
    END IF;

    IF v_channel = 'email' THEN
      PERFORM public.finish_feedback_delivery_tx(
        v_feedback_request_id, 'pending', 'email_provider_not_configured', NULL, NULL, NULL, NULL
      );
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF v_channel <> 'website_widget' THEN
      PERFORM public.finish_feedback_delivery_tx(
        v_feedback_request_id, 'failed', 'unsupported_feedback_channel', NULL, NULL, NULL, NULL
      );
      v_failed := v_failed + 1;
      CONTINUE;
    END IF;

    SELECT regexp_replace(o.origin, '/+$', '')
      INTO v_base_url
    FROM public.conversations c
    JOIN public.channel_config cc ON cc.id = c.channel_config_id
    CROSS JOIN LATERAL unnest(cc.allowed_origins) AS o(origin)
    WHERE c.id = v_conversation_id
      AND c.company_id = v_company_id
      AND o.origin ~ '^https://'
    ORDER BY o.origin
    LIMIT 1;

    IF v_base_url IS NULL OR v_base_url = '' THEN
      PERFORM public.finish_feedback_delivery_tx(
        v_feedback_request_id, 'failed', 'config_error', NULL, NULL, NULL, NULL
      );
      v_failed := v_failed + 1;
      CONTINUE;
    END IF;

    v_raw_token := encode(gen_random_bytes(32), 'hex');
    v_token_hash := encode(digest(convert_to(v_raw_token, 'utf8'), 'sha256'), 'hex');
    v_now := now();
    v_expires := v_now + interval '7 days';
    v_feedback_link := v_base_url || '/feedback?token=' || v_raw_token;

    v_complete := public.complete_widget_feedback_delivery_tx(
      v_feedback_request_id,
      v_conversation_id,
      v_company_id,
      v_token_hash,
      v_now,
      v_expires,
      v_now,
      v_feedback_link,
      v_rating_type,
      'HF2_DB_DELIVERY_V1'
    );

    v_result := COALESCE(v_complete->>'result', 'unknown');
    IF v_result IN ('success', 'already_sent') THEN
      v_delivered := v_delivered + 1;
    ELSIF v_result IN ('stale_claim', 'request_not_pending') THEN
      v_skipped := v_skipped + 1;
    ELSE
      v_failed := v_failed + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'result', 'success',
    'contract_version', 'HF2_DB_DELIVERY_V1',
    'processed', v_processed,
    'delivered', v_delivered,
    'skipped', v_skipped,
    'failed', v_failed
  );
END
$function$;

REVOKE ALL ON FUNCTION public.process_feedback_delivery_batch_tx(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_feedback_delivery_batch_tx(integer)
  TO service_role;

DO $block$
DECLARE
  v_job record;
  v_job_id bigint;
BEGIN
  FOR v_job IN
    SELECT jobid FROM cron.job WHERE jobname = 'hf2_feedback_delivery'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  v_job_id := cron.schedule(
    'hf2_feedback_delivery',
    '*/5 * * * *',
    $cron$SELECT public.process_feedback_delivery_batch_tx(20);$cron$
  );

  -- Fail-safe deployment posture: no automatic customer delivery until final gate passes.
  PERFORM cron.alter_job(v_job_id, active => false);
END
$block$;
