import type { B2CanonicalSnapshot } from "./pre-send-conversion-supervisor.ts";
import type { B2TrustedLifecycleCommit } from "./b2-journey-progress-contract.ts";
import { verifyCommittedLifecycleMemory,
  type CanonicalConversationMemory } from "./conversation-long-memory.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";

/** A pending reply receipt guards only the visitor turn that created it. */
export function hasUnresolvedLifecycleReplyForSource(
  memory: CanonicalConversationMemory | null,
  source_message_id: string,
  trusted_lifecycle_commit: B2TrustedLifecycleCommit | null,
): boolean {
  return memory?.pending_lifecycle_reply?.source_message_id === source_message_id &&
    !trusted_lifecycle_commit;
}

/** A durable same-source receipt can resume only while its exact revision is current. */
export function resumeCommittedLifecycleReply(input: {
  conversation_id: string;
  company_id: string;
  source_message_id: string;
  memory: CanonicalConversationMemory | null;
  commerce: { company_id: string; source_message_id: string | null;
    revision: number; state: ConversationCommerceState } | null;
}): B2TrustedLifecycleCommit | null {
  const { memory, commerce } = input;
  const receipt = memory?.pending_lifecycle_reply ?? null;
  return memory?.conversation_id === input.conversation_id &&
      commerce?.source_message_id === input.source_message_id &&
      receipt?.company_id === input.company_id &&
      receipt.source_message_id === input.source_message_id &&
      verifyCommittedLifecycleMemory({ memory, commerce, receipt })
    ? receipt : null;
}

async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Called only after B2 allowed and re-read the snapshot immediately before the RPC. */
export async function bindAuthorizedReply(
  snapshot: B2CanonicalSnapshot,
  content: string,
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const responseHash = await sha256(content);
  return {
    ...metadata,
    b2_gate_contract: "executeB2PersistenceGate:allow_after_revalidation",
    b2_commit_source: "commit_ai_reply_tx",
    b2_source_message_id: snapshot.source_message_id,
    b2_expected_company_id: snapshot.company_id,
    b2_expected_revision: snapshot.commerce_state_revision,
    b2_response_hash: responseHash,
    b2_idempotency_key: await sha256([
      snapshot.company_id, snapshot.conversation_id, snapshot.source_message_id,
      snapshot.commerce_state_revision, responseHash,
    ].join(":")),
  };
}
