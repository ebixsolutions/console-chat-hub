import type { ConversationCommerceState } from "./commerce-state-contract.ts";

export const C2_HANDOFF_SCHEMA_VERSION = "c2-handoff-1.0.0" as const;

export type C2ClosureState =
  | "OPEN"
  | "WAITING_FOR_CUSTOMER"
  | "WAITING_FOR_HUMAN"
  | "HANDOFF_REQUIRED"
  | "TRANSACTION_PENDING"
  | "RESOLVABLE"
  | "RESOLVED";

export type C2Citation = {
  document_id: string;
  chunk_id: string;
  source_type: string;
  target_entity_model: string[];
  target_topics: string[];
  authority_decision: string;
  evidence_state: "current";
  region: string | null;
};

export type C2HandoffEntity = {
  entity_id: string;
  category: string;
  brand: string | null;
  model: string | null;
  quantity: number;
  status: string;
  current_quote: { amount: number; currency: string; status: string } | null;
  pending_issues: string[];
};

export type C2HandoffPackage = {
  schema_version: typeof C2_HANDOFF_SCHEMA_VERSION;
  conversation_id: string;
  company_id: string;
  handoff_reason: string;
  handoff_reason_code: string;
  handoff_authority: string;
  current_customer_goal: string;
  active_entities: C2HandoffEntity[];
  latest_corrections: string[];
  confirmed_facts: Array<{ key: string; value: string; source: "canonical_commerce_state" }>;
  historical_or_superseded_facts: Array<{ key: string; value: string; state: string }>;
  transaction_state: {
    quotation: string;
    order: string;
    payment: string;
    delivery: string;
    installation: string;
  };
  open_questions: string[];
  pending_actions: string[];
  customer_preferences: Array<{ key: string; value: string }>;
  current_authoritative_kb_facts: Array<{ fact: string; citation_document_id: string; citation_chunk_id: string }>;
  citations: C2Citation[];
  safety_or_professional_requirements: string[];
  recommended_next_human_action: string;
  generated_from_source_message_id: string;
  commerce_state_revision: number | null;
  generated_at: string;
};

export type C2PersistedEnvelope = {
  schema_version: typeof C2_HANDOFF_SCHEMA_VERSION;
  structured_package: C2HandoffPackage;
  summary_markdown: string;
};

export type C2ClosureDecision = {
  state: C2ClosureState;
  may_resolve: boolean;
  blockers: string[];
  reason: string;
};

type PackageInput = {
  conversation_id: string;
  company_id: string;
  source_message_id: string;
  handoff_reason: string;
  handoff_authority: string;
  commerce_state_revision: number | null;
  commerce_state: ConversationCommerceState | null;
  current_customer_goal: string;
  generated_at: string;
  citations?: unknown[];
  safety_or_professional_requirements?: string[];
};

const clean = (value: unknown, max = 500): string =>
  typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";

const unique = (values: string[], max = 50): string[] =>
  [...new Set(values.map((value) => clean(value, 300)).filter(Boolean))].slice(0, max);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function classifyC2HandoffReason(authority: string): string {
  const value = clean(authority, 100).toUpperCase();
  if (value === "R1") return "explicit_customer_request";
  if (value === "E1" || value === "E2") return "professional_or_safety_confirmation";
  if (value === "S0") return "operational_follow_up";
  if (value === "R2") return "unresolved_authority_or_repeated_failure";
  if (value === "P2" || value === "R4") return "policy_exception";
  return "existing_escalation_authority";
}

