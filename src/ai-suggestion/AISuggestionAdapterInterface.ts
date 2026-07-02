// Task J: Pure contract definition. No execution logic. Not imported by any production file.
// Source: Inbox 4 Tabs PRD v1.4 §2.3 AI Suggestion Tab
// Safety: AI Suggestions are draft-only. Never auto-send. Human explicit send required.

export interface AISuggestionRequest {
  conversation_id: string;
  recent_messages: Array<{
    role: 'visitor' | 'agent' | 'assistant';
    content: string;
  }>; // 最新 5 條
  kb_context?: Array<{
    title: string;
    content: string;
    score: number;
  }>; // 選填，來自 Knowledge Tab
  coach_prompt_hint?: string; // static fallback tone profile only (ENABLE_COACH_PROMPT_ADAPTER=false)
                              // ⚠️ Before C1-B approval, must NOT use live Coach prompt.
                              // Only static fallback tone profile or empty string allowed.
  language: 'zh-TW' | 'zh-CN' | 'en';
}

export type AISuggestionToneLabel = 'Empathetic' | 'Informative' | 'Escalating' | 'Neutral';

export interface AISuggestionItem {
  id: string;
  content: string; // 建議回覆文本（draft-only，永不自動發送）
  tone_label: AISuggestionToneLabel; // 穩定枚舉，UI tone badge 依此驗收
  confidence_score: number; // 0–1
}

export interface AISuggestionResponse {
  suggestions: AISuggestionItem[];
  error_type?: string; // present when suggestions array is empty due to service error
}
