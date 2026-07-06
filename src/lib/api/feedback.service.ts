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
  error_type:
    | "config_read_failed"
    | "invalid_feedback_config"
    | "partial_or_full_scheduling_failure";
  message: string;
  data?: {
    created: string[];
    deduped: string[];
    failed: Array<{ channel: string; error_type: string; message?: string }>;
  };
};

export type ScheduleFeedbackResult =
  | ScheduleFeedbackSuccess
  | ScheduleFeedbackFailure;

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
    if (
      !row ||
      !row.is_active ||
      row.trigger_event !== "conversation_resolved"
    ) {
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
    const scheduledAt = new Date(
      Date.now() + (row.delay_minutes ?? 1440) * 60_000,
    ).toISOString();
    const ratingType =
      typeof cfgJson.rating_type === "string"
        ? (cfgJson.rating_type as string)
        : "stars_1_5";

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
  error_type:
    | "validation_failed"
    | "select_failed"
    | "request_not_found"
    | "request_not_pending"
    | "update_failed";
  message: string;
};

export type RecordFeedbackResponseResult =
  | RecordFeedbackResponseSuccess
  | RecordFeedbackResponseFailure;

const recordInputSchema = z.object({
  feedback_request_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  feedback_text: z.string().optional(),
});

export const recordFeedbackResponseFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => recordInputSchema.parse(input))
  .handler(async ({ data, context }): Promise<RecordFeedbackResponseResult> => {
    const { feedback_request_id, rating } = data;

    // Normalize feedback_text: undefined/null/empty-after-trim → null,
    // otherwise trimmed and capped at 2000 chars.
    let feedbackText: string | null = null;
    if (typeof data.feedback_text === "string") {
      const trimmed = data.feedback_text.trim();
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
      return {
        ok: false,
        error_type: "select_failed",
        message: selErr.message,
      };
    }
    if (!existing) {
      return {
        ok: false,
        error_type: "request_not_found",
        message: "No feedback request found with this ID",
      };
    }
    if (existing.status !== "pending") {
      return {
        ok: false,
        error_type: "request_not_pending",
        message: `Current status: ${existing.status}`,
      };
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
      .select(
        "id, conversation_id, rating, feedback_text, responded_at, status, updated_at",
      )
      .single();
    if (updErr || !updated) {
      return {
        ok: false,
        error_type: "update_failed",
        message: updErr?.message ?? "Update returned no row",
      };
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

export const feedbackService = {
  scheduleFeedbackRequest: (conversation_id: string) =>
    scheduleFeedbackRequestFn({ data: { conversation_id } }),
  recordFeedbackResponse: (params: {
    feedback_request_id: string;
    rating: number;
    feedback_text?: string;
  }) => recordFeedbackResponseFn({ data: params }),
};