export function transactionBlockers(
  state: ConversationCommerceState | null,
  options: { handoff_active?: boolean; professional_confirmation_required?: boolean } = {},
): string[] {
  if (options.handoff_active) return ["handoff_active"];
  if (options.professional_confirmation_required) return ["professional_confirmation_required"];
  if (!state) return [];
  const blockers = [...state.unresolved_items, ...state.installation.pending_checks];
  const active = state.entities.filter((entity) =>
    entity.status !== "cancelled" && entity.status !== "deferred"
  );
  if (active.some((entity) => entity.status === "tentative")) blockers.push("tentative_entity");
  if (["draft", "pending_verification"].includes(state.conversion.quotation_status)) {
    blockers.push("quotation_pending");
  }
  if (["draft", "pending_confirmation"].includes(state.conversion.order_status)) {
    blockers.push("order_pending");
  }
  if (["pending_quote", "pending_payment"].includes(state.conversion.payment_status)) {
    blockers.push("payment_pending");
  }
  if (state.installation.items.some((item) => item.status === "pending")) {
    blockers.push("installation_pending");
  }
  if (clean(state.conversion.next_best_action)) blockers.push("next_action_pending");
  return unique(blockers);
}

export function decideTransactionClosure(input: {
  utterance_kind: "none" | "closure_candidate" | "no_more_help" | "positive_no_more_help";
  commerce_state: ConversationCommerceState | null;
  handoff_active?: boolean;
  handoff_required?: boolean;
  professional_confirmation_required?: boolean;
}): C2ClosureDecision {
  if (input.handoff_required) {
    return { state: "HANDOFF_REQUIRED", may_resolve: false, blockers: ["handoff_required"], reason: "deterministic_handoff_authority" };
  }
  if (input.handoff_active) {
    return { state: "WAITING_FOR_HUMAN", may_resolve: false, blockers: ["handoff_active"], reason: "human_control_active" };
  }
  const blockers = transactionBlockers(input.commerce_state, input);
  if (input.utterance_kind === "closure_candidate") {
    return { state: "WAITING_FOR_CUSTOMER", may_resolve: false, blockers, reason: "acknowledgement_is_not_resolution" };
  }
  if (input.utterance_kind === "none") {
    return { state: blockers.length ? "TRANSACTION_PENDING" : "OPEN", may_resolve: false, blockers, reason: "no_explicit_closure" };
  }
  if (blockers.length) {
    return { state: "TRANSACTION_PENDING", may_resolve: false, blockers, reason: "canonical_requirements_remain" };
  }
  return { state: "RESOLVED", may_resolve: true, blockers: [], reason: "explicit_closure_and_no_canonical_blockers" };
}

function safeCitations(citations: unknown[] | undefined, activeIds: Set<string>): C2Citation[] {
  const result: C2Citation[] = [];
  for (const raw of citations ?? []) {
    const item = record(raw);
    if (!item) continue;
    const document_id = clean(item.document_id, 200);
    const chunk_id = clean(item.chunk_id, 200);
    const source_type = clean(item.source_type, 80);
    const authority_decision = clean(item.authority_decision, 100);
    const evidence_state = clean(item.evidence_state, 40).toLowerCase();
    const targets = Array.isArray(item.target_entity_model)
      ? unique(item.target_entity_model.map(String), 20)
      : [];
    if (!document_id || !chunk_id || !source_type || evidence_state !== "current") continue;
    if (activeIds.size && targets.length && !targets.some((target) => activeIds.has(target.toLowerCase()))) continue;
    result.push({
      document_id,
      chunk_id,
      source_type,
      target_entity_model: targets,
      target_topics: Array.isArray(item.target_topics) ? unique(item.target_topics.map(String), 20) : [],
      authority_decision: authority_decision || "CURRENT_KB",
      evidence_state: "current",
      region: clean(item.region, 80) || null,
    });
  }
  return result.slice(0, 12);
}

function installationStatus(state: ConversationCommerceState | null): string {
  if (!state || state.installation.items.length === 0) return "unknown";
  if (state.installation.items.some((item) => item.status === "pending")) return "pending";
  if (state.installation.items.every((item) => ["confirmed", "not_required"].includes(item.status))) return "confirmed";
  return "unknown";
}

