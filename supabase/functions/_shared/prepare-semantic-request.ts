import {
  buildPersistentCommerceStateSummary,
  interpretCommerceSemantics,
  selectSemanticRecentHistory,
  type CommerceSemanticHistoryTurn,
  type CommerceSemanticInterpretResult,
} from "./commerce-semantic-interpreter.ts";
import { compareMessageChronology, recoverSemanticHistory } from "./semantic-history-recovery.ts";
import {
  isCanonicalConversationMemory,
  type CanonicalConversationMemory,
  type MemoryHistoryRow,
} from "./conversation-long-memory.ts";
import {
  isConversationCommerceState,
  type ConversationCommerceState,
} from "./commerce-state-contract.ts";

type ReadClient = Parameters<typeof recoverSemanticHistory>[0];

export interface PrepareSemanticRequestInput {
  company_id: string;
  conversation_id: string;
  source_message_id: string;
  source_created_at: string;
  source_content?: string;
  latest: string;
  recent_history: MemoryHistoryRow[];
  operation_id?: string;
  legacy_authority?: object;
  signal?: AbortSignal;
}

export interface PreparedSemanticRequest {
  semantic: CommerceSemanticInterpretResult;
  history: MemoryHistoryRow[];
  memory: CanonicalConversationMemory | null;
  commerce: ConversationCommerceState | null;
  recovery: Awaited<ReturnType<typeof recoverSemanticHistory>>;
}

/** One read-only entrance for generation and conversation-mode Assist. The
 * source message bounds context; neither stored answers nor this model call
 * authorize a state mutation or a merchant claim. */
export async function prepareSemanticRequest(
  client: ReadClient,
  input: PrepareSemanticRequestInput,
): Promise<PreparedSemanticRequest> {
  const boundary = {id: input.source_message_id, created_at: input.source_created_at};
  const recent = input.recent_history.filter(row => {
    const scoped = row as MemoryHistoryRow & {conversation_id?:string; is_recalled?:boolean};
    return scoped.conversation_id === input.conversation_id && scoped.is_recalled === false &&
      typeof row.id === "string" && typeof row.created_at === "string" &&
      Number.isFinite(Date.parse(row.created_at)) &&
      compareMessageChronology({id:row.id,created_at:row.created_at}, boundary) <= 0;
  });
  const presentedHistory = selectSemanticRecentHistory({
    history: recent as CommerceSemanticHistoryTurn[], latest: input.latest,
    source_message_id: input.source_message_id,
  });
  // One shared deadline for the read-only context stage; no extra inference or retry.
  const contextSignal = AbortSignal.any([
    AbortSignal.timeout(3_000), ...(input.signal ? [input.signal] : []),
  ]);
  const reads = await Promise.allSettled([
    client.from("conversation_memory_state")
      .select("conversation_id,company_id,source_message_id,revision,memory")
      .eq("conversation_id", input.conversation_id)
      .eq("company_id", input.company_id).abortSignal(contextSignal).maybeSingle(),
    client.from("conversation_commerce_state")
      .select("conversation_id,company_id,source_message_id,revision,state")
      .eq("conversation_id", input.conversation_id)
      .eq("company_id", input.company_id).abortSignal(contextSignal).maybeSingle(),
  ]);
  const memoryRead = reads[0].status === "fulfilled" ? reads[0].value : null;
  const commerceRead = reads[1].status === "fulfilled" ? reads[1].value : null;
  const memoryRow = !memoryRead?.error ? memoryRead?.data ?? null : null;
  const commerceRow = !commerceRead?.error ? commerceRead?.data ?? null : null;
  const recovery = await recoverSemanticHistory(client, {
    ...input,
    // Recovery must know the actual model window, not all 50 rows kept for downstream consumers.
    recent_history: presentedHistory,
    signal: contextSignal,
    memory: memoryRow,
    requested_source_message_ids: typeof commerceRow?.source_message_id === "string"
      ? [commerceRow.source_message_id] : [],
  });
  const scoped = (row: any) => row?.conversation_id === input.conversation_id &&
    row?.company_id === input.company_id;
  const memory = scoped(memoryRow) && recovery.memory_source_verified &&
      isCanonicalConversationMemory(memoryRow.memory)
    ? memoryRow.memory : null;
  const commerce = scoped(commerceRow) &&
      recovery.usable_source_message_ids.includes(commerceRow.source_message_id) &&
      isConversationCommerceState(commerceRow.state)
    ? commerceRow.state : null;
  const history = [...new Map([...recent, ...recovery.rows].map(row => [row.id, row])).values()]
    .sort((a, b) => compareMessageChronology(
      {id:String(b.id),created_at:String(b.created_at)}, {id:String(a.id),created_at:String(a.created_at)},
    ));
  if (!recovery.source_verified) {
    return {
      semantic: {frame: null, source: "none", failure_code: "SEMANTIC_INTERPRETER_UNAVAILABLE", failure_stage: "source_context"},
      history, memory: null, commerce: null, recovery,
    };
  }
  const stateReadIncomplete = !memoryRead || memoryRead.error || !commerceRead || commerceRead.error ||
    Boolean(memoryRow && !memory) || Boolean(commerceRow && !commerce);
  const summary = buildPersistentCommerceStateSummary(
    commerce ? commerceRow : null, memory ? memoryRow : null,
  );
  const persistentSummary = stateReadIncomplete
    ? JSON.stringify({...JSON.parse(summary ?? "{}"), context_incomplete: true})
    : summary;
  const semantic = await interpretCommerceSemantics({
    company_id: input.company_id,
    conversation_id: input.conversation_id,
    source_message_id: input.source_message_id,
    latest: input.latest,
    history: recent as CommerceSemanticHistoryTurn[],
    recovered_history: recovery.rows as CommerceSemanticHistoryTurn[],
    history_recovery: {context_incomplete: recovery.context_incomplete || Boolean(stateReadIncomplete), reason: recovery.reason},
    persistent_state_summary: persistentSummary,
    operation_id: input.operation_id,
    legacy_authority: input.legacy_authority,
    signal: input.signal,
  });
  return {semantic, history, memory, commerce, recovery};
}
