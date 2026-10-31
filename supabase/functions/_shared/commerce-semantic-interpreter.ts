import { executionFailure, failureFromError, type ExecutionFailure } from "./execution-failure.ts";
import { callModel } from "./llm-router.ts";
import { sha256 } from "./model-attempt-accounting.ts";
import { getSupabaseAdminKey } from "./supabase-admin-key.ts";
import { requirementMutationText } from "./commerce-state-authority.ts";
import {
  COMMERCE_SEMANTIC_FRAME_VERSION,
  COMMERCE_SEMANTIC_SYSTEM_PROMPT,
  COMMERCE_SEMANTIC_PROVIDER_SCHEMA,
  type SemanticContractRejection,
  type SemanticContractDiagnostic,
  type CommerceSemanticFrame,
  decodeCommerceSemanticWire,
  normalizeCommerceSemanticFrame,
} from "./commerce-semantic-frame.ts";

export const SEMANTIC_CONTEXT_CHAR_LIMIT = 12_000;
export const SEMANTIC_HISTORY_CHAR_LIMIT = 24_000;

export interface CommerceSemanticHistoryTurn {
  role: string;
  content: string;
  id?: string;
  created_at?: string;
}

export interface CommerceSemanticInterpretInput {
  company_id: string;
  conversation_id: string;
  source_message_id: string;
  source_created_at?: string;
  source_content?: string;
  latest: string;
  history?: CommerceSemanticHistoryTurn[];
  /** Server-scoped original customer rows recovered outside the recent window. */
  recovered_history?: CommerceSemanticHistoryTurn[];
  history_recovery?: {context_incomplete:boolean;reason?:string};
  persistent_state_summary?: string | null;
  operation_id?: string;
  /** Server-created admission capability; never taken from a model or message. */
  legacy_authority?: object;
  signal?: AbortSignal;
}

export interface CommerceSemanticInterpretResult {
  frame: CommerceSemanticFrame | null;
  source: "semantic_model" | "none";
  failure_code: string | null;
  failure_stage?: string;
  failure?: ExecutionFailure;
  request_id?: string;
  contract_rejection?: SemanticContractRejection;
  contract_diagnostic?: SemanticContractDiagnostic;
}

function clean(value: unknown, max = 3000): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Produces the bounded customer-authored state context presented to the semantic
 * model. This is context only: the model cannot persist it and the deterministic
 * A1/A2 reducer remains the sole state mutation authority.
 */
export function buildPersistentCommerceStateSummary(
  row: unknown,
  memoryRow?: unknown,
): string | null {
  if (
    (!isRecord(row) || !isRecord(row.state)) &&
    (!isRecord(memoryRow) || !isRecord(memoryRow.memory))
  ) {
    return null;
  }
  row = isRecord(row) && isRecord(row.state) ? row : { revision: 0, state: {} };
  if (!isRecord(row)) return null;
  const revision = typeof row.revision === "number"
    ? row.revision
    : Number(row.revision ?? 0);
  const memory = isRecord(memoryRow) && isRecord(memoryRow.memory) ? memoryRow.memory : null;
  const bounded = {
    revision: Number.isFinite(revision) && revision >= 0 ? revision : 0,
    // Exclude server receipts and duplicated provenance, retaining every
    // customer constraint and the identities needed for unique referent binding.
    state: isRecord(row.state)
      ? {
        current_topic: row.state.current_topic,
        entities: Array.isArray(row.state.entities)
          ? row.state.entities.map((entity) =>
            isRecord(entity)
              ? {
                entity_id: entity.entity_id,
                category: entity.category,
                model: entity.model,
                status: entity.status,
                quantity: entity.quantity,
                attributes: entity.attributes,
                constraints: entity.constraints,
              }
              : entity
          )
          : [],
        customer_constraints: row.state.customer_constraints,
        delivery: row.state.delivery,
        installation: row.state.installation,
      }
      : {},
    ...(memory && Array.isArray(memory.current_customer_facts)
      ? {
        current_customer_facts: memory.current_customer_facts.map((
          fact: unknown,
        ) =>
          isRecord(fact)
            ? {
              key: fact.key,
              value: fact.value,
              source_message_id: fact.source_message_id,
            }
            : fact
        ),
      }
      : {}),
    ...(memory ? {memory_context:{
      revision:isRecord(memoryRow) ? memoryRow.revision ?? memory.memory_revision : memory.memory_revision,
      current_goal:memory.current_goal,
      current_goal_source_message_id:memory.current_goal_source_message_id,
      current_topic:memory.current_topic,
      current_topic_source_message_id:memory.current_topic_source_message_id,
      latest_corrections:memory.latest_corrections,
      open_questions:memory.open_questions,
      question_lifecycle:memory.question_lifecycle,
      question_lifecycle_incomplete:memory.question_lifecycle_incomplete,
      factual_read_anchors:Array.isArray(memory.factual_read_anchors) ? memory.factual_read_anchors.map(anchor => isRecord(anchor) ? {
        source_message_id:anchor.source_message_id,created_at:anchor.created_at,customer_text:anchor.customer_text,
        subjects:anchor.subjects,subject_source_message_ids:anchor.subject_source_message_ids,requested_facts:anchor.requested_facts,
      } : anchor) : [],
      factual_read_anchors_incomplete:memory.factual_read_anchors_incomplete,
      // Identity hints only; prior citations never establish current merchant facts.
      grounded_reference_lineage:memory.grounded_reference_lineage,
    }} : {}),
  };
  try {
    const summary = JSON.stringify(bounded);
    if (summary.length <= SEMANTIC_CONTEXT_CHAR_LIMIT) return summary;
    // Keep complete independently bounded sections when another section is too
    // large. Never clip a fact/value/anchor or present a partial projection as
    // complete. The recovery caller still owns access to original message rows.
    const partial: Record<string,unknown> = {
      revision:bounded.revision,context_incomplete:true,omitted_context:[] as string[],
    };
    const omitted = partial.omitted_context as string[];
    for (const key of ["current_customer_facts","memory_context","state"] as const) {
      if (bounded[key] === undefined) continue;
      partial[key] = bounded[key];
      // Reserve enough room for the fixed omission labels added below.
      if (JSON.stringify(partial).length > SEMANTIC_CONTEXT_CHAR_LIMIT - 100) {
        delete partial[key]; omitted.push(key);
      }
    }
    return JSON.stringify(partial);
  } catch {
    return JSON.stringify({context_incomplete:true});
  }
}

