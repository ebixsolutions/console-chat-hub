// ============================================================================
// AI Chatbot Settings — UI-facing adapter.
// P2: reads/writes go through src/lib/api/config.service.ts server functions.
// NO direct supabase.from()/.rpc() calls here. Mock is fallback only.
// ============================================================================

import {
  type ChannelType,
  type FeedbackAutomationConfig,
  type RatingType,
} from "@/mock/aiChatbotSettingsMock";
import { supabase } from "@/integrations/supabase/client";
import { configService, type LiveChannelConfigRow, type LiveFeedbackConfigRow } from "@/lib/api/config.service";

// Result envelope that pages can use to render backend/fallback badges.
export interface LoadResult<T> {
  data: T | null;
  source: "live" | "unconfigured" | "error";
  error?: string;
}

export interface ChannelConfig {
  id: string;
  company_id: string | null;
  channel_type: ChannelType;
  channel_name: string;
  status: "live" | "coming_soon";
  is_active: boolean;
  phase: string;
  recall_supported: boolean;
  recall_time_limit_minutes: number;
  notes: string;
}

export interface FeedbackRequest {
  id: string;
  conversation_id: string;
  channel_sent: string;
  request_status: string;
  delivery_status: string;
  scheduled_at: string | null;
}

// ---------------------------------------------------------------------------
// Channel derivation (display-only fields — never persisted).
// ---------------------------------------------------------------------------

function deriveChannel(row: LiveChannelConfigRow): ChannelConfig {
  const rawType = row.channel_type;
  // Normalise legacy 'web_widget' → 'website_widget' for UI mapping.
  const type: ChannelType =
    rawType === "web_widget" || rawType === "website_widget" ? "website_widget" : (rawType as ChannelType);

  switch (type) {
    case "website_widget":
      return {
        id: row.id,
        company_id: row.company_id,
        channel_type: "website_widget",
        channel_name: row.name || "Website Live Chat",
        status: "live",
        is_active: !!row.is_active,
        phase: "Production",
        recall_supported: true,
        recall_time_limit_minutes: 10,
        notes: "Website widget channel",
      };
    case "whatsapp":
      return {
        id: row.id,
        company_id: row.company_id,
        channel_type: "whatsapp",
        channel_name: row.name || "WhatsApp Business",
        status: "coming_soon",
        is_active: !!row.is_active,
        phase: "Phase 3",
        recall_supported: false,
        recall_time_limit_minutes: 0,
        notes: "WhatsApp does not guarantee message recall",
      };
    case "email":
      return {
        id: row.id,
        company_id: row.company_id,
        channel_type: "email",
        channel_name: row.name || "Email Support",
        status: "coming_soon",
        is_active: !!row.is_active,
        phase: "Phase 3",
        recall_supported: false,
        recall_time_limit_minutes: 0,
        notes: "Email cannot be truly recalled — correction message only",
      };
    case "line":
      return {
        id: row.id,
        company_id: row.company_id,
        channel_type: "line",
        channel_name: row.name || "LINE Official",
        status: "coming_soon",
        is_active: !!row.is_active,
        phase: "Phase 3",
        recall_supported: false,
        recall_time_limit_minutes: 0,
        notes: "LINE does not guarantee message recall",
      };
    default:
      return {
        id: row.id,
        company_id: row.company_id,
        channel_type: "website_widget",
        channel_name: row.name || rawType,
        status: "coming_soon",
        is_active: !!row.is_active,
        phase: "Phase 3",
        recall_supported: false,
        recall_time_limit_minutes: 0,
        notes: "",
      };
  }
}

// ---------------------------------------------------------------------------
// Feedback mapping
// ---------------------------------------------------------------------------

function daysFromMinutes(m: number | null | undefined): 1 | 3 | 7 {
  const d = Math.round((m ?? 1440) / 1440);
  if (d <= 1) return 1;
  if (d <= 3) return 3;
  return 7;
}

function mapFeedbackRow(row: LiveFeedbackConfigRow): FeedbackAutomationConfig {
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  return {
    is_enabled: !!row.is_active,
    send_after_days: daysFromMinutes(row.delay_minutes),
    channels_enabled: Array.isArray(cfg.channels_enabled)
      ? (cfg.channels_enabled as string[])
      : ["website_widget"],
    rating_type: (cfg.rating_type as RatingType | undefined) ?? "stars_1_5",
    message_template_zh:
      (cfg.message_template_zh as string | undefined) ?? "",
    message_template_en:
      (cfg.message_template_en as string | undefined) ?? "",
    skip_if_negative_sentiment:
      (cfg.skip_if_negative_sentiment as boolean | undefined) ??
      false,
    updated_by: (cfg.updated_by as string | undefined) ?? "System",
    updated_at: (cfg.updated_at as string | undefined) ?? "",
    message_templates: (cfg.message_templates as Record<string, unknown> | undefined)
      ? (cfg.message_templates as FeedbackAutomationConfig["message_templates"])
      : undefined,
  };
}

const UNCONFIGURED_FEEDBACK_DEFAULTS: FeedbackAutomationConfig = {
  is_enabled: false,
  send_after_days: 1,
  channels_enabled: ["website_widget"],
  rating_type: "stars_1_5",
  message_template_zh: "",
  message_template_en: "",
  skip_if_negative_sentiment: false,
  updated_by: "",
  updated_at: "",
};

