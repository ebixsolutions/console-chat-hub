// ============================================================================
// AI Chatbot Settings — UI-facing adapter.
// P2: reads/writes go through src/lib/api/config.service.ts server functions.
// NO direct supabase.from()/.rpc() calls here. Mock is fallback only.
// ============================================================================

import {
  mockChannelConfigs,
  mockFeedbackAutomationConfig,
  mockFeedbackRequests,
  type ChannelConfig,
  type ChannelType,
  type FeedbackAutomationConfig,
  type FeedbackRequest,
  type RatingType,
} from "@/mock/aiChatbotSettingsMock";
import { configService, type LiveChannelConfigRow, type LiveFeedbackConfigRow } from "@/lib/api/config.service";

// Result envelope that pages can use to render backend/fallback badges.
export interface LoadResult<T> {
  data: T;
  source: "live" | "mock_fallback";
  error?: string;
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
        status: "mock_preview",
        is_active: !!row.is_active,
        phase: "Phase 1 Mock",
        recall_supported: true,
        recall_time_limit_minutes: 10,
        notes: "Mock mode — no real messages received",
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
    channels_enabled: (cfg.channels_enabled as string[] | undefined) ?? mockFeedbackAutomationConfig.channels_enabled,
    rating_type: (cfg.rating_type as RatingType | undefined) ?? mockFeedbackAutomationConfig.rating_type,
    message_template_zh:
      (cfg.message_template_zh as string | undefined) ?? mockFeedbackAutomationConfig.message_template_zh,
    message_template_en:
      (cfg.message_template_en as string | undefined) ?? mockFeedbackAutomationConfig.message_template_en,
    skip_if_negative_sentiment:
      (cfg.skip_if_negative_sentiment as boolean | undefined) ??
      mockFeedbackAutomationConfig.skip_if_negative_sentiment,
    updated_by: (cfg.updated_by as string | undefined) ?? "System",
    updated_at: (cfg.updated_at as string | undefined) ?? mockFeedbackAutomationConfig.updated_at,
    message_templates: (cfg.message_templates as Record<string, unknown> | undefined)
      ? (cfg.message_templates as FeedbackAutomationConfig["message_templates"])
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Public API (same signatures as before, now backend-first).
// ---------------------------------------------------------------------------

export const aiChatbotSettingsService = {
  async getChannelConfigs(): Promise<ChannelConfig[]> {
    const result = await this.loadChannelConfigs();
    return result.data;
  },

  async loadChannelConfigs(): Promise<LoadResult<ChannelConfig[]>> {
    try {
      const res = await configService.listChannelConfigs();
      if (!res.ok || !res.data) {
        return { data: mockChannelConfigs, source: "mock_fallback", error: res.error };
      }
      const derived = res.data.map(deriveChannel);
      // Ensure the 3 Phase-3 rows always appear even if backend only has web widget.
      const seenTypes = new Set(derived.map((c) => c.channel_type));
      const filler = mockChannelConfigs.filter((m) => !seenTypes.has(m.channel_type));
      return { data: [...derived, ...filler], source: "live" };
    } catch (e) {
      return {
        data: mockChannelConfigs,
        source: "mock_fallback",
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
    return result.data;
  },

  async loadFeedbackAutomationConfig(): Promise<LoadResult<FeedbackAutomationConfig>> {
    try {
      const res = await configService.getFeedbackConfig();
      if (!res.ok) {
        return {
          data: mockFeedbackAutomationConfig,
          source: "mock_fallback",
          error: res.error,
        };
      }
      if (!res.data) {
        // No row yet — surface defaults; first save will seed the row.
        return { data: mockFeedbackAutomationConfig, source: "live" };
      }
      return { data: mapFeedbackRow(res.data), source: "live" };
    } catch (e) {
      return {
        data: mockFeedbackAutomationConfig,
        source: "mock_fallback",
        error: (e as Error).message,
      };
    }
  },

  async getFeedbackRequests(): Promise<FeedbackRequest[]> {
    // P2: Recent Requests remains mock (Mary Lee).
    return mockFeedbackRequests;
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

export type { ChannelConfig, FeedbackAutomationConfig, FeedbackRequest } from "@/mock/aiChatbotSettingsMock";
