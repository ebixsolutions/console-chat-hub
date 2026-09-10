import { callModel } from "./llm-router.ts";
import {
  COMMERCE_SEMANTIC_FRAME_VERSION,
  normalizeCommerceSemanticFrame,
  type CommerceSemanticFrame,
} from "./commerce-semantic-frame.ts";

export interface CommerceSemanticHistoryTurn {
  role: string;
  content: string;
}

export interface CommerceSemanticInterpretInput {
  company_id: string;
  conversation_id: string;
  source_message_id: string;
  latest: string;
  history?: CommerceSemanticHistoryTurn[];
  persistent_state_summary?: string | null;
}

export interface CommerceSemanticInterpretResult {
  frame: CommerceSemanticFrame | null;
  source: "llm" | "none";
  failure_code: string | null;
}

const SYSTEM = `You are a multilingual commerce semantic interpreter.
Your job is ONLY to understand the customer's commerce meaning and return one JSON object matching the canonical commerce semantic frame.
Do not answer the customer. Do not invent product facts, prices, availability, policies, T&C, delivery rules or company facts.
Do not assume an industry taxonomy. Interpret unfamiliar products/services compositionally from the customer's words and context.
Required JSON fields: version, language, operation, intent, topic, entities, referents, customer_correction, additive, explicit_negations, requested_facts, confidence.
Each entity must contain: entity_ref, name, kind, category_hint, sku, model, quantity, unit, attributes, constraints, capabilities, confidence.
Allowed operation values: ADD_ITEM, SET_QUANTITY, UPDATE_ITEM, REMOVE_ITEM, CANCEL_ITEM, RESERVE, REQUEST_QUOTE, ASK_FACT, ASK_CALCULATION, CONFIRM, DEFER, NO_STATE_CHANGE.
Allowed kind values: physical_product, digital_good, service, rental, subscription, ticket, custom_item, b2b_product, unknown.
Capabilities must contain booleans: requires_delivery, supports_pickup, requires_installation, requires_booking, requires_quote, requires_site_check, digital_fulfilment, recurring_billing, rental_return, customization.
Core rules:
1. Resolve ellipsis, pronouns and short follow-ups from recent customer context and persistent state when confidence is sufficient.
2. Keep semantics language-neutral even though language records the customer's input language.
3. name is the clean item/service name, excluding quantity, unit, color/size/date/time and transaction verbs when possible.
4. Put arbitrary customer-authored properties in attributes and requirements/limits in constraints.
5. Capabilities describe what the requested commerce object/operation requires; do not infer company support. A customer asking about delivery may imply requires_delivery only if the requested transaction itself needs delivery; asking whether pickup is allowed may set supports_pickup=true as a requested capability, not as a confirmed company fact.
6. If a fact must come from KB/API (price, FAQ, policy, T&C, warranty, delivery rules, availability), put a concise semantic concept in requested_facts. Do NOT provide the answer.
7. customer_correction=true only when the latest message supersedes a prior customer-authored fact. additive=true only when quantity/items are explicitly added rather than replaced.
8. Negated transaction statements such as '未付款', 'not paid yet' must appear in explicit_negations and must never become confirmations.
9. If the latest turn is only a factual question with no state mutation, use ASK_FACT or NO_STATE_CHANGE.
10. Unknown industries and unseen vocabulary are expected; never fall back to an industry list.
Return JSON only.`;

function clean(value: unknown, max = 3000): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function buildUser(input: CommerceSemanticInterpretInput): string {
  const prior = (input.history ?? [])
    .filter((x) => clean(x.content) && clean(x.content) !== clean(input.latest))
    .slice(-12)
    .map((x, i) => `${i + 1}. ${String(x.role || "unknown")}: ${clean(x.content, 800)}`)
    .join("\n");
  return [
    `Semantic frame version: ${COMMERCE_SEMANTIC_FRAME_VERSION}`,
    `Latest customer turn: ${clean(input.latest, 1600)}`,
    prior ? `Recent conversation turns (oldest to newest):\n${prior}` : "Recent conversation turns: none",
    input.persistent_state_summary ? `Persistent commerce state summary (customer-authored state only; do not treat as external facts):\n${clean(input.persistent_state_summary, 2400)}` : "Persistent commerce state summary: none",
    "Return one canonical semantic frame.",
  ].join("\n\n");
}

export async function interpretCommerceSemantics(
  input: CommerceSemanticInterpretInput,
): Promise<CommerceSemanticInterpretResult> {
  const latest = clean(input.latest, 1600);
  if (!latest) return { frame: null, source: "none", failure_code: null };

  // Vertex's constrained responseSchema rejects our open-ended attributes/constraints
  // shape (HTTP 400). Keep provider-level JSON mode, then enforce the canonical
  // semantic contract through normalizeCommerceSemanticFrame before any state event
  // is accepted. The model still cannot write state directly.
  const result = await callModel({
    purpose: "evaluation",
    system: SYSTEM,
    user: buildUser(input),
    maxTokens: 1800,
    operationId: `commerce-semantic:${input.source_message_id}`,
    companyId: input.company_id,
    conversationId: input.conversation_id,
    tag: "commerce-semantic-interpreter",
    responseFormat: "json",
  });

  if (!result.ok) {
    return { frame: null, source: "none", failure_code: result.code };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return { frame: null, source: "none", failure_code: "LLM_INVALID_OUTPUT" };
  }
  const frame = normalizeCommerceSemanticFrame(parsed);
  if (!frame) return { frame: null, source: "none", failure_code: "LLM_INVALID_OUTPUT" };
  return { frame, source: "llm", failure_code: null };
}
