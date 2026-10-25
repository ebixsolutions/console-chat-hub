import type {
  CommerceProvenance,
  ConversationCommerceState,
} from "./commerce-state-contract.ts";
import type {
  CommerceStateEvent,
  CommerceTurnEntityHint,
} from "./commerce-state-reducer.ts";
import type {
  CommerceSemanticEntity,
  CommerceSemanticFrame,
} from "./commerce-semantic-frame.ts";
import { mergeDecisionContext, type DecisionValue } from "./bounded-decision-context.ts";

function clean(value: unknown, max = 200): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function slugify(raw: string): string {
  return clean(raw, 160)
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function categoryFor(entity: CommerceSemanticEntity): string {
  if (entity.category_hint) {
    return clean(entity.category_hint, 80) || "generic_product";
  }
  switch (entity.kind) {
    case "digital_good":
      return "digital_good";
    case "service":
      return "service";
    case "rental":
      return "rental";
    case "subscription":
      return "subscription";
    case "ticket":
      return "ticket";
    case "custom_item":
      return "custom_item";
    case "b2b_product":
      return "b2b_product";
    case "physical_product":
      return "generic_product";
    default:
      return "generic_item";
  }
}

function entityId(entity: CommerceSemanticEntity): string {
  const explicit = clean(entity.entity_ref, 120);
  if (
    explicit && !/^(?:semantic|current|prior|item|entity):?\d*$/i.test(explicit)
  ) {
    return explicit.startsWith("generic:")
      ? explicit
      : `generic:${slugify(explicit)}`;
  }
  return `generic:${slugify(entity.name) || "item"}`;
}

export function semanticFrameToEntityHints(
  frame: CommerceSemanticFrame | null | undefined,
): CommerceTurnEntityHint[] {
  if (!frame) return [];
  const out: CommerceTurnEntityHint[] = [];
  const seen = new Set<string>();
  for (const entity of frame.entities) {
    if (!entity.name || entity.confidence < 0.45) continue;
    const id = entityId(entity);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      entity_id: id,
      category: categoryFor(entity),
      aliases: [
        ...new Set(
          [entity.name, entity.entity_ref, entity.sku ?? "", entity.model ?? ""]
            .map((x) => clean(x, 160))
            .filter(Boolean),
        ),
      ],
      quantity: entity.quantity ?? undefined,
      model: entity.model,
      attributes: {
        semantic_frame_version: frame.version,
        semantic_operation: frame.operation,
        product_name: entity.name,
        commerce_kind: entity.kind,
        unit: entity.unit,
        sku: entity.sku,
        semantic_confidence: entity.confidence,
        semantic_transaction_state: frame.transaction_state,
        semantic_payment_state: frame.payment_state,
        semantic_booking_state: frame.booking_state,
        semantic_fulfillment_state: frame.fulfillment_state,
        semantic_attributes: entity.attributes,
        capabilities: entity.capabilities,
      },
      constraints: entity.constraints,
    });
  }
  return out;
}

export function mergeCommerceEntityHints(
  semantic: CommerceTurnEntityHint[],
  deterministic: CommerceTurnEntityHint[],
): CommerceTurnEntityHint[] {
  const map = new Map<string, CommerceTurnEntityHint>();
  for (const hint of deterministic) map.set(hint.entity_id, hint);
  for (const hint of semantic) {
    const semanticAliases = (hint.aliases ?? []).map((x) =>
      clean(x).toLowerCase()
    ).filter(Boolean);
    const compatibleCandidates = [...map.values()].filter((candidate) => {
      const aliases = [
        candidate.entity_id,
        candidate.category,
        ...(candidate.aliases ?? []),
      ]
        .map((x) => clean(x).toLowerCase())
        .filter(Boolean);
      return semanticAliases.some((a) => aliases.includes(a));
    });
    const compatible = compatibleCandidates.length === 1
      ? compatibleCandidates[0]
      : undefined;
    const key = compatible?.entity_id ?? hint.entity_id;
    const existing = map.get(key);
    const normalized = compatible
      ? {
        ...hint,
        entity_id: compatible.entity_id,
        category: compatible.category,
      }
      : hint;
    if (!existing) {
      map.set(key, normalized);
      continue;
    }
    map.set(key, {
      ...existing,
      aliases: [
        ...new Set([
          ...(existing.aliases ?? []),
          ...(normalized.aliases ?? []),
        ]),
      ],
      quantity: normalized.quantity ?? existing.quantity,
      model: normalized.model ?? existing.model,
      attributes: {
        ...(existing.attributes ?? {}),
        ...(normalized.attributes ?? {}),
      },
      constraints: {
        ...(existing.constraints ?? {}),
        ...(normalized.constraints ?? {}),
      },
    });
  }
  return [...map.values()];
}

