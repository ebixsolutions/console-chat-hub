import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";

const CONTRACT = "HF2_FEEDBACK_RESPONSE_V1";

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const TOKEN_RE = /^[A-Za-z0-9_-]{1,100}$/;
const FORBIDDEN_KEYS = [
  "feedback_request_id",
  "conversation_id",
  "visitor_session_id",
  "session_token",
  "customer_name",
  "customer_email",
  "customer_phone",
  "channel",
  "email",
  "phone",
  "name",
  "customer_ref",
  "company_id",
  "config_version_id",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST")
    return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ success: false, error: "invalid_request" }, 400);
    }

    for (const key of FORBIDDEN_KEYS) {
      if (key in body) {
        return json({ success: false, error: "invalid_request" }, 400);
      }
    }

    const { token, rating, feedback_text } = body as {
      token?: unknown;
      rating?: unknown;
      feedback_text?: unknown;
    };

    if (typeof token !== "string" || !TOKEN_RE.test(token)) {
      return json({ success: false, error: "invalid_request" }, 400);
    }

    // The transaction validates the exact range against the persisted rating_type.
    // 0..10 is the bounded superset needed by NPS/CES/stars/thumbs.
    if (
      typeof rating !== "number" ||
      !Number.isInteger(rating) ||
      rating < 0 ||
      rating > 10
    ) {
      return json({ success: false, error: "invalid_request" }, 400);
    }

    let processedText: string | null = null;
    if (feedback_text !== undefined && feedback_text !== null) {
      if (typeof feedback_text !== "string") {
        return json({ success: false, error: "invalid_request" }, 400);
      }
      const trimmed = feedback_text.trim();
      if (trimmed.length > 2000) {
        return json({ success: false, error: "invalid_request" }, 400);
      }
      if (trimmed.length > 0) processedText = trimmed;
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
    if (!supabaseUrl || !serviceRole) {
      return json({ success: false, error: "database_not_configured" }, 503);
    }

    const tokenHash = await sha256Hex(token);
    const supabase = createClient(supabaseUrl, serviceRole);
    const { data, error } = await supabase.rpc("submit_feedback_response_tx", {
      p_token_hash: tokenHash,
      p_rating: rating,
      p_feedback_text: processedText,
    });

    if (error) {
      console.error("[submit-feedback-response] tx failed", error.code);
      return json({ success: false, error: "internal_error" }, 500);
    }

    const result = String(data?.result ?? data ?? "unknown");
    if (result === "success") {
      return json({
        success: true,
        contract_version: CONTRACT,
        message: "Thank you for your feedback.",
      });
    }
    if (result === "invalid_rating") {
      return json({ success: false, error: "invalid_rating" }, 400);
    }
    if (result === "invalid_or_expired_token") {
      return json({ success: false, error: "invalid_or_expired_token" }, 404);
    }

    return json({ success: false, error: "internal_error" }, 500);
  } catch {
    return json({ success: false, error: "internal_error" }, 500);
  }
});