/**
 * Read-only tenant-bound persistent state lookup. If the caller did not already
 * supply a state summary, A3.1 resolves it here before semantic interpretation.
 * Failure is non-blocking: the interpreter can still use bounded conversation
 * history, while deterministic runtime state loading/persistence remains separate.
 */
async function loadPersistentCommerceStateSummary(
  input: CommerceSemanticInterpretInput,
): Promise<string | null> {
  if (input.persistent_state_summary !== undefined) {
    return input.persistent_state_summary && input.persistent_state_summary.length > SEMANTIC_CONTEXT_CHAR_LIMIT
      ? JSON.stringify({context_incomplete:true})
      : clean(input.persistent_state_summary,SEMANTIC_CONTEXT_CHAR_LIMIT) || null;
  }

  const supabaseUrl = clean(Deno.env.get("SUPABASE_URL"), 600).replace(
    /\/$/,
    "",
  );
  if (!supabaseUrl || !input.conversation_id || !input.company_id) return null;

  let adminKey = "";
  try {
    adminKey = getSupabaseAdminKey();
  } catch {
    return null;
  }

  const params = new URLSearchParams({
    select: "revision,state",
    conversation_id: `eq.${input.conversation_id}`,
    company_id: `eq.${input.company_id}`,
    limit: "1",
  });
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromRequest();
  else {
    input.signal?.addEventListener("abort", abortFromRequest, {
      once: true,
    });
  }
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const memoryParams = new URLSearchParams({
      select: "memory",
      conversation_id: `eq.${input.conversation_id}`,
      company_id: `eq.${input.company_id}`,
      limit: "1",
    });
    const options = {
      method: "GET",
      headers: {
        apikey: adminKey,
        Authorization: `Bearer ${adminKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    };
    // Parallel, read-only and identically tenant scoped within the existing timeout.
    const [response, memoryResponse] = await Promise.all([
      fetch(
        `${supabaseUrl}/rest/v1/conversation_commerce_state?${params.toString()}`,
        options,
      ),
      fetch(
        `${supabaseUrl}/rest/v1/conversation_memory_state?${memoryParams.toString()}`,
        options,
      ),
    ]);
    if (!response.ok || !memoryResponse.ok) {
      return JSON.stringify({ context_incomplete: true });
    }
    const [payload, memoryPayload]: unknown[] = await Promise.all([
      response.json(),
      memoryResponse.json(),
    ]);
    if (!Array.isArray(payload) || !Array.isArray(memoryPayload)) {
      return JSON.stringify({ context_incomplete: true });
    }
    return buildPersistentCommerceStateSummary(payload[0], memoryPayload[0]);
  } catch {
    return JSON.stringify({ context_incomplete: true });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromRequest);
  }
}

const fullSemanticText = (value:unknown) => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g," ").trim() : "";

/** Recovery and the provider must agree on which originals are already visible.
 * Keep original row objects (including server metadata) for the caller. */
export function selectSemanticRecentHistory(
  input: Pick<CommerceSemanticInterpretInput,"history"|"latest"|"source_message_id">,
): CommerceSemanticHistoryTurn[] {
  const latest = fullSemanticText(input.latest);
  return (input.history ?? []).filter((row,index) => {
    const content = fullSemanticText(row.content);
    if (!content) return false;
    // A business projection or staff query can share the source ID but differ
    // from the actual customer content. That original must remain available.
    return !(content === latest && (row.id === input.source_message_id || index === 0 && !row.id));
  }).slice(0,12);
}

function buildUser(
  input: CommerceSemanticInterpretInput,
  persistentStateSummary: string | null,
): string | null {
  const fullText = fullSemanticText;
  const latest = fullText(input.latest);
  const prior = selectSemanticRecentHistory(input)
    .reverse()
    .map(x => ({message_id:x.id ?? null,created_at:x.created_at ?? null,role:String(x.role || "unknown"),content:fullText(x.content)}));
  const seen = new Map(prior.filter(row => row.message_id).map(row => [row.message_id!,row.content]));
  const recovered: {message_id:string;created_at:string|null;role:string;content:string}[] = [];
  for (const row of input.recovered_history ?? []) {
    const content = fullText(row.content);
    if (!row.id || !content || !["visitor","customer","user"].includes(row.role)) return null;
    if (row.id === input.source_message_id) continue;
    if (seen.has(row.id)) {
      if (seen.get(row.id) !== content) return null;
      continue;
    }
    seen.set(row.id,content);
    recovered.push({message_id:row.id,created_at:row.created_at ?? null,role:row.role,content});
  }
  const priorText = JSON.stringify(prior), recoveredText = JSON.stringify(recovered);
  // Preserve complete selected originals, including constraints after character
  // 800. Oversized context is an observable input failure before model dispatch,
  // never a silently clipped customer requirement or a copied partial message.
  if (priorText.length + recoveredText.length > SEMANTIC_HISTORY_CHAR_LIMIT) return null;
  return [
    `Semantic frame version: ${COMMERCE_SEMANTIC_FRAME_VERSION}`,
    `Latest customer turn: ${latest}`,
    prior.length
      ? `Recent conversation turns (oldest to newest; source-bound discourse, not merchant evidence):\n${priorText}`
      : "Recent conversation turns: none",
    recovered.length
      ? `Recovered earlier original customer messages (server-scoped, independent of the recent window):\n${recoveredText}`
      : "Recovered earlier original customer messages: none",
    input.history_recovery?.context_incomplete
      ? "History recovery: context_incomplete=true. A missing or non-unique older reference remains unresolved; do not invent it."
      : "History recovery: no reported incomplete read.",
    persistentStateSummary
      ? `Persistent commerce and Memory context (customer-authored state and read references; do not treat as external facts):\n${
        clean(
          persistentStateSummary,
          SEMANTIC_CONTEXT_CHAR_LIMIT,
        )
      }`
      : "Persistent commerce state summary: none",
    "Return one compact current-turn delta, not a state snapshot.",
  ].join("\n\n");
}

export async function interpretCommerceSemantics(
  input: CommerceSemanticInterpretInput,
): Promise<CommerceSemanticInterpretResult> {
  const latest = clean(input.latest, 1600);
  if (!latest) return { frame: null, source: "none", failure_code: null };
  if (
    String(input.latest).normalize("NFKC").replace(/\s+/g, " ").trim().length >
      1600
  ) {
    return {
      frame: null,
      source: "none",
      failure_code: "SEMANTIC_INPUT_LIMIT",
      failure_stage: "input_limit",
    };
  }

  const persistentStateSummary = await loadPersistentCommerceStateSummary(
    input,
  );
  const user = buildUser(input,persistentStateSummary);
  if (user === null) return {frame:null,source:"none",failure_code:"SEMANTIC_INPUT_LIMIT",failure_stage:"input_context"};
  const operationId = input.operation_id ?? `commerce-semantic:${input.source_message_id}`;

  // Hosted 21745026: outer schema-valid JSON contained an invalid delta_json
  // document. Generate native JSON once, keeping dynamic customer values native.
  // Do not repair malformed output or retry paid inference. Strict decoding and
  // the unchanged canonical validator still precede every proposed state event.
  let result;
  try { result = await callModel({
    purpose: "evaluation",
    system: COMMERCE_SEMANTIC_SYSTEM_PROMPT,
    user,
    maxTokens: 4096,
    maxProviderAttempts: 1,
    semanticSource: input.source_created_at ? {messageId:input.source_message_id,createdAt:input.source_created_at,contentSha256:await sha256(input.source_content ?? input.latest)} : undefined,
    operationId,
    legacyAuthority:input.legacy_authority,
    companyId: input.company_id,
    conversationId: input.conversation_id,
    tag: "commerce-semantic-interpreter",
    responseFormat: "json",
    responseSchema: COMMERCE_SEMANTIC_PROVIDER_SCHEMA,
    // The small provider grammar constrains native value types. The server
    // separately enforces the complete semantic vocabulary and canonical bounds.
    thinkingBudget: 0,
    signal: input.signal,
  }); } catch (error) {
    const failure = failureFromError(error,{request_id:operationId,source_message_id:input.source_message_id});
    return {frame:null,source:"none",failure_code:failure.code,failure_stage:failure.stage,failure};
  }

  if (!result.ok) {
    return {
      frame: null,
      source: "none",
      failure_code: result.failure?.code ?? result.code,
      failure_stage: result.invalid_output_reason ?? result.failure?.stage ?? executionFailure(result.code).stage,
      failure: executionFailure(result.failure?.code ?? result.code,{stage:result.failure?.stage,request_id:result.request_id,source_message_id:input.source_message_id,http_status:result.status}),
      request_id: result.request_id,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return {
      frame: null,
      source: "none",
      failure_code: "LLM_INVALID_OUTPUT",
      failure_stage: "semantic_json",
      failure: executionFailure("LLM_INVALID_OUTPUT",{stage:"decode",request_id:result.request_id,source_message_id:input.source_message_id}),
      request_id: result.request_id,
    };
  }
  let contractRejection: SemanticContractRejection | undefined;
  let contractDiagnostic: SemanticContractDiagnostic | undefined;
  const rejected = (reason: SemanticContractRejection, diagnostic?: SemanticContractDiagnostic) => {
    contractRejection ??= reason;
    contractDiagnostic ??= diagnostic;
  };
  const frame = normalizeCommerceSemanticFrame(
    decodeCommerceSemanticWire(parsed, rejected), rejected,
  );
  if (!frame) {
    return {
      frame: null,
      source: "none",
      failure_code: "LLM_INVALID_OUTPUT",
      failure_stage: "semantic_contract",
      contract_rejection: contractRejection,
      contract_diagnostic: contractDiagnostic,
      failure: executionFailure("LLM_INVALID_OUTPUT",{stage:"canonical_validation",request_id:result.request_id,source_message_id:input.source_message_id}),
      request_id: result.request_id,
    };
  }
  if ((frame.demands ?? []).some(demand => !latest.includes(demand.source_quote))) {
    return {
      frame:null,source:"none",failure_code:"LLM_INVALID_OUTPUT",failure_stage:"semantic_source_binding",
      contract_rejection:"canonical_demand_source_quote",
      contract_diagnostic:{container:"wire_nodes",stage:"canonical_vocabulary",node_count:0,field_class:"demand_source_quote",reason:"field"},
      failure:executionFailure("LLM_INVALID_OUTPUT",{stage:"canonical_validation",request_id:result.request_id,source_message_id:input.source_message_id}),
      request_id:result.request_id,
    };
  }
  // A semantic lifecycle label is only a proposal. An old numeric requirement
  // being withdrawn cannot authorize cancellation of its commerce entity.
  if (
    ["CANCEL_ITEM", "REMOVE_ITEM"].includes(frame.operation) &&
    requirementMutationText(input.latest) !== input.latest
  ) {
    return {
      frame: null,
      source: "none",
      failure_code: "LLM_INVALID_OUTPUT",
      failure_stage: "requirement_lifecycle_conflict",
      failure: executionFailure("LLM_INVALID_OUTPUT",{stage:"canonical_validation",request_id:result.request_id,source_message_id:input.source_message_id}),
      request_id: result.request_id,
    };
  }
  return { frame, source: "semantic_model", failure_code: null };
}