function provenance(
  sourceMessageId: string,
  occurredAt?: string | null,
): CommerceProvenance {
  return {
    source_type: "customer",
    source_message_id: sourceMessageId,
    recorded_at: occurredAt ?? null,
  };
}

function resolveHintId(
  entity: CommerceSemanticEntity,
  hints: CommerceTurnEntityHint[],
  previous: ConversationCommerceState,
): string | null {
  const wanted = [
    entity.name,
    entity.entity_ref,
    entity.sku ?? "",
    entity.model ?? "",
  ]
    .map((x) => clean(x).toLowerCase())
    .filter(Boolean);
  const hinted = hints.filter((hint) => {
    const aliases = [hint.entity_id, hint.category, ...(hint.aliases ?? [])]
      .map((x) => clean(x).toLowerCase())
      .filter(Boolean);
    return wanted.some((a) => aliases.includes(a));
  });
  if (hinted.length > 1) return null;
  if (hinted.length === 1) return hinted[0].entity_id;
  const direct = entityId(entity);
  if (previous.entities.some((x) => x.entity_id === direct)) return direct;
  return direct;
}

/** Customer-owned fact values have a bounded, language-neutral shape. */
function plainDecisionObject(value: unknown): value is Record<string, DecisionValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Return only leaf facts actually stated in a non-question customer clause.
 * A model's ASK_FACT proposal cannot by itself mutate canonical Commerce.
 * The user's literal assertion, the typed frame, and the existing CAS writer
 * must all agree. Unobserved or ambiguous leaves are deliberately omitted. */
