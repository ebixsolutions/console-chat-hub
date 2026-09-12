import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import type { CommerceTurnEntityHint } from "./commerce-state-reducer.ts";
import { createIndustryRegistry, type IndustryProfile } from "./industry-agent-registry.ts";
import { validateIndustrySchemaValues } from "./industry-schema.ts";
import {
  HOME_APPLIANCE_CATEGORIES,
  HOME_APPLIANCE_PROFILE_V1,
  HOME_APPLIANCE_ROOMS,
} from "./industry-profiles/home-appliance-v1.ts";

export type IndustryLanguage = "zh-TW" | "zh-CN" | "en";

export const INDUSTRY_AGENT_REGISTRY = createIndustryRegistry([HOME_APPLIANCE_PROFILE_V1]);

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
    (alias) => alias.trim().length >= 2 && lower.includes(alias.trim().toLowerCase()),
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
  const detected = input.texts.some((text) =>
    HOME_APPLIANCE_CATEGORIES.some((category) => matches(text, category.aliases)),
  )
    ? HOME_APPLIANCE_PROFILE_V1
    : null;
  const hasExplicitIdentifier = Boolean(clean(input.industry_identifier));
  const profile = hasExplicitIdentifier ? explicit : detected;
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
        clean(entity.name).toLowerCase().includes(clean(alias).toLowerCase()),
      ),
    );
    if (semanticHint)
      semanticHint.attributes = { ...semanticHint.attributes, industry_fields: values };
  }
  return { industry_id: profile.id, profile, hints: [...hints.values()] };
}

export function industryEntityLabel(entityId: string, language: IndustryLanguage): string | null {
  const [categoryKey, roomKey] = entityId.split(":");
  const category = HOME_APPLIANCE_CATEGORIES.find((item) => item.key === categoryKey);
  if (!category) return null;
  const room = HOME_APPLIANCE_ROOMS.find((item) => item.key === roomKey);
  if (!room) return category.label[language];
  return language === "en"
    ? `${room.label.en} ${category.label.en}`
    : `${room.label[language]}${category.label[language]}`;
}
