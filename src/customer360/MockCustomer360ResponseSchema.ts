// Task I: Static mock examples for future reference only. Never executed.

export const MOCK_CUSTOMER360_SUCCESS_RESPONSE = {
  context_available: true,
  customer_name_masked: "Ch*** L***",
  tier: "Gold",
  tier_since_year: 2023,
  language_preference: "zh-TW",
  data_freshness_score: 0.92,
  memory_confidence_score: 0.85,
};

export const MOCK_CUSTOMER360_NOT_FOUND_RESPONSE = {
  context_available: false,
  error_type: "CUSTOMER_NOT_FOUND",
};
