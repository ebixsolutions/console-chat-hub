#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CI = ROOT / "supabase/functions/_shared/conversation-intelligence.ts"
GEN = ROOT / "supabase/functions/generate-reply/index.ts"

ci = CI.read_text()
if "export function buildConversationContinuityBlock" not in ci:
    ci += r'''

export type ConversationHistoryRow = {
  role?: string;
  content?: string | null;
  metadata?: unknown;
};

function cleanContinuityText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

const CUSTOMER_ROLES = new Set(["visitor", "customer", "user"]);
const CORRECTION_OR_CONSTRAINT = /(我講錯|我说错|我說錯|更正|其實係|其实是|唔係.*係|不是.*是|改返|改成|唔好|不要|不准|唔准|只係想知|只是想知道|只想知道|actually|i meant|correction|don't|do not|not .* but|only asking|just asking)/i;

/**
 * Lightweight multi-turn state projection. This is deliberately deterministic,
 * bounded and in-memory: it does not invent facts and does not add a schema.
 * The newest customer statements are shown first so corrections and prohibitions
 * visibly supersede earlier context in the model's attention window.
 */
export function buildConversationContinuityBlock(
  newestFirstMessages: ConversationHistoryRow[],
): string {
  const customerTurns = newestFirstMessages
    .filter((row) => CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase()))
    .map((row) => cleanContinuityText(row.content))
    .filter(Boolean)
    .slice(0, 20);

  if (customerTurns.length < 2) return "";

  const corrections = customerTurns.filter((text) => CORRECTION_OR_CONSTRAINT.test(text)).slice(0, 6);
  const recent = customerTurns.slice(0, 8);
  const lines = [
    "Conversation continuity (internal guidance; never quote this block):",
    "- Treat the newest customer statement as authoritative when it corrects, narrows, cancels, or forbids an earlier request.",
    "- Do not re-ask a detail already supplied unless the customer made it ambiguous or contradictory.",
    "- Keep unresolved follow-up questions in context; do not pretend an action was requested when the customer only asked whether it is possible.",
  ];
  if (corrections.length) {
    lines.push("Latest corrections / constraints (newest first):");
    corrections.forEach((text, i) => lines.push(`${i + 1}. ${text}`));
  }
  lines.push("Recent customer turns (newest first):");
  recent.forEach((text, i) => lines.push(`${i + 1}. ${text}`));
  return lines.join("\n").slice(0, 5000);
}

export interface CustomerAdvisorySignals {
  tier?: string | null;
  anger_flag?: boolean;
  sentiment_score?: number;
  churn_risk?: number;
  escalation_score?: number;
}

/** Advisory only: changes response strategy/tone, never creates a required handoff. */
export function buildCustomerAdvisoryContext(signals: CustomerAdvisorySignals): string {
  const lines: string[] = [];
  const tier = typeof signals.tier === "string" ? signals.tier.trim().slice(0, 80) : "";
  const angry = signals.anger_flag === true ||
    (typeof signals.sentiment_score === "number" && Number.isFinite(signals.sentiment_score) && signals.sentiment_score <= -0.5);
  const risk = typeof signals.churn_risk === "number" && Number.isFinite(signals.churn_risk)
    ? Math.max(0, Math.min(1, signals.churn_risk)) : null;
  const escalation = typeof signals.escalation_score === "number" && Number.isFinite(signals.escalation_score)
    ? Math.max(0, Math.min(1, signals.escalation_score)) : null;

  if (!tier && !angry && risk === null && escalation === null) return "";
  lines.push("Customer advisory context (internal, advisory only; never reveal scores or labels):");
  if (tier) lines.push(`- Customer tier is available (${tier}). Be attentive and efficient, but tier/VIP status alone must never trigger human handoff or unsupported promises.`);
  if (angry) lines.push("- Current/fresh signals indicate frustration or anger. Acknowledge the concern briefly, avoid repetitive apologies, answer the core issue first, and do not force a human handoff solely because of emotion.");
  if (risk !== null || escalation !== null) lines.push("- Predictive customer-risk signals are available. Use them only to improve clarity, urgency and helpfulness; they are not authorization for a required handoff or customer action.");
  return lines.join("\n");
}
'''
    CI.write_text(ci)

gen = GEN.read_text()
old_import = 'import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";'
new_import = 'import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, buildConversationContinuityBlock, buildCustomerAdvisoryContext, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";'
if old_import in gen:
    gen = gen.replace(old_import, new_import, 1)
elif new_import not in gen:
    raise SystemExit("conversation-intelligence import anchor missing")

history_anchor = '''  const _pr5History = deriveConversationHistorySignals(
    _pr5HistoryRows ?? [],
    _pr5VisitorTurnCount ?? 0,
  );
'''
history_new = history_anchor + '''  const _conversationContinuityBlock = buildConversationContinuityBlock(_pr5HistoryRows ?? []);
'''
if "const _conversationContinuityBlock" not in gen:
    if history_anchor not in gen:
        raise SystemExit("history anchor missing")
    gen = gen.replace(history_anchor, history_new, 1)

prompt_old = 'const finalSystemPrompt = [basePrompt, CUSTOMER_CONVERSATION_POLICY, buildMaskedContextBlock(customerContext, opaqueCustomerRef), buildRagBlock(ragResult)].filter((s) => s && s.length > 0).join("\\n\\n");'
prompt_new = '''const _customerAdvisoryBlock = buildCustomerAdvisoryContext({
    tier: customerContext?.tier,
    anger_flag: _pr5R3Sentiment?.anger_flag,
    sentiment_score: _pr5R3Sentiment?.sentiment_score,
    churn_risk: customerContext?.churn_risk,
    escalation_score: customerContext?.escalation_score,
  });
  const finalSystemPrompt = [
    basePrompt,
    CUSTOMER_CONVERSATION_POLICY,
    _conversationContinuityBlock,
    _customerAdvisoryBlock,
    buildMaskedContextBlock(customerContext, opaqueCustomerRef),
    buildRagBlock(ragResult),
  ].filter((s) => s && s.length > 0).join("\\n\\n");'''
if "const _customerAdvisoryBlock" not in gen:
    if prompt_old not in gen:
        raise SystemExit("final prompt anchor missing")
    gen = gen.replace(prompt_old, prompt_new, 1)

GEN.write_text(gen)
print("Task 3.3 multi-turn continuity enhancement applied")