export function buildC2HandoffPackage(input: PackageInput): C2HandoffPackage {
  const state = input.commerce_state;
  const active = state?.entities.filter((entity) =>
    entity.status !== "cancelled" && entity.status !== "deferred"
  ) ?? [];
  const activeIds = new Set(active.flatMap((entity) =>
    [entity.entity_id, entity.model ?? "", entity.brand ?? ""]
      .map((value) => clean(value, 200).toLowerCase()).filter(Boolean)
  ));
  const currentQuotes = state?.quotes.filter((quote) =>
    quote.quote_type === "current_verified" &&
    quote.validity_status === "current"
  ) ?? [];
  const historicalQuotes = state?.quotes.filter((quote) =>
    quote.quote_type.includes("historical") ||
    ["historical", "expired", "superseded", "invalid"].includes(quote.validity_status)
  ) ?? [];
  const entities = active.map((entity): C2HandoffEntity => {
    const quote = currentQuotes.find((candidate) => candidate.entity_id === entity.entity_id) ?? null;
    return {
      entity_id: clean(entity.entity_id, 200),
      category: clean(entity.category, 120),
      brand: clean(entity.brand, 120) || null,
      model: clean(entity.model, 120) || null,
      quantity: Number.isFinite(entity.quantity) ? entity.quantity : 0,
      status: entity.status,
      current_quote: quote
        ? { amount: quote.amount, currency: clean(quote.currency, 20), status: quote.validity_status }
        : null,
      pending_issues: unique((state?.unresolved_items ?? []).filter((issue) =>
        issue.toLowerCase().includes(entity.entity_id.toLowerCase())
      )),
    };
  });
  const confirmed: C2HandoffPackage["confirmed_facts"] = [];
  if (state?.conversion.order_status === "confirmed") confirmed.push({ key: "order", value: "confirmed", source: "canonical_commerce_state" });
  if (state?.conversion.payment_status === "paid") confirmed.push({ key: "payment", value: "paid", source: "canonical_commerce_state" });
  if (state?.delivery.confirmed) confirmed.push({ key: "delivery", value: "confirmed", source: "canonical_commerce_state" });
  const citations = safeCitations(input.citations, activeIds);
  const preferences = Object.entries(state?.customer_constraints ?? {})
    .filter(([key, value]) =>
      !/(?:address|phone|email|identity|name)/i.test(key) &&
      ["string", "number", "boolean"].includes(typeof value)
    )
    .map(([key, value]) => ({ key: clean(key, 100), value: clean(String(value), 300) }))
    .slice(0, 20);
  const pending = unique([
    ...(state?.unresolved_items ?? []),
    ...(state?.installation.pending_checks ?? []),
    clean(state?.conversion.next_best_action),
  ]);
  const safety = unique(input.safety_or_professional_requirements ?? []);
  return {
    schema_version: C2_HANDOFF_SCHEMA_VERSION,
    conversation_id: clean(input.conversation_id, 100),
    company_id: clean(input.company_id, 100),
    handoff_reason: clean(input.handoff_reason, 500),
    handoff_reason_code: classifyC2HandoffReason(input.handoff_authority),
    handoff_authority: clean(input.handoff_authority, 100),
    current_customer_goal: clean(input.current_customer_goal, 1000) || "unknown",
    active_entities: entities,
    latest_corrections: unique(state?.latest_corrections ?? []),
    confirmed_facts: confirmed,
    historical_or_superseded_facts: historicalQuotes.map((quote) => ({
      key: `quote:${clean(quote.quote_id, 120)}`,
      value: `${quote.currency} ${quote.amount}`,
      state: quote.validity_status,
    })).slice(0, 20),
    transaction_state: {
      quotation: state?.conversion.quotation_status ?? "unknown",
      order: state?.conversion.order_status ?? "unknown",
      payment: state?.conversion.payment_status ?? "unknown",
      delivery: state ? (state.delivery.confirmed ? "confirmed" : "not_confirmed") : "unknown",
      installation: installationStatus(state),
    },
    open_questions: unique(state?.unresolved_items ?? []),
    pending_actions: pending,
    customer_preferences: preferences,
    current_authoritative_kb_facts: citations.map((citation) => ({
      fact: "See current authoritative citation",
      citation_document_id: citation.document_id,
      citation_chunk_id: citation.chunk_id,
    })),
    citations,
    safety_or_professional_requirements: safety,
    recommended_next_human_action: clean(state?.conversion.next_best_action, 500) ||
      (pending.length ? `Confirm: ${pending[0]}` : "Review the current request and confirm the next authorized action."),
    generated_from_source_message_id: clean(input.source_message_id, 100),
    commerce_state_revision: Number.isSafeInteger(input.commerce_state_revision)
      ? input.commerce_state_revision
      : null,
    generated_at: clean(input.generated_at, 100),
  };
}

