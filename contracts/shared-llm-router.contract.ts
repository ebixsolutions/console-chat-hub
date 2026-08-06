/**
 * Shared LLM Router Contract — the rules all apps must follow.
 *
 * Current state (from KB Project Memory and Learning Pack):
 *   - KB app uses frontend InvokeLLM() calls
 *   - SU CoachAI uses direct Anthropic fetch and different proxy imports
 *   - AI Chatbot uses _shared/llm-router.ts (governed router)
 *
 * Target state: all three apps route through a governed router that provides:
 *   - authz: caller identity verified before any model call
 *   - tenant: company_id attached to every call for attribution
 *   - redaction: PII stripped from outbound text
 *   - model routing: model id from platform configuration, never literals
 *   - credit logging: token counts persisted per-tenant
 *   - timeout/retry: bounded exponential backoff on retryable errors
 *   - structured output: JSON parsing with fence stripping
 *   - error sanitization: stable codes out, provider text never surfaced
 *   - observability: structured per-attempt logs
 *
 * Implementation path:
 *   1. AI Chatbot: DONE — supabase/functions/_shared/llm-router.ts
 *   2. KB app: must migrate InvokeLLM calls to a Base44 Function that
 *      wraps the same contract (authz, tenant, redaction, logging)
 *   3. SU CoachAI: must migrate direct fetch calls to the same contract
 *
 * The shared router is the ONLY permitted call site for the Anthropic API.
 * No app may construct its own HTTP request to api.anthropic.com.
 */

export interface GovernedLlmCall {
  purpose: string;
  system: string;
  user: string;
  maxTokens: number;
  operationId: string;
  companyId: string;
  conversationId: string | null;
  tag: string;
}

export type GovernedLlmResult =
  | { ok: true; text: string; model: string; usage: { input_tokens: number; output_tokens: number; latency_ms: number; attempts: number }; request_id: string }
  | { ok: false; code: string; request_id: string };

/**
 * KB-specific migration requirements:
 *   - Smart Check AI scoring must go through the router
 *   - Duplicate/conflict detection LLM calls must go through the router
 *   - KBReview agent LLM calls must go through the router
 *   - Document summary generation must go through the router
 *   - All calls must carry the document's workspace_id/tenant_id
 *
 * CoachAI-specific migration requirements:
 *   - Prompt runtime LLM calls must go through the router
 *   - Training candidate evaluation must go through the router
 *   - Agent assist must go through the router
 *   - All calls must carry the company_id from the conversation
 */