// ---------------------------------------------------------------------------
// Public API (same signatures as before, now backend-first).
// ---------------------------------------------------------------------------

export const aiChatbotSettingsService = {
  async getChannelConfigs(): Promise<ChannelConfig[]> {
    const result = await this.loadChannelConfigs();
    return result.data ?? [];
  },

  async loadChannelConfigs(): Promise<LoadResult<ChannelConfig[]>> {
    try {
      const res = await configService.listChannelConfigs();
      if (!res.ok || !res.data) {
        return { data: null, source: "error", error: res.error ?? "channel_load_failed" };
      }
      return { data: res.data.map(deriveChannel), source: "live" };
    } catch (e) {
      return {
        data: null,
        source: "error",
        error: (e as Error).message,
      };
    }
  },

  async bindChannelToCurrentCompany(
    channelId: string,
  ): Promise<{ ok: true; company_id: string } | { ok: false; error: string }> {
    try {
      const res = await configService.bindChannelToCurrentCompany(channelId);
      if (!res.ok || !res.data?.company_id) {
        return { ok: false, error: res.error ?? "Channel company binding failed" };
      }
      return { ok: true, company_id: String(res.data.company_id) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async getFeedbackAutomationConfig(): Promise<FeedbackAutomationConfig> {
    const result = await this.loadFeedbackAutomationConfig();
    return result.data ?? { ...UNCONFIGURED_FEEDBACK_DEFAULTS };
  },

  async loadFeedbackAutomationConfig(): Promise<LoadResult<FeedbackAutomationConfig>> {
    try {
      const res = await configService.getFeedbackConfig();
      if (!res.ok) {
        return {
          data: null,
          source: "error",
          error: res.error ?? "feedback_config_load_failed",
        };
      }
      if (!res.data) {
        return {
          data: { ...UNCONFIGURED_FEEDBACK_DEFAULTS },
          source: "unconfigured",
        };
      }
      return { data: mapFeedbackRow(res.data), source: "live" };
    } catch (e) {
      return {
        data: null,
        source: "error",
        error: (e as Error).message,
      };
    }
  },

  async loadFeedbackRequests(): Promise<LoadResult<FeedbackRequest[]>> {
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser();
      const userId = authData.user?.id;
      if (authError || !userId) {
        return { data: null, source: "error", error: "unauthorized" };
      }

      const { data: memberships, error: membershipError } = await supabase
        .from("company_membership")
        .select("company_id")
        .eq("user_id", userId)
        .eq("is_active", true);
      if (membershipError) {
        return { data: null, source: "error", error: "company_membership_lookup_failed" };
      }

      const companyIds = [
        ...new Set((memberships ?? []).map((m) => String(m.company_id))),
      ];
      if (companyIds.length === 0) {
        return { data: null, source: "error", error: "company_membership_unresolved" };
      }
      if (companyIds.length !== 1) {
        return { data: null, source: "error", error: "company_membership_ambiguous" };
      }

      const { data: conversations, error: conversationError } = await supabase
        .from("conversations")
        .select("id")
        .eq("company_id", companyIds[0]);
      if (conversationError) {
        return { data: null, source: "error", error: "conversation_scope_failed" };
      }

      const conversationIds = (conversations ?? []).map((c) => String(c.id));
      if (conversationIds.length === 0) {
        return { data: [], source: "live" };
      }

      const { data: rows, error: requestError } = await supabase
        .from("feedback_request")
        .select("id, conversation_id, channel, status, delivery_status, scheduled_at")
        .in("conversation_id", conversationIds)
        .order("created_at", { ascending: false })
        .limit(20);
      if (requestError) {
        return { data: null, source: "error", error: "feedback_request_load_failed" };
      }

      return {
        data: (rows ?? []).map((row) => ({
          id: String(row.id),
          conversation_id: String(row.conversation_id),
          channel_sent: String(row.channel),
          request_status: String(row.status),
          delivery_status: String(row.delivery_status ?? "pending"),
          scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
        })),
        source: "live",
      };
    } catch (e) {
      return { data: null, source: "error", error: (e as Error).message };
    }
  },

  async getFeedbackRequests(): Promise<FeedbackRequest[]> {
    const result = await this.loadFeedbackRequests();
    return result.data ?? [];
  },

  async saveFeedbackAutomationConfig(
    config: FeedbackAutomationConfig,
  ): Promise<{ ok: true; data: FeedbackAutomationConfig } | { ok: false; error: string }> {
    const delayMinutes = config.send_after_days * 1440;
    const cfgJson: Record<string, unknown> = {
      channels_enabled: config.channels_enabled,
      rating_type: config.rating_type,
      message_template_zh: config.message_template_zh,
      message_template_en: config.message_template_en,
      skip_if_negative_sentiment: config.skip_if_negative_sentiment,
      updated_by: config.updated_by,
      updated_at: new Date().toISOString(),
      message_templates: config.message_templates ?? undefined,
    };
    try {
      const res = await configService.updateFeedbackConfig({
        is_active: config.is_enabled,
        delay_minutes: delayMinutes,
        config: cfgJson,
      });
      if (!res.ok || !res.data) return { ok: false, error: res.error ?? "Save failed" };
      return { ok: true, data: mapFeedbackRow(res.data as LiveFeedbackConfigRow) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};

export type { FeedbackAutomationConfig } from "@/mock/aiChatbotSettingsMock";
