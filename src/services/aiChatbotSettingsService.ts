// ============================================================================
// AI Chatbot Settings — Service Layer
// Contract-only for Phase 1. Backend integration deferred to Phase 2.
// When Phase 2 lands, only this file changes; consumer pages remain untouched.
// ============================================================================

import {
  mockChannelConfigs,
  mockFeedbackAutomationConfig,
  mockFeedbackRequests,
  type ChannelConfig,
  type FeedbackAutomationConfig,
  type FeedbackRequest,
} from '@/mock/aiChatbotSettingsMock';

export const aiChatbotSettingsService = {
  getChannelConfigs: async (): Promise<ChannelConfig[]> => {
    return Promise.resolve(mockChannelConfigs);
  },

  getFeedbackAutomationConfig: async (): Promise<FeedbackAutomationConfig> => {
    return Promise.resolve(mockFeedbackAutomationConfig);
  },

  getFeedbackRequests: async (): Promise<FeedbackRequest[]> => {
    return Promise.resolve(mockFeedbackRequests);
  },

  saveFeedbackAutomationConfig: async (
    _config: FeedbackAutomationConfig
  ): Promise<{ ok: true; mock: true }> => {
    // Phase 1: no persistence. Returns success shape for UI callback only.
    return Promise.resolve({ ok: true as const, mock: true as const });
  },
};

export type {
  ChannelConfig,
  FeedbackAutomationConfig,
  FeedbackRequest,
} from '@/mock/aiChatbotSettingsMock';
