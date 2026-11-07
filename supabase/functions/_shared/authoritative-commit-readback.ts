/**
 * Bounded, read-only recovery for an ambiguous persistence acknowledgement.
 *
 * A transport error is never success by itself.  Success is recovered only
 * when the durable row(s) prove the exact conversation, tenant, source,
 * revision and payload identity that the caller attempted to commit.
 */

export type AuthoritativeCommitReadback<T> =
  | { status: "committed"; value: T }
  | { status: "absent" }
  | { status: "indeterminate"; reason: string };

export interface CommitReadbackClient {
  from(table: string): any;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value: unknown, max = 512): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().slice(0, max)
    : "";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function sameNullableInteger(
  actual: unknown,
  expected: number | null,
): boolean {
  if (expected === null) return actual === null || actual === undefined;
  return Number(actual) === expected && Number.isInteger(Number(actual));
}

async function boundedReadback<T>(
  read: () => Promise<AuthoritativeCommitReadback<T>>,
  attempts = 2,
): Promise<AuthoritativeCommitReadback<T>> {
  let last: AuthoritativeCommitReadback<T> = { status: "absent" };
  let sawIndeterminate = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await read();
    } catch (error) {
      last = {
        status: "indeterminate",
        reason: error instanceof Error ? error.name : "readback_error",
      };
    }
    if (last.status === "committed") return last;
    if (last.status === "indeterminate") sawIndeterminate = true;
  }
  return sawIndeterminate && last.status === "absent"
    ? { status: "indeterminate", reason: "inconsistent_readback" }
    : last;
}

export async function readExactConversationMemoryCommit(
  client: CommitReadbackClient,
  expected: {
    conversation_id: string;
    company_id: string;
    source_message_id: string;
    revision: number;
    commerce_state_revision: number | null;
    memory: unknown;
    markdown_projection: string;
  },
): Promise<
  AuthoritativeCommitReadback<{
    memory: unknown;
    markdown_projection: string;
    revision: number;
    memory_hash: string;
  }>
> {
  return await boundedReadback<{
    memory: unknown;
    markdown_projection: string;
    revision: number;
    memory_hash: string;
  }>(async () => {
    const [stateResult, eventResult] = await Promise.all([
      client.from("conversation_memory_state")
        .select(
          "conversation_id,company_id,revision,source_message_id,commerce_state_revision,memory,markdown_projection,memory_hash",
        )
        .eq("conversation_id", expected.conversation_id)
        .eq("company_id", expected.company_id)
        .maybeSingle(),
      client.from("conversation_memory_state_event")
        .select(
          "conversation_id,company_id,source_message_id,applied_revision,commerce_state_revision,memory_hash",
        )
        .eq("conversation_id", expected.conversation_id)
        .eq("company_id", expected.company_id)
        .eq("source_message_id", expected.source_message_id)
        .maybeSingle(),
    ]);
    if (stateResult.error || eventResult.error) {
      return {
        status: "indeterminate",
        reason: "memory_readback_query_failed",
      };
    }
    if (!stateResult.data && !eventResult.data) return { status: "absent" };
    if (!isRecord(stateResult.data) || !isRecord(eventResult.data)) {
      return { status: "indeterminate", reason: "memory_readback_partial" };
    }

    const state = stateResult.data;
    const event = eventResult.data;
    const stateHash = clean(state.memory_hash, 128);
    const eventHash = clean(event.memory_hash, 128);
    const exact =
      clean(state.conversation_id, 160) === expected.conversation_id &&
      clean(state.company_id, 160) === expected.company_id &&
      clean(state.source_message_id, 160) === expected.source_message_id &&
      Number(state.revision) === expected.revision &&
      sameNullableInteger(
        state.commerce_state_revision,
        expected.commerce_state_revision,
      ) &&
      canonicalJson(state.memory) === canonicalJson(expected.memory) &&
      state.markdown_projection === expected.markdown_projection &&
      clean(event.conversation_id, 160) === expected.conversation_id &&
      clean(event.company_id, 160) === expected.company_id &&
      clean(event.source_message_id, 160) === expected.source_message_id &&
      Number(event.applied_revision) === expected.revision &&
      sameNullableInteger(
        event.commerce_state_revision,
        expected.commerce_state_revision,
      ) &&
      Boolean(stateHash) && stateHash === eventHash;
    if (!exact) {
      return {
        status: "indeterminate",
        reason: "memory_readback_identity_mismatch",
      };
    }
    return {
      status: "committed",
      value: {
        memory: state.memory,
        markdown_projection: String(state.markdown_projection ?? ""),
        revision: Number(state.revision),
        memory_hash: stateHash,
      },
    };
  });
}

export async function readExactAiReplyCommit(
  client: CommitReadbackClient,
  expected: {
    conversation_id: string;
    source_message_id: string;
    content: string;
    authorized_revision?: number;
    company_id?: string;
    response_hash?: string;
    idempotency_key?: string;
  },
): Promise<AuthoritativeCommitReadback<{ message_id: string }>> {
  return await boundedReadback<{ message_id: string }>(async () => {
    let query = client.from("messages")
      .select("id,conversation_id,role,content,is_recalled,metadata")
      .eq("conversation_id", expected.conversation_id)
      .eq("role", "assistant")
      .eq("is_recalled", false)
      .eq("content", expected.content)
      .eq("metadata->>source_message_id", expected.source_message_id)
      .eq("metadata->>b2_source_message_id", expected.source_message_id)
      .eq("metadata->>b2_commit_source", "commit_ai_reply_tx")
      .eq(
        "metadata->>b2_gate_contract",
        "executeB2PersistenceGate:allow_after_revalidation",
      );
    if (expected.authorized_revision !== undefined) {
      query = query.eq("metadata->>b2_expected_revision", String(expected.authorized_revision))
        .eq("metadata->>b2_expected_company_id", expected.company_id ?? "")
        .eq("metadata->>b2_response_hash", expected.response_hash ?? "")
        .eq("metadata->>b2_idempotency_key", expected.idempotency_key ?? "");
    }
    const result = await query.maybeSingle();
    if (result.error) {
      return {
        status: "indeterminate",
        reason: "ai_reply_readback_query_failed",
      };
    }
    if (!result.data) return { status: "absent" };
    if (!isRecord(result.data) || !isRecord(result.data.metadata)) {
      return {
        status: "indeterminate",
        reason: "ai_reply_readback_invalid_row",
      };
    }
    const metadata = result.data.metadata;
    const messageId = clean(result.data.id, 160);
    const exact = Boolean(messageId) &&
      clean(result.data.conversation_id, 160) === expected.conversation_id &&
      result.data.role === "assistant" &&
      result.data.is_recalled === false &&
      result.data.content === expected.content &&
      clean(metadata.source_message_id, 160) === expected.source_message_id &&
      clean(metadata.b2_source_message_id, 160) ===
        expected.source_message_id &&
      metadata.b2_commit_source === "commit_ai_reply_tx" &&
      metadata.b2_gate_contract ===
        "executeB2PersistenceGate:allow_after_revalidation" &&
      (expected.authorized_revision === undefined || (
        Number(metadata.b2_expected_revision) === expected.authorized_revision &&
        metadata.b2_expected_company_id === expected.company_id &&
        metadata.b2_response_hash === expected.response_hash &&
        metadata.b2_idempotency_key === expected.idempotency_key));
    return exact ? { status: "committed", value: { message_id: messageId } } : {
      status: "indeterminate",
      reason: "ai_reply_readback_identity_mismatch",
    };
  });
}
