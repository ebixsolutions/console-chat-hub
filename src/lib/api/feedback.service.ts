// P3-FB: Feedback Request Scheduling.
// Called from the Inbox after a conversation is resolved. Reads
// feedback_automation_config, then INSERTs one feedback_request row per
// enabled channel (deduped). All access uses the caller's bearer token — RLS
// enforced by policies added in the P3-FB migration. No service_role.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type AuthedSupabase = SupabaseClient<Database>;

// Allowed P3-FB channels. Anything outside this list is reported as a
// per-channel failure (never silently skipped).
const ALLOWED_CHANNELS = ["email", "website_widget"] as const;
type AllowedChannel = (typeof ALLOWED_CHANNELS)[number];

export type ScheduleFeedbackSuccess = {
  ok: true;
  data: {
    created: string[];
    deduped?: string[];
    skipped_reason?: "not_active" | "no_channels";
  };
};

export type ScheduleFeedbackFailure = {
  ok: false;
  error_type: "config_read_failed" | "invalid_feedback_config" | "partial_or_full_scheduling_failure";
  message: string;
  data?: {
    created: string[];
    deduped: string[];
    failed: Array<{ channel: string; error_type: string; message?: string }>;
  };
};

export type ScheduleFeedbackResult = ScheduleFeedbackSuccess | ScheduleFeedbackFailure;

// Internal helper — replicates config.service.ts getFeedbackConfigFn query
// logic without cross-calling it (per spec §5.2).
async function readFeedbackConfig(supabase: AuthedSupabase) {
  const { data, error } = await supabase
    .from("feedback_automation_config")
    .select("id, name, is_active, delay_minutes, trigger_event, config")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    return {
      ok: false as const,
      error_type: "config_read_failed" as const,
      message: error.message,
    };
  }
  return { ok: true as const, data };
}

const inputSchema = z.object({ conversation_id: z.string().uuid() });

export const scheduleFeedbackRequestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(inputSchema)
  .handler(async ({ data, context }): Promise<ScheduleFeedbackResult> => {
    const { conversation_id } = data;

    // 1. Read config
    const cfg = await readFeedbackConfig(context.supabase);
    if (!cfg.ok) {
      return {
        ok: false,
        error_type: "config_read_failed",
        message: cfg.message,
      };
    }
    const row = cfg.data;

    // 2. Config not active / wrong trigger → normal skip
    if (!row || !row.is_active || row.trigger_event !== "conversation_resolved") {
      return {
        ok: true,
        data: { created: [], skipped_reason: "not_active" },
      };
    }

    // 3. Extract channels_enabled (defensive)
    const cfgJson = (row.config ?? {}) as Record<string, unknown>;
    const channelsRaw = cfgJson.channels_enabled;
    if (!Array.isArray(channelsRaw)) {
      return {
        ok: false,
        error_type: "invalid_feedback_config",
        message: "channels_enabled must be an array",
      };
    }
    if (channelsRaw.length === 0) {
      return {
        ok: true,
        data: { created: [], skipped_reason: "no_channels" },
      };
    }

    // 4. Validate channels
    const channels = channelsRaw.map((c) => String(c));
    const scheduledAt = new Date(Date.now() + (row.delay_minutes ?? 1440) * 60_000).toISOString();
    const ratingType = typeof cfgJson.rating_type === "string" ? (cfgJson.rating_type as string) : "stars_1_5";

    const created: string[] = [];
    const deduped: string[] = [];
    const failed: Array<{
      channel: string;
      error_type: string;
      message?: string;
    }> = [];

    for (const channel of channels) {
      if (!(ALLOWED_CHANNELS as readonly string[]).includes(channel)) {
        failed.push({
          channel,
          error_type: "unsupported_feedback_channel",
          message: `Channel '${channel}' is not supported in P3-FB`,
        });
        continue;
      }

      // 6a. Dedupe check
      const { data: existing, error: selErr } = await context.supabase
        .from("feedback_request")
        .select("id")
        .eq("conversation_id", conversation_id)
        .eq("channel", channel as AllowedChannel)
        .eq("status", "pending")
        .limit(1)
        .maybeSingle();
      if (selErr) {
        failed.push({
          channel,
          error_type: "dedupe_select_failed",
          message: selErr.message,
        });
        continue;
      }
      if (existing) {
        deduped.push(channel);
        continue;
      }

      // 6b. Insert
      const { error: insErr } = await context.supabase
        .from("feedback_request")
        .insert({
          conversation_id,
          channel,
          status: "pending",
          scheduled_at: scheduledAt,
          rating_type: ratingType,
          config_version_id: row.id,
        } as never)
        .select("id")
        .single();
      if (insErr) {
        failed.push({
          channel,
          error_type: "insert_failed",
          message: insErr.message,
        });
        continue;
      }
      created.push(channel);
    }

    if (failed.length > 0) {
      return {
        ok: false,
        error_type: "partial_or_full_scheduling_failure",
        message: `${failed.length} of ${channels.length} channels failed`,
        data: { created, deduped, failed },
      };
    }

    return { ok: true, data: { created, deduped } };
  });