export function renderC2HandoffSummary(pkg: C2HandoffPackage): string {
  const entityLines = pkg.active_entities.length
    ? pkg.active_entities.map((entity) =>
      `- ${entity.category || "Entity"} ${entity.model ?? entity.entity_id}: quantity ${entity.quantity}; ${entity.status}`
    )
    : ["- —"];
  const correctionLines = pkg.latest_corrections.length
    ? pkg.latest_corrections.map((value) => `- ${value}`)
    : ["- —"];
  const pendingLines = pkg.pending_actions.length
    ? pkg.pending_actions.map((value) => `- ${value}`)
    : ["- —"];
  return [
    "### Customer Goal", pkg.current_customer_goal,
    "", "### Current State", ...entityLines,
    `- Order: ${pkg.transaction_state.order}`,
    `- Payment: ${pkg.transaction_state.payment}`,
    `- Delivery: ${pkg.transaction_state.delivery}`,
    `- Installation: ${pkg.transaction_state.installation}`,
    "", "### Latest Correction", ...correctionLines,
    "", "### Pending", ...pendingLines,
    "", "### Handoff Reason", pkg.handoff_reason,
    "", "### Recommended Next Action", pkg.recommended_next_human_action,
  ].join("\n").slice(0, 4000);
}

export function parsePersistedC2Handoff(value: unknown): C2PersistedEnvelope | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const envelope = record(parsed);
  const pkg = record(envelope?.structured_package);
  if (
    envelope?.schema_version !== C2_HANDOFF_SCHEMA_VERSION ||
    pkg?.schema_version !== C2_HANDOFF_SCHEMA_VERSION ||
    !clean(pkg.conversation_id) ||
    !clean(pkg.company_id) ||
    !clean(pkg.generated_from_source_message_id) ||
    typeof envelope?.summary_markdown !== "string"
  ) return null;
  return parsed as C2PersistedEnvelope;
}

export function validateC2CommitSnapshot(expected: {
  conversation_id: string;
  company_id: string;
  source_message_id: string;
  commerce_state_revision: number | null;
}, current: {
  conversation_id: string;
  company_id: string;
  latest_source_message_id: string;
  commerce_state_revision: number | null;
  handoff_authority_valid: boolean;
  superseded_by_human_action?: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (expected.conversation_id !== current.conversation_id || expected.company_id !== current.company_id) {
    return { ok: false, reason: "tenant_or_conversation_mismatch" };
  }
  if (expected.source_message_id !== current.latest_source_message_id) {
    return { ok: false, reason: "stale_source_message" };
  }
  if (expected.commerce_state_revision !== current.commerce_state_revision) {
    return { ok: false, reason: "stale_commerce_revision" };
  }
  if (!current.handoff_authority_valid) return { ok: false, reason: "handoff_authority_invalid" };
  if (current.superseded_by_human_action) return { ok: false, reason: "human_action_superseded" };
  return { ok: true };
}

export function buildC2PendingClosureReply(
  language: "zh-TW" | "zh-CN" | "en",
  blockers: string[],
): string {
  const item = clean(blockers[0], 180) || "the remaining requirement";
  if (language === "en") return `Before we close this, ${item} is still pending. I can keep helping with that, or arrange the already-authorized human follow-up where applicable.`;
  if (language === "zh-CN") return `结束对话前，仍需处理：${item}。我可以继续协助，或按现有授权安排人工跟进。`;
  return `結束對話前，仍需處理：${item}。我可以繼續協助，或按現有授權安排真人跟進。`;
}
