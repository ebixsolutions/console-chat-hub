import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import { unresolvedScopedQuantityCandidate, type ContextualCandidate } from "./contextual-customer-update.ts";
import type { CustomerJourneySignal } from "./customer-journey-orchestration.ts";
import type { CommerceTurnEntityHint } from "./commerce-state-reducer.ts";
import { createIndustryRegistry, matchesReferenceLabel, type IndustryProfile } from "./industry-agent-registry.ts";
import { validateIndustrySchemaValues } from "./industry-schema.ts";
import {
  HOME_APPLIANCE_CATEGORIES,
  HOME_APPLIANCE_PROFILE_V1,
  HOME_APPLIANCE_ROOMS,
  homeApplianceCustomerJourneySignal,
  homeApplianceContextualCandidate,
} from "./industry-profiles/home-appliance-v1.ts";

export type IndustryLanguage = "zh-TW" | "zh-CN" | "en";

export const INDUSTRY_AGENT_REGISTRY = createIndustryRegistry([HOME_APPLIANCE_PROFILE_V1]);

export function resolveIndustryContextualCandidate(input: {
  text: string;
  history: readonly string[];
  state: ConversationCommerceState;
  language: IndustryLanguage;
}): ContextualCandidate | null {
  const profile = resolveIndustryRuntime({
    texts: [input.text, ...input.history],
    industry_identifier: input.state.current_industry,
  }).profile;
  if (!profile) return unresolvedScopedQuantityCandidate(input);
  if (profile.id !== HOME_APPLIANCE_PROFILE_V1.id) return null;
  return homeApplianceContextualCandidate(input);
}

/** A historical industry is not a licence to mutate that industry's state on
 * a later topic. Use the validated current-turn frame before restoring any
 * implicit industry journey. Current-turn explicit product references remain
 * authoritative; absent or low-confidence frames retain the existing safe
 * scoped-observation contract in the industry profile. */
export function resolveIndustryCustomerJourney(input: {
  text: string;
  state: ConversationCommerceState;
  language: IndustryLanguage;
  semantic_frame?: CommerceSemanticFrame | null;
}): CustomerJourneySignal | null {
  const current = input.semantic_frame;
  if (current && current.confidence >= 0.72 &&
      current.ambiguity.is_ambiguous === false &&
      typeof current.topic === "string" && current.topic.trim()) {
    const newTopic = clean(current.topic).toLowerCase();
    const historical = clean(input.state.current_topic).toLowerCase();
    const explicitAppliance = HOME_APPLIANCE_CATEGORIES.some(category =>
      category.aliases.some(alias => matchesReferenceLabel(input.text, alias)));
    const semanticAppliance = HOME_APPLIANCE_CATEGORIES.some(category =>
      category.key === newTopic || category.aliases.some(alias =>
        matchesReferenceLabel(newTopic, alias)));
    if (historical && newTopic !== historical && !semanticAppliance &&
        !explicitAppliance) return null;
  }
  const profile = resolveIndustryRuntime({
    texts: [input.text],
    industry_identifier: input.state.current_industry,
  }).profile;
  // An established single customer-owned AC referent may be explicitly revisited.
  // This is retained-state compatibility, NOT word-based profile inference.
  const selected = input.state.entities.filter(entity =>
    entity.category === "air_conditioner" &&
    entity.status !== "cancelled" && entity.status !== "deferred");
  const topic = clean(input.semantic_frame?.topic).toLowerCase();
  const returning = !clean(input.state.current_industry) &&
    topic === "air_conditioner" &&
    clean(input.state.current_topic).toLowerCase() === "air_conditioner" &&
    input.semantic_frame !== null && input.semantic_frame !== undefined &&
    input.semantic_frame.confidence >= 0.72 &&
    input.semantic_frame.ambiguity.is_ambiguous === false &&
    selected.length === 1 && selected[0].provenance.source_type === "customer" &&
    HOME_APPLIANCE_CATEGORIES.some(category => category.key === "air_conditioner" &&
      category.aliases.some(alias => matchesReferenceLabel(input.text, alias)));
  // An explicit customer-authored purchase/selection GOAL may initialize a
  // prospective research entity without selecting an optional industry profile.
  // A bare product mention, factual question or inferred model output cannot.
  const semanticAdmitted = Boolean(current && current.confidence >= 0.72 &&
    current.ambiguity.is_ambiguous === false &&
    (current.operation === "ADD_ITEM" ||
      current.operation === "ASK_FACT" && current.intent === "customer_guidance"));
  const sourceGoal = /(?:我要.{0,32}(?:選購|选购|購買|购买|買|买|挑選|挑选)|我想.{0,32}(?:換|换|買|买|選購|选购|揀|选)|想.{0,32}(?:換|换|買|买|選購|选购|揀|选)|(?:i\s+(?:want|need|plan)\s+to\s+)?(?:buy|replace|shop\s+for)\b)/iu.test(input.text);
  const explicitCategories = HOME_APPLIANCE_CATEGORIES.filter(category =>
    category.aliases.some(alias => matchesReferenceLabel(input.text,alias)));
  const newCustomerGoal = !clean(input.state.current_industry) &&
    !input.state.entities.some(entity => entity.status !== "cancelled" &&
      entity.status !== "deferred") &&
    semanticAdmitted && sourceGoal && explicitCategories.length === 1 &&
    !/(?:有冇貨|有没有货|幾錢|几钱|現價|现价|庫存|库存|in\s+stock|price\b|cost\b|how\s+much|取消|cancel|defer)/iu.test(input.text);
  if ((!profile || profile.id !== HOME_APPLIANCE_PROFILE_V1.id) &&
      !returning && !newCustomerGoal) return null;
  const originalJourney = homeApplianceCustomerJourneySignal(input);
  if (originalJourney || !newCustomerGoal) return originalJourney;
  // A named first goal without room measurements must still remain
  // prospective; never make a suitability, order, booking or payment claim.
  return {
    category: explicitCategories[0].key,
    objective: "select_product",
    journey_stage: "discovery",
    collected: [],
    missing: ["usage_and_space"],
    response_intent: "request_highest_value_missing_information",
    reply: input.language === "en"
      ? "I can help compare options. What is the intended use and space or other key requirements? Suitability still needs current verified information."
      : input.language === "zh-CN"
      ? "可以先按用途和实际空间比较。请提供各处的面积或关键要求，具体适用性仍需核实。"
      : "可以先按用途同實際空間比較。請提供各處面積或關鍵要求，具體適用性仍要核實。",
    category_source: "explicit",
  };
}