export function sourceBoundMixedCustomerFactEvents(
  frame: CommerceSemanticFrame | null | undefined,
  previous: ConversationCommerceState,
  sourceText: string,
  sourceMessageId: string,
  occurredAt?: string | null,
): CommerceStateEvent[] {
  if (!frame || frame.operation !== "ASK_FACT" || frame.confidence < 0.72 ||
    frame.ambiguity.is_ambiguous || !frame.customer_facts?.length || frame.additive) return [];
  // Restrict extraction to declarations, never merchant factual questions,
  // hypotheticals, order/payment claims, or a model-only inferred preference.
  const statements = sourceText.normalize("NFKC").split(/[，,。;；!?！？\n]/u)
    .map(part => part.trim()).filter(part => part &&
      !/(?:嗎|吗|係咪|系咪|是否|有冇|有没有|有沒有|幾多|几多|多少|是不是|what|how many|do i|do we|is it|are there)\s*$/iu.test(part) &&
      /(?:仍然|依然|仲係|而家|目前|現在|现在|只(?:係|是|會|会|要|有)|其實|其实|更正|改(?:成|為|为)|預算|预算|想|需要|唔|不(?:需要|會|玩)|\b(?:i|we)\s+(?:have|need|want|prefer)|\b(?:still|currently|now|actually|only|budget|instead)\b)/iu.test(part));
  if (!statements.length) return [];
  const assertion = statements.join(" ").toLowerCase();
  const chineseDigits: Record<string, number> = {
    "零":0,"〇":0,"一":1,"二":2,"兩":2,"两":2,"三":3,"四":4,
    "五":5,"六":6,"七":7,"八":8,"九":9,"十":10,
  };
  const numericMentions = [...assertion.matchAll(/(?<![0-9])\d+(?:\.\d+)?(?![0-9])|[零〇一二兩两三四五六七八九十]+/gu)]
    .map(match => {
      if (/^\d/.test(match[0])) return Number(match[0]);
      const token = match[0];
      if (token === "十") return 10;
      if (token.includes("十")) {
        const [tens, ones] = token.split("十");
        return (tens ? chineseDigits[tens] ?? NaN : 1) * 10 +
          (ones ? chineseDigits[ones] ?? NaN : 0);
      }
      return token.length === 1 ? chineseDigits[token] ?? NaN : NaN;
    }).filter(Number.isFinite);
  const distinctNumerics = [...new Set(numericMentions)];
  const supported = (value: DecisionValue, priorValue: unknown): DecisionValue | undefined => {
    // No replay or provenance change for unchanged values.
    if (JSON.stringify(value) === JSON.stringify(priorValue)) return undefined;
    // When an ASK_FACT declaration mentions several different quantities,
    // the same number could refer to a different entity/field. Require a
    // single unambiguous number; explicit multi-field updates already use the
    // original UPDATE_ITEM reducer instead of this fallback.
    if (typeof value === "number") return distinctNumerics.length === 1 &&
      distinctNumerics[0] === value ? value : undefined;
    if (typeof value === "string") return value.length > 1 &&
      assertion.includes(value.normalize("NFKC").toLowerCase()) ? value : undefined;
    // Negative statements and true/false are often about *different* items.
    // Without field-specific literal identity a boolean/null remains read-only.
    if (!plainDecisionObject(value)) return undefined;
    const old = plainDecisionObject(priorValue) ? priorValue : {};
    const delta: Record<string, DecisionValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) continue;
      const result = supported(child, old[key]);
      if (result !== undefined) delta[key] = result;
    }
    return Object.keys(delta).length ? delta : undefined;
  };
  const oldFacts = plainDecisionObject(previous.customer_constraints.customer_reported_facts)
    ? previous.customer_constraints.customer_reported_facts : {};
  const safeFacts: CommerceSemanticFrame["customer_facts"] = [];
  for (const fact of frame.customer_facts.slice(0, 12)) {
    if (!/^[a-z][a-z0-9_]{0,79}$/i.test(fact.key) ||
      ["__proto__", "prototype", "constructor"].includes(fact.key)) continue;
    const old = (oldFacts as Record<string, unknown>)[fact.key];
    const prior = plainDecisionObject(old) ? old.value : undefined;
    const value = supported(fact.value, prior);
    if (value !== undefined) safeFacts.push({ key: fact.key, value });
  }
  if (!safeFacts.length) return [];
  return semanticFrameToStateEvents({ ...frame, operation: "UPDATE_ITEM", customer_facts: safeFacts,
    entities: [], additive: false, customer_correction: false },
    previous, [], sourceMessageId, occurredAt)
    .filter(event => event.type === "SET_CUSTOMER_CONSTRAINT" && event.key === "customer_reported_facts");
}

