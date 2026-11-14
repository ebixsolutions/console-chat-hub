import { sameCanonicalJson } from "./canonical-json.ts";
import type { AuthoritativeCommitReadback, CommitReadbackClient } from "./authoritative-commit-readback.ts";

async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Proves the independent assistant receipt AND its unchanged customer parent. */
export async function readExactMemoryReplyLifecycle(client: CommitReadbackClient, expected: {
  conversation_id: string; company_id: string; source_message_id: string; reply_message_id: string;
  parent_revision: number; parent_hash: string; commerce_state_revision: number | null;
  memory: { memory_revision: number }; markdown_projection: string; reply_content: string;
}): Promise<AuthoritativeCommitReadback<{ revision: number; memory_hash: string }>> {
  let last: AuthoritativeCommitReadback<{ revision: number; memory_hash: string }> = { status: "absent" };
  const [markdownHash, replyHash] = await Promise.all([sha256(expected.markdown_projection), sha256(expected.reply_content)]);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [state, parent, receipt, reply] = await Promise.all([
        client.from("conversation_memory_state").select("*").eq("conversation_id", expected.conversation_id).eq("company_id", expected.company_id).maybeSingle(),
        client.from("conversation_memory_state_event").select("*").eq("source_message_id", expected.source_message_id).eq("conversation_id", expected.conversation_id).eq("company_id", expected.company_id).maybeSingle(),
        client.from("c3_memory_reply_lifecycle_receipt").select("*").eq("reply_message_id", expected.reply_message_id).eq("conversation_id", expected.conversation_id).eq("company_id", expected.company_id).maybeSingle(),
        client.from("messages").select("id,conversation_id,role,content,is_recalled,metadata").eq("id", expected.reply_message_id).eq("conversation_id", expected.conversation_id).maybeSingle(),
      ]);
      if ([state, parent, receipt, reply].some(result => result.error)) {
        last = { status: "indeterminate", reason: "reply_lifecycle_readback_query_failed" }; continue;
      }
      const s = state.data, p = parent.data, r = receipt.data, m = reply.data;
      if (!s || !p || !r || !m) {
        last = { status: "indeterminate", reason: "reply_lifecycle_readback_partial" }; continue;
      }
      const scoped = (row: any) => row.conversation_id === expected.conversation_id && row.company_id === expected.company_id && row.source_message_id === expected.source_message_id;
      const exact = scoped(s) && scoped(p) && scoped(r) && r.reply_message_id === expected.reply_message_id &&
        Number(p.applied_revision) === expected.parent_revision && p.memory_hash === expected.parent_hash &&
        Number(r.parent_revision) === expected.parent_revision && r.parent_hash === expected.parent_hash &&
        expected.memory.memory_revision === expected.parent_revision + 1 && Number(r.applied_revision) === expected.memory.memory_revision &&
        Number(s.revision) === expected.memory.memory_revision && typeof s.memory_hash === "string" && /^[a-f0-9]{64}$/.test(s.memory_hash) &&
        s.memory_hash === r.memory_hash && sameCanonicalJson(s.memory, expected.memory) && s.markdown_projection === expected.markdown_projection &&
        s.commerce_state_revision === expected.commerce_state_revision && p.commerce_state_revision === expected.commerce_state_revision && r.commerce_state_revision === expected.commerce_state_revision &&
        r.markdown_hash === markdownHash && r.reply_content_hash === replyHash && m.id === expected.reply_message_id &&
        m.conversation_id === expected.conversation_id && m.role === "assistant" && m.is_recalled === false && m.content === expected.reply_content &&
        m.metadata?.source_message_id === expected.source_message_id && m.metadata?.b2_source_message_id === expected.source_message_id &&
        m.metadata?.b2_expected_company_id === expected.company_id && m.metadata?.b2_commit_source === "commit_ai_reply_tx" &&
        Number(m.metadata?.b2_expected_revision) === (expected.commerce_state_revision ?? 0) && m.metadata?.control_commit === "ai" &&
        m.metadata?.b2_gate_contract === "executeB2PersistenceGate:allow_after_revalidation";
      if (exact) return { status: "committed", value: { revision: Number(s.revision), memory_hash: s.memory_hash } };
      last = { status: "indeterminate", reason: "reply_lifecycle_readback_identity_mismatch" };
    } catch {
      last = { status: "indeterminate", reason: "reply_lifecycle_readback_transport" };
    }
  }
  return last;
}
