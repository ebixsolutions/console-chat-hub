import { callModel } from "./deterministic-runtime-router.ts";
import { getSupabaseAdminKey } from "./supabase-admin-key.ts";
import {
  COMMERCE_SEMANTIC_FRAME_VERSION,
  type CommerceSemanticFrame,
  normalizeCommerceSemanticFrame,
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
  signal?: AbortSignal;
}

export interface CommerceSemanticInterpretResult {
  frame: CommerceSemanticFrame | null;
  source: "deterministic" | "none";
  failure_code: string | null;
}

const SYSTEM = `You are a multilingual commerce semantic interpreter.
Your job is ONLY to understand the customer's commerce meaning and return one JSON object matching the canonical commerce semantic frame.
Do not answer the customer. Do not invent product facts, prices, availability, policies, T&C, delivery rules or company facts.
Do not assume an industry taxonomy. Interpret unfamiliar products/services compositionally from the customer's words and context.
Required JSON fields: version, language, operation, intent, topic, entities, referents, customer_correction, additive, explicit_negations, requested_facts, transaction_state, payment_state, booking_state, fulfillment_state, ambiguity, confidence.
Each entity must contain: entity_ref, name, kind, category_hint, sku, model, quantity, unit, attributes, constraints, capabilities, confidence.
ambiguity must contain: is_ambiguous, reasons, clarification_question.
Allowed operation values: ADD_ITEM, SET_QUANTITY, UPDATE_ITEM, REMOVE_ITEM, CANCEL_ITEM, RESERVE, REQUEST_QUOTE, ASK_FACT, ASK_CALCULATION, CONFIRM, DEFER, NO_STATE_CHANGE.
Allowed kind values: physical_product, digital_good, service, rental, subscription, ticket, custom_item, b2b_product, unknown.
Allowed transaction_state values: none, draft, pending_confirmation, confirmed, completed, cancelled, unknown.
Allowed payment_state values: none, pending_quote, pending_payment, paid, failed, refunded, partially_refunded, unknown.
Allowed booking_state values: none, requested, pending, booked, completed, cancelled, unknown.
Allowed fulfillment_state values: none, requested, pending, scheduled, in_progress, fulfilled, cancelled, unknown.
Capabilities must contain booleans: requires_delivery, supports_pickup, requires_installation, requires_booking, requires_quote, requires_site_check, digital_fulfilment, recurring_billing, rental_return, customization.
Core rules:
1. Resolve ellipsis, pronouns and short follow-ups from recent customer context and persistent state only when confidence is sufficient. If two or more plausible referents/meanings remain, set ambiguity.is_ambiguous=true, explain concise reasons, provide a clarification_question, use NO_STATE_CHANGE and do not propose a mutation.
2. Keep semantics language-neutral even though language records the customer's input language.
3. name is the clean item/service name, excluding quantity, unit, color/size/date/time and transaction verbs when possible.
4. Put arbitrary customer-authored properties in attributes and requirements/limits in constraints.
5. Capabilities describe what the requested commerce object/operation requires; do not infer company support. A customer asking about delivery may imply requires_delivery only if the requested transaction itself needs delivery; asking whether pickup is allowed may set supports_pickup=true as a requested capability, not as a confirmed company fact.
6. If a fact must come from KB/API (price, FAQ, policy, T&C, warranty, delivery rules, availability), put a concise semantic concept in requested_facts. Do NOT provide the answer.
7. customer_correction=true only when the latest message supersedes a prior customer-authored fact. additive=true only when quantity/items are explicitly added rather than replaced.
8. Negated transaction statements such as '未付款', 'not paid yet', 'not booked', 'not confirmed' must appear in explicit_negations and must never become confirmations.
9. Lifecycle fields are semantic observations, never authority to mutate state. Never emit paid, booked, confirmed, completed, scheduled or fulfilled unless the customer/context contains explicit evidence for that exact state. Future intent such as 'I will pay', 'book it later' or '安排星期五' is not completion evidence.
10. If the latest turn is only a factual/safety/policy question with no state mutation, use ASK_FACT or NO_STATE_CHANGE and do not invent a new commerce entity merely from the subject of the question when a prior referent is available.
11. Unknown industries and unseen vocabulary are expected; never fall back to an industry list or synonym dictionary.
12. Never invent add-ons/options/fees. Only include them when customer-authored context explicitly identifies them or persistent customer-authored state already contains them.
13. If confidence is below 0.62, set ambiguity.is_ambiguous=true and operation=NO_STATE_CHANGE.
Return JSON only.`;