export function semanticFrameToStateEvents(
  frame: CommerceSemanticFrame | null | undefined,
  previous: ConversationCommerceState,
  hints: CommerceTurnEntityHint[],
  sourceMessageId: string,
  occurredAt?: string | null,
): CommerceStateEvent[] {
  // Defense in depth: ambiguous or low-confidence semantic interpretation is read-only.
  // The canonical normalizer also forces NO_STATE_CHANGE for ambiguity, but the
  // deterministic adapter independently refuses mutations so model output can never
  // advance commerce state merely by claiming an operation.
  if (!frame || frame.confidence < 0.62 || frame.ambiguity.is_ambiguous) {
    return [];
  }
  const p = provenance(sourceMessageId, occurredAt);
  const events: CommerceStateEvent[] = [];
  // Generic customer background/requirements have a canonical owner even when
  // there is no purchasable entity. Use the existing constraint event/CAS path,
  // keeping typed values and server provenance, never merchant authority.
  const customerFacts=frame.customer_facts ?? [];
  if(frame.operation!=="NO_STATE_CHANGE" && customerFacts.length) {
    const old=previous.customer_constraints.customer_reported_facts;
    const facts:Record<string,unknown>=old && typeof old==="object" && !Array.isArray(old) ? {...old as Record<string,unknown>} : {};
    for (const fact of customerFacts) {
      if (["__proto__", "prototype", "constructor"].includes(fact.key)) continue;
      const previousFact = facts[fact.key];
      const previousValue = previousFact && typeof previousFact === "object" && !Array.isArray(previousFact)
        ? (previousFact as Record<string, unknown>).value : undefined;
      // A partial correction to a nested customer preference must not erase
      // unrelated previously asserted fields (including explicit false/zero).
      const value = plainDecisionObject(previousValue) && plainDecisionObject(fact.value)
        ? mergeDecisionContext(previousValue, fact.value) : fact.value;
      facts[fact.key] = { value, provenance: p };
    }
    events.push({type:"SET_CUSTOMER_CONSTRAINT",key:"customer_reported_facts",value:facts});
  }

  for (const entity of frame.entities) {
    if (entity.confidence < 0.55) continue;
    const id = resolveHintId(entity, hints, previous);
    if (!id) continue;
    const existing = previous.entities.find((x) => x.entity_id === id);
    const hint = hints.find((x) => x.entity_id === id);

    if (frame.operation === "ADD_ITEM") {
      if (existing && frame.additive && entity.quantity !== null) {
        events.push({
          type: "SET_ENTITY_QUANTITY",
          entity_id: id,
          quantity: existing.quantity + entity.quantity,
          provenance: p,
        });
      } else if (!existing) {
        events.push({
          type: "ENSURE_ENTITY",
          entity: {
            entity_id: id,
            category: hint?.category ?? categoryFor(entity),
            brand: null,
            model: entity.model,
            quantity: entity.quantity ?? 1,
            status: "tentative",
            attributes: {
              ...(hint?.attributes ?? {}),
              semantic_attributes: entity.attributes,
              capabilities: entity.capabilities,
            },
            constraints: {
              ...(hint?.constraints ?? {}),
              ...entity.constraints,
            },
            provenance: p,
          },
        });
      } else if (entity.quantity !== null && !frame.additive) {
        events.push({
          type: "SET_ENTITY_QUANTITY",
          entity_id: id,
          quantity: entity.quantity,
          provenance: p,
        });
      }
    }

    if (
      (frame.operation === "SET_QUANTITY" || frame.customer_correction) &&
      entity.quantity !== null &&
      existing
    ) {
      events.push({
        type: "SET_ENTITY_QUANTITY",
        entity_id: id,
        quantity: entity.quantity,
        provenance: p,
      });
    }

    if (
      (frame.operation === "UPDATE_ITEM" || frame.customer_correction) &&
      existing &&
      frame.operation !== "CANCEL_ITEM" &&
      frame.operation !== "REMOVE_ITEM"
    ) {
      if (Object.keys(entity.attributes).length) {
        events.push({
          type: "SET_ENTITY_ATTRIBUTE",
          entity_id: id,
          key: "semantic_attributes",
          value: mergeDecisionContext(
            existing.attributes.semantic_attributes,
            entity.attributes,
          ),
          provenance: p,
        });
      }
      for (const [key, value] of Object.entries(entity.constraints)) {
        events.push({
          type: "SET_ENTITY_CONSTRAINT",
          entity_id: id,
          key,
          value,
          provenance: p,
        });
      }
    }

    if (
      (frame.operation === "CANCEL_ITEM" ||
        frame.operation === "REMOVE_ITEM") && existing
    ) {
      events.push({
        type: "SET_ENTITY_STATUS",
        entity_id: id,
        status: "cancelled",
        provenance: p,
      });
    }
  }

  if (frame.operation === "REQUEST_QUOTE") {
    events.push({
      type: "SET_CONVERSION",
      patch: { funnel_stage: "quotation", quotation_status: "draft" },
    });
  }
  return events;
}