// ---------------------------------------------------------------------------
// P4-FB-A0: Record Feedback Response
// Protected server function. Validates input, ensures the target
// feedback_request is 'pending', then UPDATEs it to 'responded' with the
// caller-supplied rating + optional feedback_text. RLS enforced (admin-only
// UPDATE per current policies). No service_role.
//
// P4-FB-A0.1 fix: All validation is done inside the handler to guarantee
// structured { ok:false, error_type:"validation_failed", message } responses.
// The inputValidator is permissive (accepts unknown) so zod never throws
// before the handler runs.
// ---------------------------------------------------------------------------

export type RecordFeedbackResponseSuccess = {
  ok: true;
  data: {
    id: string;
    conversation_id: string;
    rating: number | null;
    feedback_text: string | null;
    responded_at: string | null;
    status: string | null;
    updated_at: string;
  };
};

export type RecordFeedbackResponseFailure = {
  ok: false;
  error_type: "validation_failed" | "select_failed" | "request_not_found" | "request_not_pending" | "update_failed";
  message: string;
};

export type RecordFeedbackResponseResult = RecordFeedbackResponseSuccess | RecordFeedbackResponseFailure;

const recordInputSchema = z.object({
  feedback_request_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  feedback_text: z.string().optional(),
});

export const recordFeedbackResponseFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => input as z.infer<typeof recordInputSchema>)
  .handler(async ({ data, context }): Promise<RecordFeedbackResponseResult> => {
    // P4-FB-A0.1: Validate inside handler for structured error responses.
    const parsed = recordInputSchema.safeParse(data);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return {
        ok: false,
        error_type: "validation_failed",
        message: firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid input",
      };
    }

    const { feedback_request_id, rating } = parsed.data;

    // Normalize feedback_text
    let feedbackText: string | null = null;
    if (typeof parsed.data.feedback_text === "string") {
      const trimmed = parsed.data.feedback_text.trim();
      if (trimmed.length > 0) {
        if (trimmed.length > 2000) {
          return {
            ok: false,
            error_type: "validation_failed",
            message: "feedback_text exceeds 2000 characters",
          };
        }
        feedbackText = trimmed;
      }
    }

    // 1. SELECT existing row
    const { data: existing, error: selErr } = await context.supabase
      .from("feedback_request")
      .select("id, status")
      .eq("id", feedback_request_id)
      .maybeSingle();
    if (selErr) {
      return { ok: false, error_type: "select_failed", message: selErr.message };
    }
    if (!existing) {
      return { ok: false, error_type: "request_not_found", message: "No feedback request found with this ID" };
    }
    if (existing.status !== "pending") {
      return { ok: false, error_type: "request_not_pending", message: `Current status: ${existing.status}` };
    }

    // 2. UPDATE
    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await context.supabase
      .from("feedback_request")
      .update({
        rating,
        feedback_text: feedbackText,
        responded_at: nowIso,
        status: "responded",
        updated_at: nowIso,
      })
      .eq("id", feedback_request_id)
      .select("id, conversation_id, rating, feedback_text, responded_at, status, updated_at")
      .single();
    if (updErr || !updated) {
      return { ok: false, error_type: "update_failed", message: updErr?.message ?? "Update returned no row" };
    }

    return {
      ok: true,
      data: {
        id: updated.id,
        conversation_id: updated.conversation_id,
        rating: updated.rating,
        feedback_text: updated.feedback_text,
        responded_at: updated.responded_at,
        status: updated.status,
        updated_at: updated.updated_at,
      },
    };
  });