function clean(value: unknown, max = 3000): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Produces the bounded customer-authored state context presented to the semantic
 * model. This is context only: the model cannot persist it and the deterministic
 * A1/A2 reducer remains the sole state mutation authority.
 */
export function buildPersistentCommerceStateSummary(
  row: unknown,
): string | null {
  if (!isRecord(row) || !isRecord(row.state)) return null;
  const revision = typeof row.revision === "number"
    ? row.revision
    : Number(row.revision ?? 0);
  const bounded = {
    revision: Number.isFinite(revision) && revision >= 0 ? revision : 0,
    state: row.state,
  };
  try {
    return JSON.stringify(bounded).slice(0, 2400);
  } catch {
    return null;
  }
}

/**
 * Read-only tenant-bound persistent state lookup. If the caller did not already
 * supply a state summary, A3.1 resolves it here before semantic interpretation.
 * Failure is non-blocking: the interpreter can still use bounded conversation
 * history, while deterministic runtime state loading/persistence remains separate.
 */
async function loadPersistentCommerceStateSummary(
  input: CommerceSemanticInterpretInput,
): Promise<string | null> {
  const supplied = clean(input.persistent_state_summary, 2400);
  if (supplied) return supplied;

  const supabaseUrl = clean(Deno.env.get("SUPABASE_URL"), 600).replace(
    /\/$/,
    "",
  );
  if (!supabaseUrl || !input.conversation_id || !input.company_id) return null;

  let adminKey = "";
  try {
    adminKey = getSupabaseAdminKey();
  } catch {
    return null;
  }

  const params = new URLSearchParams({
    select: "revision,state",
    conversation_id: `eq.${input.conversation_id}`,
    company_id: `eq.${input.company_id}`,
    limit: "1",
  });
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromRequest();
  else {input.signal?.addEventListener("abort", abortFromRequest, {
      once: true,
    });}
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/conversation_commerce_state?${params.toString()}`,
      {
        method: "GET",
        headers: {
          apikey: adminKey,
          Authorization: `Bearer ${adminKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!Array.isArray(payload) || payload.length === 0) return null;
    return buildPersistentCommerceStateSummary(payload[0]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromRequest);
  }
}

function buildUser(
  input: CommerceSemanticInterpretInput,
  persistentStateSummary: string | null,
): string {
  const prior = (input.history ?? [])
    .filter((x) => clean(x.content) && clean(x.content) !== clean(input.latest))
    .slice(-12)
    .map((x, i) =>
      `${i + 1}. ${String(x.role || "unknown")}: ${clean(x.content, 800)}`
    )
    .join("\n");
  return [
    `Semantic frame version: ${COMMERCE_SEMANTIC_FRAME_VERSION}`,
    `Latest customer turn: ${clean(input.latest, 1600)}`,
    prior
      ? `Recent conversation turns (oldest to newest):\n${prior}`
      : "Recent conversation turns: none",
    persistentStateSummary
      ? `Persistent commerce state summary (customer-authored state only; do not treat as external facts):\n${
        clean(persistentStateSummary, 2400)
      }`
      : "Persistent commerce state summary: none",
    "Return one canonical semantic frame.",
  ].join("\n\n");
}

export async function interpretCommerceSemantics(
  input: CommerceSemanticInterpretInput,
): Promise<CommerceSemanticInterpretResult> {
  const latest = clean(input.latest, 1600);
  if (!latest) return { frame: null, source: "none", failure_code: null };

  const persistentStateSummary = await loadPersistentCommerceStateSummary(
    input,
  );

  // Vertex's constrained responseSchema rejects our open-ended attributes/constraints
  // shape (HTTP 400). Keep provider-level JSON mode, then enforce the canonical
  // semantic contract through normalizeCommerceSemanticFrame before any state event
  // is accepted. The model still cannot write state directly.
  const result = await callModel({
    purpose: "evaluation",
    system: SYSTEM,
    user: buildUser(input, persistentStateSummary),
    maxTokens: 1800,
    operationId: `commerce-semantic:${input.source_message_id}`,
    companyId: input.company_id,
    conversationId: input.conversation_id,
    tag: "commerce-semantic-interpreter",
    responseFormat: "json",
    signal: input.signal,
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
  if (!frame) {
    return { frame: null, source: "none", failure_code: "LLM_INVALID_OUTPUT" };
  }
  return { frame, source: "deterministic", failure_code: null };
}
