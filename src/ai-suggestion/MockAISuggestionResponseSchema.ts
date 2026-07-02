// Task J: Static mock examples for future reference only. Never executed.

export const MOCK_SUGGESTION_SUCCESS_RESPONSE = {
  suggestions: [
    {
      id: "sug-001",
      content: "感謝您提供資料。我會先協助整理目前情況，並確認下一步可行處理方式。",
      tone_label: "Empathetic",
      confidence_score: 0.88,
    },
    {
      id: "sug-002",
      content: "我會根據目前對話內容協助跟進，若需要進一步資料，我會再請您補充。",
      tone_label: "Informative",
      confidence_score: 0.82,
    },
  ],
};

export const MOCK_SUGGESTION_EMPTY_RESPONSE = {
  suggestions: [],
};

export const MOCK_SUGGESTION_ERROR_RESPONSE = {
  suggestions: [],
  error_type: "SUGGESTION_SERVICE_UNAVAILABLE",
};
