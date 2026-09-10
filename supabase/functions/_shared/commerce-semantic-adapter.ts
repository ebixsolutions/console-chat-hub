import type { CommerceTurnEntityHint } from "./commerce-state-reducer.ts";
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
        attributes: entity.attributes,
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
    const existing = map.get(hint.entity_id);
    if (!existing) {
      map.set(hint.entity_id, hint);
      continue;
    }
    map.set(hint.entity_id, {
      ...existing,
      category: hint.category || existing.category,
      aliases: [...new Set([...(existing.aliases ?? []), ...(hint.aliases ?? [])])],
      quantity: hint.quantity ?? existing.quantity,
      model: hint.model ?? existing.model,
      attributes: { ...(existing.attributes ?? {}), ...(hint.attributes ?? {}) },
      constraints: { ...(existing.constraints ?? {}), ...(hint.constraints ?? {}) },
    });
  }
  return [...map.values()];
}
