import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";

const CONTRACT = "PR7_FEEDBACK_DELIVERY_V1";
const TOKEN_TTL_DAYS = 7;
const MAX_BATCH = 20;

function constantTimeEqual(aText: string, bText: string): boolean {
  const a = new TextEncoder().encode(aText);
  const b = new TextEncoder().encode(bText);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

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

  const expected = Deno.env.get("FEEDBACK_DELIVERY_INTERNAL_TOKEN")?.trim() ?? "";
  const actual = req.headers.get("X-Feedback-Delivery-Token")?.trim() ?? "";
  if (!expected || !actual || !constantTimeEqual(expected, actual)) {
    return json({ success: false, error: "unauthorized" }, 401);
  }

  const baseUrl = feedbackBaseUrl();
  if (!baseUrl) return json({ success: false, error: "public_app_base_url_not_configured" }, 503);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!supabaseUrl || !serviceRole) {
    return json({ success: false, error: "database_not_configured" }, 503);
  }

  const admin = createClient(supabaseUrl, serviceRole);
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

    const { data: message, error: messageError } = await admin
      .from("messages")
      .insert({
        conversation_id: conversationId,
        role: "system",
        content: "How was your support experience?",
        status: "delivered",
        is_recalled: false,
        metadata: {
          feedback_request: true,
          feedback_request_id: feedbackRequestId,
          feedback_link: feedbackLink,
          rating_type: ratingType,
          contract_version: CONTRACT,
        },
      })
      .select("id")
      .single();

    if (messageError || !message) {
      await admin.rpc("finish_feedback_delivery_tx", {
        p_feedback_request_id: feedbackRequestId,
        p_outcome: "pending",
        p_delivery_error_type: "widget_message_insert_failed",
        p_token_hash: null,
        p_token_created_at: null,
        p_token_expires_at: null,
        p_sent_at: null,
      });
      summary.failed++;
      continue;
    }

    const { data: finished, error: finishError } = await admin.rpc(
      "finish_feedback_delivery_tx",
      {
        p_feedback_request_id: feedbackRequestId,
        p_outcome: "sent",
        p_delivery_error_type: null,
        p_token_hash: tokenHash,
        p_token_created_at: now.toISOString(),
        p_token_expires_at: expires.toISOString(),
        p_sent_at: now.toISOString(),
      },
    );

    if (finishError || String(finished?.result ?? finished) !== "success") {
      await admin
        .from("messages")
        .update({
          is_recalled: true,
          status: "failed",
          metadata: {
            feedback_request: true,
            feedback_request_id: feedbackRequestId,
            invalidated: true,
            invalidated_reason: "delivery_state_commit_failed",
          },
        })
        .eq("id", message.id);

      summary.failed++;
      continue;
    }

    summary.delivered++;
  }

  return json({ success: true, contract_version: CONTRACT, ...summary });
});
