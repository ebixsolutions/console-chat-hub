import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type AuthedSupabase = SupabaseClient<Database>;
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

/**
 * feedback_automation_config is company-unbound (no company_id column): it holds
 * a single pre-canonical automation row. Scope authorization happens on the
 * conversation, not on this read.
 */
async function readFeedbackConfig(supabase: AuthedSupabase) {
  const { data, error } = await supabase
    .from("feedback_automation_config")
    .select("id, name, is_active, delay_minutes, trigger_event, config")
    .eq("trigger_event", "conversation_resolved")
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

const PRE_ACTIVATION_SCHEDULE_ROLES = new Set(["admin", "supervisor", "agent", "qa"]);

const scheduleInput = z.object({ conversation_id: z.string().uuid() });

export const scheduleFeedbackRequestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(scheduleInput)
  .handler(async ({ data, context }): Promise<ScheduleFeedbackResult> => {
    const conversationId = data.conversation_id;
    const userId = String(context.userId);

    const { data: conversation, error: conversationErr } =
      await context.supabase
        .from("conversations")
        .select("id, company_id, channel_config_id")
        .eq("id", conversationId)
        .maybeSingle();

    if (conversationErr) {
      return {
        ok: false,
        error_type: "config_read_failed",
        message: "conversation_lookup_failed",
      };
    }
    if (!conversation) {
      return {
        ok: false,
        error_type: "config_read_failed",
        message: "conversation_not_found",
      };
    }

    let channelCompanyId: string | null = null;
    if (conversation.channel_config_id) {
      const { data: channel, error: channelErr } = await context.supabase
        .from("channel_config")
        .select("company_id")
        .eq("id", conversation.channel_config_id)
        .maybeSingle();
      if (channelErr) {
        return {
          ok: false,
          error_type: "config_read_failed",
          message: "channel_company_lookup_failed",
        };
      }
      channelCompanyId = channel?.company_id ? String(channel.company_id) : null;
    }

    const conversationCompanyId = conversation.company_id
      ? String(conversation.company_id)
      : null;
    if (
      conversationCompanyId &&
      channelCompanyId &&
      conversationCompanyId !== channelCompanyId
    ) {
      return {
        ok: false,
        error_type: "config_read_failed",
        message: "tenant_identity_conflict",
      };
    }

    // Canonical always wins: any resolvable canonical company identity requires
    // canonical active membership and never degrades to pre-activation.
    const resolvedCompanyId = conversationCompanyId ?? channelCompanyId;
    if (resolvedCompanyId) {
      const { data: company, error: companyErr } = await context.supabase
        .from("company")
        .select("id, is_active")
        .eq("id", resolvedCompanyId)
        .maybeSingle();
      if (companyErr || !company || company.is_active !== true) {
        return {
          ok: false,
          error_type: "config_read_failed",
          message: companyErr ? "company_lookup_failed" : "company_inactive",
        };
      }

      const { data: membership, error: membershipErr } =
        await context.supabase
          .from("company_membership")
          .select("id")
          .eq("company_id", resolvedCompanyId)
          .eq("user_id", userId)
          .eq("is_active", true)
          .maybeSingle();

      if (membershipErr || !membership) {
        return {
          ok: false,
          error_type: "config_read_failed",
          message: "company_membership_required",
        };
      }
    } else {
      // Pre-activation: canonical identity is genuinely absent for this
      // null-company conversation. Authenticated authorized role is still
      // required; no company id is fabricated.
      const { data: memberships, error: membershipErr } = await context.supabase
        .from("company_membership")
        .select("company_id, is_active")
        .eq("user_id", userId);
      if (membershipErr) {
        return {
          ok: false,
          error_type: "config_read_failed",
          message: "company_membership_lookup_failed",
        };
      }
      if ((memberships ?? []).length > 0) {
        return {
          ok: false,
          error_type: "config_read_failed",
          message: "company_membership_required",
        };
      }

      const { data: roleRows, error: roleErr } = await context.supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId);
      if (roleErr) {
        return {
          ok: false,
          error_type: "config_read_failed",
          message: "role_lookup_failed",
        };
      }
      const permitted = (roleRows ?? []).some((r: { role: string }) =>
        PRE_ACTIVATION_SCHEDULE_ROLES.has(String(r.role)),
      );
      if (!permitted) {
        return {
          ok: false,
          error_type: "config_read_failed",
          message: "role_not_permitted",
        };
      }
    }


    const cfg = await readFeedbackConfig(context.supabase);
    if (!cfg.ok) {
      return {
        ok: false,
        error_type: "config_read_failed",
        message: cfg.message,
      };
    }

    const row = cfg.data;
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

    const channels = channelsRaw.map(String);
    const scheduledAt = new Date(
      Date.now() + (row.delay_minutes ?? 1440) * 60_000,
    ).toISOString();
    const ratingType =
      typeof cfgJson.rating_type === "string"
        ? cfgJson.rating_type
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
          message: `Channel '${channel}' is not supported`,
        });
        continue;
      }

      const { data: existing, error: selectError } =
        await context.supabase
          .from("feedback_request")
          .select("id")
          .eq("conversation_id", conversationId)
          .eq("channel", channel as AllowedChannel)
          .eq("status", "pending")
          .limit(1)
          .maybeSingle();

      if (selectError) {
        failed.push({
          channel,
          error_type: "dedupe_select_failed",
          message: selectError.message,
        });
        continue;
      }
      if (existing) {
        deduped.push(channel);
        continue;
      }

      const { error: insertError } = await context.supabase
        .from("feedback_request")
        .insert({
          conversation_id: conversationId,
          channel,
          status: "pending",
          scheduled_at: scheduledAt,
          rating_type: ratingType,
          config_version_id: row.id,
        } as never);

      if (insertError) {
        failed.push({
          channel,
          error_type: "insert_failed",
          message: insertError.message,
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

export type FeedbackResponseRow = {
  id: string;
  conversation_id: string;
  channel: string | null;
  status: string | null;
  rating: number | null;
  feedback_text: string | null;
  responded_at: string | null;
  delivery_status: string | null;
  scheduled_at: string | null;
  rating_type: string | null;
  created_at: string;
};

export type FeedbackResponsePage = {
  rows: FeedbackResponseRow[];
  total: number;
};

const listInput = z.object({
  status: z.enum(["pending", "responded"]).optional(),
  delivery_status: z.enum(["pending", "sent", "delivery_failed"]).optional(),
  channel: z.enum(["email", "website_widget"]).optional(),
  rating: z.union([z.number().int().min(1).max(5), z.literal("none")]).optional(),
  conversation_id: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.number().int().min(0).default(0),
  page_size: z.number().int().min(1).max(50).default(20),
});

function nextDayUtc(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export const listFeedbackResponsesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }): Promise<
    | { ok: true; data: FeedbackResponsePage }
    | { ok: false; error: string }
  > => {
    const userId = String(context.userId);

    const { data: memberships, error: membershipError } =
      await context.supabase
        .from("company_membership")
        .select("company_id, role")
        .eq("user_id", userId)
        .eq("is_active", true);

    if (membershipError) {
      return { ok: false, error: "company_membership_lookup_failed" };
    }

    const companyIds = [
      ...new Set((memberships ?? []).map((m) => String(m.company_id))),
    ];
    if (companyIds.length === 0) {
      return { ok: false, error: "company_membership_unresolved" };
    }
    if (companyIds.length !== 1) {
      return { ok: false, error: "company_membership_ambiguous" };
    }

    const roles = new Set((memberships ?? []).map((m) => String(m.role)));
    if (
      !["admin", "supervisor", "agent"].some((role) => roles.has(role))
    ) {
      return { ok: false, error: "forbidden" };
    }

    const companyId = companyIds[0];
    const { data: company, error: companyError } =
      await context.supabase
        .from("company")
        .select("id, is_active")
        .eq("id", companyId)
        .maybeSingle();

    if (companyError) return { ok: false, error: "company_lookup_failed" };
    if (!company || company.is_active !== true) {
      return { ok: false, error: "company_inactive" };
    }

    if (data.from && data.to && data.from > data.to) {
      return { ok: false, error: "invalid_date_range" };
    }

    let query = context.supabase
      .from("feedback_request")
      .select(
        "id, conversation_id, channel, status, rating, feedback_text, responded_at, delivery_status, scheduled_at, rating_type, created_at, conversations!inner(company_id)",
        { count: "exact" },
      )
      .eq("conversations.company_id", companyId);

    if (data.status) query = query.eq("status", data.status);
    if (data.delivery_status) {
      query = query.eq("delivery_status", data.delivery_status);
    }
    if (data.channel) query = query.eq("channel", data.channel);
    if (data.rating === "none") query = query.is("rating", null);
    if (typeof data.rating === "number") query = query.eq("rating", data.rating);
    if (data.conversation_id) {
      query = query.eq("conversation_id", data.conversation_id);
    }
    if (data.from) {
      query = query.gte("created_at", `${data.from}T00:00:00.000Z`);
    }
    if (data.to) query = query.lt("created_at", nextDayUtc(data.to));

    const offset = data.page * data.page_size;
    const { data: rows, error, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + data.page_size - 1);

    if (error) return { ok: false, error: "feedback_response_load_failed" };

    const normalized: FeedbackResponseRow[] = (rows ?? []).map((row: any) => ({
      id: String(row.id),
      conversation_id: String(row.conversation_id),
      channel: row.channel ? String(row.channel) : null,
      status: row.status ? String(row.status) : null,
      rating: typeof row.rating === "number" ? row.rating : null,
      feedback_text:
        typeof row.feedback_text === "string" ? row.feedback_text : null,
      responded_at: row.responded_at ? String(row.responded_at) : null,
      delivery_status: row.delivery_status
        ? String(row.delivery_status)
        : null,
      scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
      rating_type: row.rating_type ? String(row.rating_type) : null,
      created_at: String(row.created_at),
    }));

    return {
      ok: true,
      data: { rows: normalized, total: count ?? 0 },
    };
  });

export const feedbackService = {
  scheduleFeedbackRequest: (conversation_id: string) =>
    scheduleFeedbackRequestFn({ data: { conversation_id } }),
  listFeedbackResponses: (params: z.infer<typeof listInput>) =>
    listFeedbackResponsesFn({ data: params }),
};
