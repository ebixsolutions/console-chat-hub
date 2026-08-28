/**
 * Task 3.3 — Customer-facing conversation policy layer.
 *
 * Customers must never see internal machinery wording (knowledge base, RAG,
 * evidence, confidence score, retrieval/provider/routing terms). When
 * information is insufficient the assistant asks ONE natural question or says
 * plainly that it does not have enough confirmed information — it must not offer
 * a human agent merely because a question is incomplete.
 *
 * Pure module: no IO, no env, no DB.
 */

export type CustomerLanguage = "zh-TW" | "zh-CN" | "en";

/** Terms that must never appear in customer-visible text. */
export const FORBIDDEN_INTERNAL_TERMS: readonly string[] = [
  "知識庫",
  "知识库",
  "知識庫沒有足夠資訊",
  "knowledge base",
  "knowledgebase",
  "rag",
  "retrieval",
  "embedding",
  "vector",
  "chunk",
  "full_content",
  "rag_summary",
  "evidence",
  "confidence score",
  "similarity",
  "prompt",
  "provider",
  "routing",
  "escalation rule",
  "llm",
  "gemini",
  "vertex",
  "anthropic",
  "token",
];

export const CUSTOMER_CONVERSATION_POLICY_PROMPT = `Customer conversation policy (mandatory):
- Speak like a warm, competent human support agent in the customer's own language.
- Never mention or hint at internal machinery: no knowledge base, RAG, retrieval, evidence, chunks, similarity or confidence scores, prompts, models, providers, routing, or escalation rules.
- Use only confirmed information for exact facts (prices, dates, limits, procedures, policy conditions). Never guess.
- If the question is incomplete or ambiguous, ask exactly ONE short natural question to get the missing detail. Do not offer a human agent just because the question is incomplete.
- If you genuinely do not have confirmed information, say so naturally, for example "我目前沒有足夠資料確認，所以不想亂答" / "I don't have confirmed information on that yet, so I don't want to guess", and say what you can do next.
- Remember what the customer already told you in this conversation, honour their latest correction, and never re-ask details they already gave.
- Keep replies concise and natural; no internal labels, no bullet dumps of system state.`;

export const NATURAL_INSUFFICIENT_INFO: Record<CustomerLanguage, string> = {
  "zh-TW":
    "我目前沒有足夠資料確認，所以不想亂答。可以再告訴我多一點細節嗎？例如你想處理的項目或目前遇到的情況，我會盡量直接幫你。",
  "zh-CN":
    "我目前没有足够资料确认，所以不想乱答。可以再告诉我多一点细节吗？例如你想处理的项目或目前遇到的情况，我会尽量直接帮你。",
  en:
    "I don't have confirmed information on that yet, so I don't want to guess. Could you share a bit more detail about what you'd like handled or what's happening now? I'll help directly where I can.",
};

export const NATURAL_ONE_QUESTION_CLARIFICATION: Record<CustomerLanguage, string> = {
  "zh-TW": "沒問題，我幫你跟進。可以說明一下具體是哪一項或發生了甚麼情況嗎？",
  "zh-CN": "没问题，我帮你跟进。可以说明一下具体是哪一项或发生了什么情况吗？",
  en: "Happy to help with that. Could you tell me which item it is, or what exactly is happening?",
};

/** True when customer-visible text leaks internal terminology. */
export function containsInternalTerminology(text: string): boolean {
  return internalTerminologyHits(text).length > 0;
}

export function internalTerminologyHits(text: string): string[] {
  const raw = (text ?? "").normalize("NFKC");
  const lower = raw.toLowerCase();
  const hits: string[] = [];
  for (const term of FORBIDDEN_INTERNAL_TERMS) {
    if (/[a-z]/.test(term)) {
      if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)) hits.push(term);
    } else if (raw.includes(term)) {
      hits.push(term);
    }
  }
  return hits;
}

/**
 * Last-line guard: if a generated reply leaks internal wording, replace it with
 * natural "I don't have confirmed information" wording instead of shipping the
 * leak to the customer.
 */
export function sanitizeCustomerFacingText(text: string, language: CustomerLanguage): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return NATURAL_INSUFFICIENT_INFO[language];
  if (containsInternalTerminology(trimmed)) return NATURAL_INSUFFICIENT_INFO[language];
  return trimmed;
}
