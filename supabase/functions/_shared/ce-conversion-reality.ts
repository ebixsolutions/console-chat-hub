/**
 * AI-ABC-B3 — CE Sales / Context conversion-reality binding.
 *
 * This is a read-only adapter over the frozen A1/A2/A3, B1 and B2 contracts.
 * It does not mutate commerce state and it does not create a second scoring
 * model. It binds the exact delivered assistant reply to the current canonical
 * commerce revision, exposes that evidence to CE, and only caps an evaluator
 * result when an existing deterministic guard proves the result overconfident.
 */

import {
  type ConversationCommerceState,
  isConversationCommerceState,
} from "./commerce-state-contract.ts";
import { resolveIndustryProfile } from "./industry-runtime-adapter.ts";
import {
  evaluateB2BeforeCommit,
  type B2CanonicalSnapshot,
  type B2Decision,
} from "./pre-send-conversion-supervisor.ts";

export interface B3Bundle {
  text: string;
  bundle_hash: string;
  transcript_hash: string;
  transcript: Array<{ id: string; content: string }>;
  evaluated_ai_reply: { id: string } | null;
}

export interface B3EvaluatorOutput {
  score: number;
  justification: string;
  evidence: string[];
  grounding_refs: string[];
  recommended_correction: string;
}

export const B3_CONVERSION_REALITY_VERSION = "ai-abc-b3-1.0.0";

export interface CeConversionRealityRow {
  company_id: string;
  revision: number;
  source_message_id: string | null;
  state_hash: string;
  state: ConversationCommerceState;
  updated_at?: string | null;
}

export interface CeConversionRealityQueryResult {
  data: unknown;
  error: unknown;
}

export interface CeConversionRealityQueryBuilder {
  select(columns: string): CeConversionRealityQueryBuilder;
  eq(column: string, value: string): CeConversionRealityQueryBuilder;
  maybeSingle(): Promise<CeConversionRealityQueryResult>;
}

export interface CeConversionRealityDb {
  from(table: string): CeConversionRealityQueryBuilder;
}

export interface CeEvaluatedAssistant {
  id: string;
  metadata?: Record<string, unknown> | null;
}

export interface CeConversionReality {
  version: typeof B3_CONVERSION_REALITY_VERSION;
  conversation_id: string;
  company_id: string;
  revision: number;
  source_message_id: string;
  state_hash: string;
  evaluated_assistant_message_id: string;
  evaluated_assistant_source_message_id: string;
  b2_outcome: "allow";
  b2_lineage: "persisted_reply_source_matches_canonical_revision";
  authority_route: string | null;
  human_controlled: boolean;
  industry_profile: {
    id: string;
    version: string;
    field_keys: string[];
  } | null;
  state: ConversationCommerceState;
}

export type CeConversionRealityLoadResult =
  | { ok: true; reality: CeConversionReality }
  | {
      ok: false;
      code:
        | "CE_B3_COMMERCE_STATE_LOOKUP_FAILED"
        | "CE_B3_COMMERCE_STATE_MISSING"
        | "CE_B3_COMMERCE_STATE_TENANT_MISMATCH"
        | "CE_B3_COMMERCE_STATE_INVALID"
        | "CE_B3_ASSISTANT_LINEAGE_MISSING"
        | "CE_B3_ASSISTANT_SOURCE_STALE";
      detail?: string;
    };