// ---------------------------------------------------------------------------
// P5-S3a: Generate Feedback Token (Admin Manual Test)
// Generates a 256-bit crypto-random token, stores SHA-256 hash + expiry on
// feedback_request. Returns raw token only inside a feedback_link URL, once.
// Raw token is NEVER stored in DB, NEVER logged.
//
// SECURITY: This function relies on existing feedback_request UPDATE RLS.
// Only admin should be able to update token columns. Non-admin direct calls
// must fail at RLS/update layer. Do not introduce new role hook or profile
// lookup — RLS enforcement is sufficient.
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRawToken(): string {
  const bytes = new Uint8Array(32); // 256 bits
  crypto.getRandomValues(bytes);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const TOKEN_EXPIRY_DAYS = 7;

// S3a test-only base URL. Must be replaced by configured public app base URL
// before S1/S2/P5 production deployment.
const FEEDBACK_BASE_URL = "https://console-chat-hub.lovable.app";

export type GenerateTokenSuccess = {
  ok: true;
  data: {
    feedback_request_id: string;
    feedback_link: string;
    token_expires_at: string;
    previous_token_invalidated: boolean;
  };
};

export type GenerateTokenFailure = {
  ok: false;
  error_type:
    | "validation_failed"
    | "request_not_found"
    | "request_not_pending"
    | "token_already_active"
    | "token_already_used"
    | "token_update_failed"
    | "internal_error";
  message: string;
};

export type GenerateTokenResult = GenerateTokenSuccess | GenerateTokenFailure;

const generateTokenInput = z.object({
  feedback_request_id: z.string().uuid(),
  force_regenerate: z.boolean().optional(),
});

export const generateFeedbackTokenFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => input as z.infer<typeof generateTokenInput>)
  .handler(async ({ data, context }): Promise<GenerateTokenResult> => {
    // Validate inside handler for structured errors
    const parsed = generateTokenInput.safeParse(data);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        error_type: "validation_failed",
        message: issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid input",
      };
    }

    const { feedback_request_id, force_regenerate } = parsed.data;

    // 1. SELECT existing row
    const { data: row, error: selErr } = await context.supabase
      .from("feedback_request")
      .select("id, status, response_token_hash, token_expires_at, token_used_at")
      .eq("id", feedback_request_id)
      .maybeSingle();

    if (selErr) {
      return { ok: false, error_type: "internal_error", message: selErr.message };
    }
    if (!row) {
      return { ok: false, error_type: "request_not_found", message: "No feedback request found with this ID" };
    }
    if (row.status !== "pending") {
      return { ok: false, error_type: "request_not_pending", message: `Current status: ${row.status}` };
    }
    if (row.token_used_at) {
      return { ok: false, error_type: "token_already_used", message: "Token was already used for a response" };
    }

    // 2. Check for active token
    const hasActiveToken =
      row.response_token_hash && row.token_expires_at && new Date(row.token_expires_at) > new Date();

    if (hasActiveToken && !force_regenerate) {
      return {
        ok: false,
        error_type: "token_already_active",
        message: `Active token exists (expires ${row.token_expires_at}). Use force_regenerate to invalidate and create new token.`,
      };
    }

    const previousTokenInvalidated = !!hasActiveToken && !!force_regenerate;

    // 3. Generate token — SECURITY: rawToken must not be logged or stored
    const rawToken = generateRawToken();
    const tokenHash = await sha256Hex(rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // 4. UPDATE — guarded: re-check status + token_used_at to prevent race condition
    // Store hash only, never raw token
    const { data: updatedRow, error: updErr } = await context.supabase
      .from("feedback_request")
      .update({
        response_token_hash: tokenHash,
        token_created_at: now.toISOString(),
        token_expires_at: expiresAt.toISOString(),
        token_used_at: null,
        updated_at: now.toISOString(),
      } as never)
      .eq("id", feedback_request_id)
      .eq("status", "pending")
      .is("token_used_at", null)
      .select("id")
      .maybeSingle();

    if (updErr) {
      return { ok: false, error_type: "token_update_failed", message: updErr.message };
    }
    if (!updatedRow) {
      return { ok: false, error_type: "token_update_failed", message: "Token update failed or request state changed" };
    }

    // 5. Construct feedback link with raw token
    // SECURITY: rawToken leaves server only inside this response, once
    // S3a test-only. Must be replaced by configured public app base URL
    // before S1/S2/P5 production.
    const feedbackLink = `${FEEDBACK_BASE_URL}/feedback?token=${encodeURIComponent(rawToken)}`;

    return {
      ok: true,
      data: {
        feedback_request_id,
        feedback_link: feedbackLink,
        token_expires_at: expiresAt.toISOString(),
        previous_token_invalidated: previousTokenInvalidated,
      },
    };
  });

export const feedbackService = {
  scheduleFeedbackRequest: (conversation_id: string) => scheduleFeedbackRequestFn({ data: { conversation_id } }),
  recordFeedbackResponse: (params: { feedback_request_id: string; rating: number; feedback_text?: string }) =>
    recordFeedbackResponseFn({ data: params }),
  generateFeedbackToken: (params: { feedback_request_id: string; force_regenerate?: boolean }) =>
    generateFeedbackTokenFn({ data: params }),
};
