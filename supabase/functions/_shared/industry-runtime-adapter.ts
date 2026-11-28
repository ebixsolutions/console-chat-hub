/** Phase 1 has NO industry, for any tenant, input, legacy state or caller.
 * Historical metadata is inert. The optional profile registry belongs to a
 * separately authorised future phase, not to the customer-service call path. */
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import { unresolvedScopedQuantityCandidate, type ContextualCandidate } from "./contextual-customer-update.ts";
import type { CustomerJourneySignal } from "./customer-journey-orchestration.ts";
import type { CommerceTurnEntityHint } from "./commerce-state-reducer.ts";
import type { IndustryProfile } from "./industry-agent-registry.ts";
export type IndustryLanguage = "zh-TW" | "zh-CN" | "en";
export const INDUSTRY_AGENT_REGISTRY = Object.freeze({resolve: (_id: string | null | undefined): IndustryProfile | null => null, profiles: (): readonly IndustryProfile[] => []});
export function resolveIndustryContextualCandidate(input: {
  text: string; history: readonly string[]; state: ConversationCommerceState; language: IndustryLanguage;
}): ContextualCandidate | null { return unresolvedScopedQuantityCandidate(input); }
export function resolveIndustryCustomerJourney(_input: {
  text: string; state: ConversationCommerceState; language: IndustryLanguage;
  semantic_frame?: CommerceSemanticFrame | null;
}): CustomerJourneySignal | null { return null; }
export interface IndustryRuntimeResolution {
  industry_id: string | null; profile: IndustryProfile | null; hints: CommerceTurnEntityHint[];
}
export function resolveIndustryProfile(_id: string | null | undefined): IndustryProfile | null { return null; }
export function resolveIndustryRuntime(_input: {
  texts: readonly string[]; semantic_frame?: CommerceSemanticFrame | null; industry_identifier?: string | null;
}): IndustryRuntimeResolution { return {industry_id:null,profile:null,hints:[]}; }
export function industryEntityLabel(_entityId: string, _language: IndustryLanguage): string | null { return null; }
export function industryEntityQuantityUnit(_entityId: string, _language: IndustryLanguage, _quantity: number): string | null { return null; }
