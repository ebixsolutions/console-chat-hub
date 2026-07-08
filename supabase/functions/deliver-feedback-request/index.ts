import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";

// ── Security helpers ────────────────────────────────────────────────────────
async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRawToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***@***";
  return local.slice(0, Math.min(local.length, 1)) + "***@" + domain;
}

// ── Constants ───────────────────────────────────────────────────────────────
const TOKEN_EXPIRY_DAYS = 7;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const ALLOWED_ROLES = ["admin", "supervisor"];

const FORBIDDEN_BODY_KEYS = [
  "recipient_email",
  "conversation_id",
  "visitor_session_id",
  "response_token_hash",
  "token_expires_at",
  "token_used_at",
  "token_created_at",
  "status",
  "rating",
  "feedback_text",
  "sent_at",
];

// ── Email template ──────────────────────────────────────────────────────────
function buildEmailSubject(rating_type: string): string {
  const subjects: Record<string, string> = {
    stars_1_5: "Please rate your recent service experience",
    csat: "How satisfied were you with our service?",
    nps: "Would you recommend us to a friend?",
    thumbs: "Quick feedback on your recent support",
    ces: "How easy was it to resolve your issue?",
  };
  return subjects[rating_type] ?? subjects["stars_1_5"];
}

function buildEmailHtml(feedbackLink: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f7;padding:32px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:32px;border:1px solid #e5e5e5;">
        <tr><td style="font-size:16px;color:#333;line-height:1.6;">
          <p style="margin:0 0 16px;">Hi there,</p>
          <p style="margin:0 0 24px;">Thank you for contacting us! We value your feedback and would love to hear about your experience. Please take a moment to rate our service.</p>
          <p style="text-align:center;margin:0 0 24px;">
            <a href="${feedbackLink}" style="display:inline-block;background:#1a1a1a;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Rate Now</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#888;">This link expires in 7 days.</p>
          <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;">
          <p style="margin:0;font-size:11px;color:#aaa;line-height:1.5;">You received this email because you recently contacted our support team. If you no longer wish to receive these emails, please contact us directly.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Main handler ────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error_type: "method_not_allowed", message: "POST only" }, 405);

  try {
    // ── ENV check ───────────────────────────────────────────────────────
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
    const MAILGUN_DOMAIN = Deno.env.get("MAILGUN_DOMAIN");
    const MAILGUN_REGION = (Deno.env.get("MAILGUN_REGION") || "us").toLowerCase();
    const SENDER_EMAIL = Deno.env.get("FEEDBACK_SENDER_EMAIL");
    const BASE_URL = Deno.env.get("FEEDBACK_BASE_URL");

    // Mailgun region → API base URL (C5: explicit mapping)
    const mailgunBaseUrl = MAILGUN_REGION === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
      return json({ ok: false, error_type: "internal_error", message: "Server configuration error" }, 500);
    }
    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      return json({ ok: false, error_type: "config_error", message: "Email service not configured" }, 500);
    }
    if (!SENDER_EMAIL) {
      return json({ ok: false, error_type: "config_error", message: "Sender email not configured" }, 500);
    }
    if (!BASE_URL || !BASE_URL.startsWith("https://")) {
      return json({ ok: false, error_type: "internal_error", message: "Feedback base URL not configured" }, 500);
    }

    // ── Auth: verify caller identity ────────────────────────────────────
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader) {
      return json({ ok: false, error_type: "unauthorized", message: "Missing authorization" }, 401);
    }

    const supabaseUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userErr,
    } = await supabaseUser.auth.getUser();
    if (userErr || !user) {
      return json({ ok: false, error_type: "unauthorized", message: "Invalid or expired token" }, 401);
    }

    // ── Auth: verify caller role ────────────────────────────────────────
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: roleRows, error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ALLOWED_ROLES)
      .limit(1);

    if (roleErr || !roleRows || roleRows.length === 0) {
      return json({ ok: false, error_type: "forbidden", message: "Insufficient permissions" }, 403);
    }

    // ── Parse and validate body ─────────────────────────────────────────
    const body = await req.json().catch(() => ({}));

    for (const key of FORBIDDEN_BODY_KEYS) {
      if (key in body) {
        return json({ ok: false, error_type: "invalid_request", message: "Request contains forbidden fields" }, 400);
      }
    }

    const { feedback_request_id, force_resend } = body as {
      feedback_request_id?: unknown;
      force_resend?: unknown;
    };

    if (typeof feedback_request_id !== "string" || !UUID_RE.test(feedback_request_id)) {
      return json({ ok: false, error_type: "invalid_request", message: "Valid feedback_request_id required" }, 400);
    }

    if (force_resend !== undefined && force_resend !== null && typeof force_resend !== "boolean") {
      return json({ ok: false, error_type: "invalid_request", message: "force_resend must be boolean" }, 400);
    }
    const forceResend = force_resend === true;

    // ── Read feedback_request ───────────────────────────────────────────
    const { data: row, error: selErr } = await supabaseAdmin
      .from("feedback_request")
      .select(
        "id, status, channel, recipient_email, response_token_hash, token_expires_at, token_used_at, rating_type, sent_at",
      )
      .eq("id", feedback_request_id)
      .maybeSingle();

    if (selErr || !row) {
      return json({ ok: false, error_type: "request_not_found", message: "Feedback request not found" }, 404);
    }

    // ── Pre-send validation ─────────────────────────────────────────────
    if (row.status !== "pending") {
      return json({ ok: false, error_type: "request_not_pending", message: "Status must be 'pending'" }, 400);
    }
    if (row.channel !== "email") {
      return json({ ok: false, error_type: "channel_not_email", message: "Channel must be 'email'" }, 400);
    }
    if (row.token_used_at) {
      return json({ ok: false, error_type: "already_responded", message: "Customer already responded" }, 400);
    }

    // Validate recipient_email from DB
    const recipientEmail = (row.recipient_email ?? "").trim();
    if (recipientEmail.length === 0 || recipientEmail.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(recipientEmail)) {
      // H4: Persist missing/invalid recipient as delivery failure
      const { error: recipientStatusErr } = await supabaseAdmin
        .from("feedback_request")
        .update({
          delivery_status: "delivery_failed",
          delivery_error_type: "missing_recipient_email",
          email_provider: "mailgun",
          updated_at: new Date().toISOString(),
        })
        .eq("id", feedback_request_id);

      if (recipientStatusErr) {
        console.warn(
          "[deliver-feedback-request] Failed to persist delivery_status for missing recipient:",
          recipientStatusErr.message,
        );
      }

      return json(
        { ok: false, error_type: "invalid_recipient_email", message: "Recipient email is missing or invalid" },
        400,
      );
    }

    // ── Resend guard ────────────────────────────────────────────────────
    const hasActiveToken =
      row.response_token_hash && row.token_expires_at && new Date(row.token_expires_at) > new Date();

    if (row.sent_at && hasActiveToken && !forceResend) {
      return json(
        {
          ok: false,
          error_type: "already_sent",
          message: "Email already sent and token still active. Use force_resend=true to resend with new token.",
        },
        400,
      );
    }

    // Compute was_resend before mutations
    const wasResend = Boolean(row.sent_at || forceResend);

    // ── Generate token (P4-FB-B: delivery-time generation) ──────────────
    const rawToken = generateRawToken();
    const tokenHash = await sha256Hex(rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // ── Store token hash (verify exactly 1 row updated) ─────────────────
    const { data: updatedRow, error: tokenErr } = await supabaseAdmin
      .from("feedback_request")
      .update({
        response_token_hash: tokenHash,
        token_created_at: now.toISOString(),
        token_expires_at: expiresAt.toISOString(),
        token_used_at: null,
        updated_at: now.toISOString(),
        delivery_status: "token_generated",
      })
      .eq("id", feedback_request_id)
      .eq("status", "pending")
      .is("token_used_at", null)
      .select("id")
      .maybeSingle();

    if (tokenErr || !updatedRow) {
      return json({ ok: false, error_type: "token_generation_failed", message: "Failed to store token" }, 500);
    }

    // ── Compose email ───────────────────────────────────────────────────
    const feedbackLink = `${BASE_URL}/feedback?token=${encodeURIComponent(rawToken)}`;
    const ratingType = row.rating_type ?? "stars_1_5";
    const subject = buildEmailSubject(ratingType);
    const html = buildEmailHtml(feedbackLink);

    // ── Send via Mailgun ────────────────────────────────────────────────
    const mailgunUrl = `${mailgunBaseUrl}/v3/${MAILGUN_DOMAIN}/messages`;

    const formData = new FormData();
    formData.append("from", SENDER_EMAIL);
    formData.append("to", recipientEmail);
    formData.append("subject", subject);
    formData.append("html", html);
    formData.append("o:tag", "feedback-request");
    formData.append("v:feedback_request_id", feedback_request_id);

    // Mailgun Basic Auth: api:<key> (btoa confirmed available — used in generateRawToken line 15)
    const mailgunAuth = btoa(`api:${MAILGUN_API_KEY}`);

    const emailResponse = await fetch(mailgunUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${mailgunAuth}`,
      },
      body: formData,
    });

    // ── Error handling ──────────────────────────────────────────────────
    if (!emailResponse.ok) {
      const httpStatus = emailResponse.status;

      // B4: Map both 400 and 422 to provider_validation_error
      let errorType = "provider_send_failed";
      if (httpStatus === 401 || httpStatus === 403) {
        errorType = "provider_auth_error";
      } else if (httpStatus === 400 || httpStatus === 422) {
        errorType = "provider_validation_error";
      } else if (httpStatus === 429) {
        errorType = "provider_rate_limited";
      }

      // Provider-neutral hints (C2: resend_hint field name retained, content provider-neutral)
      const hintMap: Record<string, string> = {
        provider_auth_error: "Email provider authentication failed. Check API key configuration.",
        provider_validation_error: "Email provider rejected the request. Check sender address and domain verification.",
        provider_rate_limited: "Email provider rate limit reached. Wait and retry later.",
        provider_send_failed: "Email provider returned an unexpected error. Retry or check provider status.",
      };
      const hint = hintMap[errorType] ?? hintMap["provider_send_failed"];

      console.error("[deliver-feedback-request] Mailgun error:", httpStatus, errorType);

      // H4: Persist delivery failure
      try {
        await supabaseAdmin
          .from("feedback_request")
          .update({
            delivery_status: "delivery_failed",
            delivery_error_type: errorType,
            email_provider: "mailgun",
            updated_at: new Date().toISOString(),
          })
          .eq("id", feedback_request_id);
      } catch (dbErr) {
        console.warn("[deliver-feedback-request] Failed to persist delivery_status:", dbErr);
      }

      return json(
        {
          ok: false,
          error_type: errorType,
          message: "Email delivery failed. Token is stored; you may retry.",
          resend_hint: hint,
        },
        httpStatus === 429 ? 429 : 502,
      );
    }

    // ── Success: parse Mailgun response safely (B3) ─────────────────────
    let providerMessageId: string | null = null;
    try {
      const emailResult = await emailResponse.json();
      // Mailgun success: { id: "<message-id@domain>", message: "Queued. Thank you." }
      providerMessageId = typeof emailResult?.id === "string" ? emailResult.id : null;
    } catch {
      // Non-JSON response — still treat as success since HTTP was 2xx
      console.warn("[deliver-feedback-request] Mailgun returned non-JSON success response");
    }

    // ── Update sent_at + provider tracking ──────────────────────────────
    const { data: sentRow, error: sentErr } = await supabaseAdmin
      .from("feedback_request")
      .update({
        sent_at: now.toISOString(),
        updated_at: now.toISOString(),
        delivery_status: "sent",
        delivery_error_type: null,
        email_provider: "mailgun",
        email_provider_message_id: providerMessageId,
      })
      .eq("id", feedback_request_id)
      .select("id")
      .maybeSingle();

    if (sentErr || !sentRow) {
      console.error("[deliver-feedback-request] sent_at update failed");
      return json(
        {
          ok: false,
          error_type: "email_sent_but_tracking_failed",
          message: "Email may have been sent, but delivery tracking failed. Manual review required.",
        },
        500,
      );
    }

    // ── Success (P5-S5B contract — FROZEN) ──────────────────────────────
    return json({
      ok: true,
      delivered_to_masked: maskEmail(recipientEmail),
      was_resend: wasResend,
    });
  } catch {
    return json({ ok: false, error_type: "internal_error", message: "Unexpected error" }, 500);
  }
});
