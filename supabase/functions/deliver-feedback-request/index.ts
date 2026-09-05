import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";

const CONTRACT = "PR7_FEEDBACK_DELIVERY_V1";
const TOKEN_TTL_DAYS = 7;
const MAX_BATCH = 20;
const DELIVERY_TOKEN_RE = /^[A-Fa-f0-9]{64}$/;

function generateRawToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function feedbackBaseUrl(): string | null {
  const raw = Deno.env.get("PUBLIC_APP_BASE_URL")?.trim() ?? "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  const actual = req.headers.get("X-Feedback-Delivery-Token")?.trim() ?? "";
  if (!DELIVERY_TOKEN_RE.test(actual)) {
    return json({ success: false, error: "unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  let serviceRole = "";
  try {
    serviceRole = getSupabaseAdminKey();
  } catch {
    return json({ success: false, error: "database_not_configured" }, 503);
  }
  if (!supabaseUrl || !serviceRole) {
    return json({ success: false, error: "database_not_configured" }, 503);
  }

  const admin = createClient(supabaseUrl, serviceRole);
  const deliveryTokenHash = await sha256Hex(actual);
  const { data: authorized, error: authError } = await admin.rpc(
    "authorize_feedback_delivery_tx",
    { p_token_hash: deliveryTokenHash },
  );
  if (authError || authorized !== true) {
    return json({ success: false, error: "unauthorized" }, 401);
  }

  const baseUrl = feedbackBaseUrl();
  if (!baseUrl) return json({ success: false, error: "public_app_base_url_not_configured" }, 503);

  const summary = { processed: 0, delivered: 0, skipped: 0, failed: 0 };

  for (let i = 0; i < MAX_BATCH; i++) {
    const { data: claim, error: claimError } = await admin.rpc("claim_feedback_delivery_tx", {});
    if (claimError) {
      console.error("[deliver-feedback-request] claim failed", claimError.code);
      return json({ success: false, error: "claim_failed", ...summary }, 500);
    }

    const row = claim as Record<string, unknown> | null;
    const result = String(row?.result ?? "none");
    if (result === "none") break;
    if (result !== "claimed") {
      summary.failed++;
      break;
    }

    summary.processed++;
    const feedbackRequestId = String(row?.feedback_request_id ?? "");
    const conversationId = String(row?.conversation_id ?? "");
    const companyId = String(row?.company_id ?? "");
    const channel = String(row?.channel ?? "");
    const ratingType = String(row?.rating_type ?? "stars_1_5");

    if (!feedbackRequestId || !conversationId || !companyId) {
      await admin.rpc("finish_feedback_delivery_tx", {
        p_feedback_request_id: feedbackRequestId,
        p_outcome: "failed",
        p_delivery_error_type: "invalid_claim_scope",
        p_token_hash: null,
        p_token_created_at: null,
        p_token_expires_at: null,
        p_sent_at: null,
      });
      summary.failed++;
      continue;
    }

    if (channel === "email") {
      await admin.rpc("finish_feedback_delivery_tx", {
        p_feedback_request_id: feedbackRequestId,
        p_outcome: "pending",
        p_delivery_error_type: "email_provider_not_configured",
        p_token_hash: null,
        p_token_created_at: null,
        p_token_expires_at: null,
        p_sent_at: null,
      });
      summary.skipped++;
      continue;
    }

    if (channel !== "website_widget") {
      await admin.rpc("finish_feedback_delivery_tx", {
        p_feedback_request_id: feedbackRequestId,
        p_outcome: "failed",
        p_delivery_error_type: "unsupported_feedback_channel",
        p_token_hash: null,
        p_token_created_at: null,
        p_token_expires_at: null,
        p_sent_at: null,
      });
      summary.failed++;
      continue;
    }

    const rawToken = generateRawToken();
    const tokenHash = await sha256Hex(rawToken);
    const now = new Date();
    const expires = new Date(now.getTime() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    const feedbackLink = `${baseUrl}/feedback?token=${encodeURIComponent(rawToken)}`;

    const { data: completed, error: completeError } = await admin.rpc(
      "complete_widget_feedback_delivery_tx",
      {
        p_feedback_request_id: feedbackRequestId,
        p_conversation_id: conversationId,
        p_company_id: companyId,
        p_token_hash: tokenHash,
        p_token_created_at: now.toISOString(),
        p_token_expires_at: expires.toISOString(),
        p_sent_at: now.toISOString(),
        p_feedback_link: feedbackLink,
        p_rating_type: ratingType,
        p_contract_version: CONTRACT,
      },
    );

    if (completeError) {
      console.error("[deliver-feedback-request] atomic completion failed", {
        feedback_request_id: feedbackRequestId,
        code: completeError.code,
      });
      summary.failed++;
      continue;
    }

    const completeResult = String(completed?.result ?? completed ?? "unknown");
    if (completeResult === "success" || completeResult === "already_sent") {
      summary.delivered++;
      continue;
    }

    if (completeResult === "stale_claim" || completeResult === "request_not_pending") {
      summary.skipped++;
      continue;
    }

    console.error("[deliver-feedback-request] unexpected completion result", {
      feedback_request_id: feedbackRequestId,
      result: completeResult,
    });
    summary.failed++;
  }

  return json({ success: true, contract_version: CONTRACT, ...summary });
});
