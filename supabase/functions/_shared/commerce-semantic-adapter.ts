import type { ConversationCommerceState, CommerceProvenance } from "./commerce-state-contract.ts";
import type { CommerceStateEvent, CommerceTurnEntityHint } from "./commerce-state-reducer.ts";
import type { CommerceSemanticEntity, CommerceSemanticFrame } from "./commerce-semantic-frame.ts";

function clean(value: unknown, max = 200): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function slugify(raw: string): string {
  return clean(raw, 160).toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function categoryFor(entity: CommerceSemanticEntity): string {
  if (entity.category_hint) return clean(entity.category_hint, 80) || "generic_product";
  switch (entity.kind) {
    case "digital_good": return "digital_good";
    case "service": return "service";
    case "rental": return "rental";
    case "subscription": return "subscription";
    case "ticket": return "ticket";
    case "custom_item": return "custom_item";
    case "b2b_product": return "b2b_product";
    case "physical_product": return "generic_product";
    default: return "generic_item";
  }
}

function entityId(entity: CommerceSemanticEntity): string {
  const explicit = clean(entity.entity_ref, 120);
  if (explicit && !/^(?:semantic|current|prior|item|entity):?\d*$/i.test(explicit)) {
    return explicit.startsWith("generic:") ? explicit : `generic:${slugify(explicit)}`;
  }
  return `generic:${slugify(entity.name) || "item"}`;
}

export function semanticFrameToEntityHints(frame: CommerceSemanticFrame | null | undefined): CommerceTurnEntityHint[] {
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
      aliases: [...new Set([entity.name, entity.entity_ref, entity.sku ?? "", entity.model ?? ""].map((x) => clean(x, 160)).filter(Boolean))],
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
    const semanticAliases = (hint.aliases ?? []).map((x) => clean(x).toLowerCase()).filter(Boolean);
    const compatible = [...map.values()].find((candidate) => {
      const aliases = [candidate.entity_id, candidate.category, ...(candidate.aliases ?? [])]
        .map((x) => clean(x).toLowerCase()).filter(Boolean);
      return semanticAliases.some((a) => aliases.some((b) => a === b || a.includes(b) || b.includes(a)));
    });
    const key = compatible?.entity_id ?? hint.entity_id;
    const existing = map.get(key);
    const normalized = compatible ? { ...hint, entity_id: compatible.entity_id, category: compatible.category } : hint;
    if (!existing) {
      map.set(key, normalized);
      continue;
    }
    map.set(key, {
      ...existing,
      aliases: [...new Set([...(existing.aliases ?? []), ...(normalized.aliases ?? [])])],
      quantity: normalized.quantity ?? existing.quantity,
      model: normalized.model ?? existing.model,
      attributes: { ...(existing.attributes ?? {}), ...(normalized.attributes ?? {}) },
      constraints: { ...(existing.constraints ?? {}), ...(normalized.constraints ?? {}) },
    });
  }
  return [...map.values()];
}

function provenance(sourceMessageId: string, occurredAt?: string | null): CommerceProvenance {
  return { source_type: "customer", source_message_id: sourceMessageId, recorded_at: occurredAt ?? null };
}

function activeEntities(state: ConversationCommerceState) {
  return state.entities.filter((x) => x.status !== "cancelled" && x.status !== "deferred");
}

function resolveHintId(entity: CommerceSemanticEntity, hints: CommerceTurnEntityHint[], previous: ConversationCommerceState): string | null {
  const wanted = [entity.name, entity.entity_ref, entity.sku ?? "", entity.model ?? ""]
    .map((x) => clean(x).toLowerCase()).filter(Boolean);
  const hinted = hints.find((hint) => {
    const aliases = [hint.entity_id, hint.category, ...(hint.aliases ?? [])]
      .map((x) => clean(x).toLowerCase()).filter(Boolean);
    return wanted.some((a) => aliases.some((b) => a === b || a.includes(b) || b.includes(a)));
  });
  if (hinted) return hinted.entity_id;
  const direct = entityId(entity);
  if (previous.entities.some((x) => x.entity_id === direct)) return direct;
  const active = activeEntities(previous);
  if (active.length === 1 && entity.confidence >= 0.75) return active[0].entity_id;
  return direct;
}

export function semanticFrameToStateEvents(
  frame: CommerceSemanticFrame | null | undefined,
  previous: ConversationCommerceState,
  hints: CommerceTurnEntityHint[],
  sourceMessageId: string,
  occurredAt?: string | null,
): CommerceStateEvent[] {
  if (!frame || frame.confidence < 0.62) return [];
  const p = provenance(sourceMessageId, occurredAt);
  const events: CommerceStateEvent[] = [];

  for (const entity of frame.entities) {
    if (entity.confidence < 0.55) continue;
    const id = resolveHintId(entity, hints, previous);
    if (!id) continue;
    const existing = previous.entities.find((x) => x.entity_id === id);
    const hint = hints.find((x) => x.entity_id === id);

    if (frame.operation === "ADD_ITEM") {
      if (existing && frame.additive && entity.quantity !== null) {
        events.push({ type: "SET_ENTITY_QUANTITY", entity_id: id, quantity: existing.quantity + entity.quantity, provenance: p });
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
            attributes: { ...(hint?.attributes ?? {}), semantic_attributes: entity.attributes, capabilities: entity.capabilities },
            constraints: { ...(hint?.constraints ?? {}), ...entity.constraints },
            provenance: p,
          },
        });
      } else if (entity.quantity !== null && !frame.additive) {
        events.push({ type: "SET_ENTITY_QUANTITY", entity_id: id, quantity: entity.quantity, provenance: p });
      }
    }

    if ((frame.operation === "SET_QUANTITY" || frame.customer_correction) && entity.quantity !== null && existing) {
      events.push({ type: "SET_ENTITY_QUANTITY", entity_id: id, quantity: entity.quantity, provenance: p });
    }

    if (frame.operation === "UPDATE_ITEM" && existing) {
      for (const [key, value] of Object.entries(entity.attributes)) {
        events.push({ type: "SET_ENTITY_ATTRIBUTE", entity_id: id, key, value, provenance: p });
      }
      for (const [key, value] of Object.entries(entity.constraints)) {
        events.push({ type: "SET_ENTITY_CONSTRAINT", entity_id: id, key, value, provenance: p });
      }
    }

    if ((frame.operation === "CANCEL_ITEM" || frame.operation === "REMOVE_ITEM") && existing) {
      events.push({ type: "SET_ENTITY_STATUS", entity_id: id, status: "cancelled", provenance: p });
    }
  }

  if (frame.operation === "REQUEST_QUOTE") {
    events.push({ type: "SET_CONVERSION", patch: { funnel_stage: "quotation", quotation_status: "draft" } });
  }
  return events;
}
