import { validateIndustrySchema, type IndustrySchema } from "./industry-schema.ts";

export interface IndustryProfile {
  id: string;
  version: string;
  aliases: readonly string[];
  schema: IndustrySchema;
  category_bindings?: readonly { key: string; aliases: readonly string[] }[];
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

/** Match an authoritative label, not a substring inside another identifier.
 * ASCII labels use token boundaries; CJK labels retain normal unspaced usage.
 * No taxonomy, inference, tenant lookup or state mutation occurs here.
 */
export function matchesReferenceLabel(text: string, label: string): boolean {
  const value=text.normalize("NFKC").toLowerCase();
  const key=label.normalize("NFKC").trim().toLowerCase();
  if(key.length<2) return false;
  let from=0;
  while(from<=value.length-key.length){
    const at=value.indexOf(key,from);if(at<0)return false;
    const ascii=(c:string)=>/[a-z0-9_-]/i.test(c);
    const left=!ascii(key[0]) || at===0 || !ascii(value[at-1]);
    const end=at+key.length;
    const right=!ascii(key[key.length-1]) || end===value.length || !ascii(value[end]);
    if(left&&right)return true;
    from=at+1;
  }
  return false;
}