export interface IndustryRuntimeResolution {
  industry_id: string | null;
  profile: IndustryProfile | null;
  hints: CommerceTurnEntityHint[];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
}

function matches(text: string, aliases: readonly string[]): boolean {
  const lower = clean(text).toLowerCase();
  return aliases.some(
    (alias) => matchesReferenceLabel(lower,alias),
  );
}

export function resolveIndustryProfile(
  identifier: string | null | undefined,
): IndustryProfile | null {
  return INDUSTRY_AGENT_REGISTRY.resolve(identifier);
}

export function resolveIndustryRuntime(input: {
  texts: readonly string[];
  semantic_frame?: CommerceSemanticFrame | null;
  industry_identifier?: string | null;
}): IndustryRuntimeResolution {
  const explicit = INDUSTRY_AGENT_REGISTRY.resolve(input.industry_identifier);
  // D4-3: a product word is not a server-authorized industry/profile choice.
  // Optional vocabulary activates only with an explicit trusted identifier.
  const hasExplicitIdentifier = Boolean(clean(input.industry_identifier));
  const profile = hasExplicitIdentifier ? explicit : null;
  if (!profile) return { industry_id: null, profile: null, hints: [] };

  const hints = new Map<string, CommerceTurnEntityHint>();
  for (const text of input.texts) {
    const categories = HOME_APPLIANCE_CATEGORIES.filter((category) =>
      matches(text, category.aliases),
    );
    const rooms = HOME_APPLIANCE_ROOMS.filter((room) => matches(text, room.aliases));
    for (const category of categories) {
      for (const room of rooms.length ? rooms : [null]) {
        const entityId = `${category.key}:${room?.key ?? "unscoped"}`;
        hints.set(entityId, {
          entity_id: entityId,
          category: category.key,
          aliases: [...category.aliases, ...(room?.aliases ?? [])],
          attributes: {
            industry_profile_id: profile.id,
            industry_profile_version: profile.version,
          },
        });
      }
    }
  }

  // Validate only explicitly supplied semantic fields. Missing optional facts stay
  // absent so the industry layer can never invent product or policy state.
  for (const entity of input.semantic_frame?.entities ?? []) {
    const values: Record<string, unknown> = {};
    const candidate = {
      product: entity.name,
      model: entity.model,
      ...entity.attributes,
      ...entity.constraints,
    };
    for (const field of profile.schema.fields) {
      const value = candidate[field.key as keyof typeof candidate];
      if (value !== undefined && value !== null) values[field.key] = value;
    }
    if (!validateIndustrySchemaValues(profile.schema, values).valid) continue;
    const semanticHint = [...hints.values()].find((hint) =>
      (hint.aliases ?? []).some((alias) =>
        matchesReferenceLabel(clean(entity.name),clean(alias)),
      ),
    );
    if (semanticHint)
      semanticHint.attributes = { ...semanticHint.attributes, industry_fields: values };
  }
  return { industry_id: profile.id, profile, hints: [...hints.values()] };
}

export function industryEntityLabel(entityId: string, language: IndustryLanguage): string | null {
  const [categoryKey, roomKey] = entityId.split(":");
  const category = HOME_APPLIANCE_CATEGORIES.find((item) => item.key === categoryKey ||
    item.aliases.some(alias => clean(alias).toLowerCase() === clean(categoryKey).toLowerCase()));
  if (!category) return null;
  const room = HOME_APPLIANCE_ROOMS.find((item) => item.key === roomKey);
  if (!room) return category.label[language];
  return language === "en"
    ? `${room.label.en} ${category.label.en}`
    : `${room.label[language]}${category.label[language]}`;
}

/** Fallback realization only: a canonical explicit unit remains the caller's authority. */
export function industryEntityQuantityUnit(
  entityId: string, language: IndustryLanguage, quantity: number,
): string | null {
  const categoryKey = entityId.split(":")[0];
  if (!HOME_APPLIANCE_CATEGORIES.some((category) => category.key === categoryKey ||
    category.aliases.some(alias => clean(alias).toLowerCase() === clean(categoryKey).toLowerCase()))) return null;
  return language === "en" ? (quantity === 1 ? "unit" : "units") : "部";
}
