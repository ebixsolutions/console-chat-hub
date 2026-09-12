import { validateIndustrySchema, type IndustrySchema } from "./industry-schema.ts";

export interface IndustryProfile {
  id: string;
  version: string;
  aliases: readonly string[];
  schema: IndustrySchema;
}

export interface IndustryRegistry {
  resolve(identifier: string | null | undefined): IndustryProfile | null;
  profiles(): readonly IndustryProfile[];
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function createIndustryRegistry(profiles: readonly IndustryProfile[]): IndustryRegistry {
  const entries = new Map<string, IndustryProfile>();
  for (const profile of profiles) {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(profile.id))
      throw new Error(`invalid_industry_id:${profile.id}`);
    if (!/^\d+\.\d+\.\d+$/.test(profile.version))
      throw new Error(`invalid_profile_version:${profile.id}`);
    const validation = validateIndustrySchema(profile.schema);
    if (!validation.valid)
      throw new Error(`invalid_industry_schema:${profile.id}:${validation.errors.join(",")}`);
    if (profile.schema.id !== profile.id)
      throw new Error(`industry_schema_binding_mismatch:${profile.id}`);
    for (const candidate of [profile.id, ...profile.aliases]) {
      const key = normalize(candidate);
      if (!key || entries.has(key)) throw new Error(`duplicate_industry_identifier:${key}`);
      entries.set(key, profile);
    }
  }
  const frozen = Object.freeze([...profiles]);
  return Object.freeze({
    resolve(identifier: string | null | undefined) {
      return identifier ? (entries.get(normalize(identifier)) ?? null) : null;
    },
    profiles() {
      return frozen;
    },
  });
}