function clean(value: unknown, max = 500): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function finiteRevision(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function boundedState(state: ConversationCommerceState): ConversationCommerceState {
  const clone = structuredClone(state);
  clone.latest_corrections = clone.latest_corrections.slice(-20);
  clone.unresolved_items = clone.unresolved_items.slice(0, 20);
  clone.entities = clone.entities.slice(0, 40);
  clone.quotes = clone.quotes.slice(0, 40);
  clone.installation.items = clone.installation.items.slice(0, 40);
  clone.installation.pending_checks = clone.installation.pending_checks.slice(0, 20);
  return clone;
}

export async function loadCeConversionReality(
  db: CeConversionRealityDb,
  input: {
    conversation_id: string;
    company_id: string;
    conversation_status: string;
    assigned_agent_id?: string | null;
    evaluated_assistant: CeEvaluatedAssistant;
  },
): Promise<CeConversionRealityLoadResult> {
  const { data, error } = await db
    .from("conversation_commerce_state")
    .select("company_id, revision, source_message_id, state_hash, state, updated_at")
    .eq("conversation_id", input.conversation_id)
    .eq("company_id", input.company_id)
    .maybeSingle();
  if (error) return { ok: false, code: "CE_B3_COMMERCE_STATE_LOOKUP_FAILED" };
  if (!isRecord(data)) return { ok: false, code: "CE_B3_COMMERCE_STATE_MISSING" };
  if (clean(data.company_id, 160) !== input.company_id) {
    return { ok: false, code: "CE_B3_COMMERCE_STATE_TENANT_MISMATCH" };
  }

  const revision = finiteRevision(data.revision);
  const sourceMessageId = clean(data.source_message_id, 160);
  const stateHash = clean(data.state_hash, 160);
  if (
    revision === null ||
    !sourceMessageId ||
    !stateHash ||
    !isConversationCommerceState(data.state)
  ) {
    return { ok: false, code: "CE_B3_COMMERCE_STATE_INVALID" };
  }

  const assistantSource = clean(input.evaluated_assistant.metadata?.source_message_id, 160);
  if (!assistantSource) return { ok: false, code: "CE_B3_ASSISTANT_LINEAGE_MISSING" };
  if (assistantSource !== sourceMessageId) {
    return {
      ok: false,
      code: "CE_B3_ASSISTANT_SOURCE_STALE",
      detail: `assistant_source=${assistantSource};state_source=${sourceMessageId}`,
    };
  }

  const state = boundedState(data.state);
  const profile = resolveIndustryProfile(state.current_industry);
  const responseRoute =
    clean(input.evaluated_assistant.metadata?.response_route, 160) ||
    clean(input.evaluated_assistant.metadata?.escalation_rule, 160) ||
    null;
  const status = clean(input.conversation_status, 80).toLowerCase();

  return {
    ok: true,
    reality: {
      version: B3_CONVERSION_REALITY_VERSION,
      conversation_id: input.conversation_id,
      company_id: input.company_id,
      revision,
      source_message_id: sourceMessageId,
      state_hash: stateHash,
      evaluated_assistant_message_id: input.evaluated_assistant.id,
      evaluated_assistant_source_message_id: assistantSource,
      b2_outcome: "allow",
      b2_lineage: "persisted_reply_source_matches_canonical_revision",
      authority_route: responseRoute,
      human_controlled:
        Boolean(input.assigned_agent_id) ||
        ["assigned", "human_control", "resolved", "closed"].includes(status),
      industry_profile: profile
        ? {
            id: profile.id,
            version: profile.version,
            field_keys: profile.schema.fields.map((field) => field.key),
          }
        : null,
      state,
    },
  };
}

export function conversionRealityFingerprint(reality: CeConversionReality): string {
  return stable({
    version: reality.version,
    conversation_id: reality.conversation_id,
    company_id: reality.company_id,
    revision: reality.revision,
    source_message_id: reality.source_message_id,
    state_hash: reality.state_hash,
    evaluated_assistant_message_id: reality.evaluated_assistant_message_id,
    evaluated_assistant_source_message_id: reality.evaluated_assistant_source_message_id,
    b2_outcome: reality.b2_outcome,
    authority_route: reality.authority_route,
    human_controlled: reality.human_controlled,
    industry_profile: reality.industry_profile,
    state: reality.state,
  });
}

export async function bindConversionRealityToBundle<T extends B3Bundle>(
  bundle: T,
  reality: CeConversionReality,
): Promise<T> {
  if (bundle.evaluated_ai_reply?.id !== reality.evaluated_assistant_message_id) {
    throw new Error("CE_B3_ASSISTANT_BUNDLE_MISMATCH");
  }
  const section = [
    "## conversion_reality",
    "authority_priority=canonical_commerce_state>latest_correction>transaction_state>industry_profile>authority_route>grounded_kb>assistant_reply>history",
    stable(reality),
  ].join("\n");
  const marker = "## end\n";
  if (!bundle.text.endsWith(marker)) throw new Error("CE_B3_BUNDLE_END_MISSING");
  const text = `${bundle.text.slice(0, -marker.length)}${section}\n${marker}`;
  const fingerprint = conversionRealityFingerprint(reality);
  return {
    ...bundle,
    text,
    bundle_hash: await sha256Hex(text),
    // CE input identity must change when commerce truth changes even if the
    // transcript bytes do not. Existing CE/job idempotency therefore remains
    // authoritative without a parallel B3 idempotency key.
    transcript_hash: await sha256Hex(`${bundle.transcript_hash}\n${fingerprint}\n`),
  } as T;
}

export async function revalidateCeConversionReality(
  db: CeConversionRealityDb,
  reality: CeConversionReality,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const { data, error } = await db
    .from("conversation_commerce_state")
    .select("company_id, revision, source_message_id, state_hash")
    .eq("conversation_id", reality.conversation_id)
    .eq("company_id", reality.company_id)
    .maybeSingle();
  if (error || !isRecord(data)) return { ok: false, code: "CE_B3_FRESHNESS_READ_FAILED" };
  const same =
    clean(data.company_id, 160) === reality.company_id &&
    finiteRevision(data.revision) === reality.revision &&
    clean(data.source_message_id, 160) === reality.source_message_id &&
    clean(data.state_hash, 160) === reality.state_hash;
  return same ? { ok: true } : { ok: false, code: "CE_B3_COMMERCE_REALITY_STALE" };
}

export interface B3AlignmentSignal {
  decision: B2Decision;
  stage_regression: boolean;
}

const GENERIC_DISCOVERY_QUESTION =
  /(?:what (?:product|item) are you looking for|what would you like to buy|你想(?:搵|找|買|买)(?:咩|什麼|什么)(?:產品|产品|貨品|货品)|有咩可以幫到你|有什么可以帮到你)/i;

export function assessB3Alignment(
  proposedResponse: string,
  reality: CeConversionReality,
  metadata: Record<string, unknown> | null = null,
): B3AlignmentSignal {
  const snapshot: B2CanonicalSnapshot = {
    conversation_id: reality.conversation_id,
    company_id: reality.company_id,
    source_message_id: reality.source_message_id,
    commerce_state_revision: reality.revision,
    commerce_state_source_message_id: reality.source_message_id,
    state: reality.state,
  };
  const decision = evaluateB2BeforeCommit({
    proposed_response: proposedResponse,
    persistence_kind: "ai_reply",
    snapshot,
    metadata,
  });
  const stage = reality.state.conversion.funnel_stage;
  const stageRegression =
    !["discovery", "research"].includes(stage) && GENERIC_DISCOVERY_QUESTION.test(proposedResponse);
  return {
    decision,
    stage_regression: stageRegression,
  };
}

function appendReason(base: string, code: string): string {
  return `${base.trim()} B3 deterministic conversion-reality alignment: ${code}.`
    .trim()
    .slice(0, 2000);
}

/**
 * Never increases a model score. This is a fail-safe alignment cap, not a
 * second evaluator. Detailed semantic judgement remains with the existing CE
 * Sales/Context evaluator, which now receives the canonical reality section.
 */
export function alignB3EvaluatorOutput(
  dimension: "sales" | "context",
  output: B3EvaluatorOutput,
  proposedResponse: string,
  reality: CeConversionReality,
  metadata: Record<string, unknown> | null = null,
): B3EvaluatorOutput {
  const signal = assessB3Alignment(proposedResponse, reality, metadata);
  const codes: string[] = [];
  let cap = 100;
  if (signal.decision.decision === "block") {
    cap = dimension === "context" ? 30 : 40;
    codes.push(signal.decision.code);
  } else if (signal.decision.decision === "indeterminate") {
    cap = 50;
    codes.push(signal.decision.code);
  }
  if (signal.stage_regression) {
    cap = Math.min(cap, dimension === "context" ? 40 : 45);
    codes.push("CE_B3_STAGE_REGRESSION");
  }
  if (codes.length === 0 || output.score <= cap) return output;
  return {
    ...output,
    score: cap,
    justification: appendReason(output.justification, [...new Set(codes)].join("|")),
  };
}
