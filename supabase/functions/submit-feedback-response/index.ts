import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";

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
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST")
    return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));

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

    if (
      typeof rating !== "number" ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5
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
      if (trimmed.length > 0) {
        processedText = trimmed;
      }
    }

    const tokenHash = await sha256Hex(token);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: row, error: selErr } = await supabase
      .from("feedback_request")
      .select("id, status, token_used_at, token_expires_at")
      .eq("response_token_hash", tokenHash)
      .maybeSingle();

    if (selErr || !row) {
      return json({ success: false, error: "invalid_or_expired_token" }, 404);
    }
    if (row.status !== "pending") {
      return json({ success: false, error: "invalid_or_expired_token" }, 404);
    }
    if (row.token_used_at) {
      return json({ success: false, error: "invalid_or_expired_token" }, 404);
    }
    if (
      !row.token_expires_at ||
      new Date(row.token_expires_at) < new Date()
    ) {
      return json({ success: false, error: "invalid_or_expired_token" }, 404);
    }

    const now = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .from("feedback_request")
      .update({
        rating,
        feedback_text: processedText,
        responded_at: now,
        status: "responded",
        token_used_at: now,
        updated_at: now,
      })
      .eq("response_token_hash", tokenHash)
      .eq("status", "pending")
      .is("token_used_at", null)
      .gte("token_expires_at", now)
      .select("id")
      .maybeSingle();

    if (updErr || !updated) {
      return json({ success: false, error: "invalid_or_expired_token" }, 404);
    }

    return json({ success: true, message: "Thank you for your feedback." });
  } catch {
    return json({ success: false, error: "internal_error" }, 500);
  }
});
