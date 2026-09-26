import { isCurrentRequirementsRecap } from "./commerce-state-authority.ts";
import { prepareConversationRecall } from "./conversation-recall.ts";
import { buildB2ReadOnlyRecapProof, executeB2PersistenceGate,
  type B2DatabaseClient, type B2QueryBuilder, type B2QueryResult } from "./pre-send-conversion-supervisor.ts";
import { bindAuthorizedReply, hasUnresolvedLifecycleReplyForSource,
  resumeCommittedLifecycleReply } from "./revision-bound-reply.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import type { CanonicalConversationMemory } from "./conversation-long-memory.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

type Fixture = {
  conversation_id: string; company_id: string; source_message_id: string;
  source_message_content: string;
  commerce: { revision: number; source_message_id: string; state: ConversationCommerceState };
  memory: { revision: number; source_message_id: string;
    commerce_state_revision: number; memory_hash: string; memory: CanonicalConversationMemory };
};

class Readback implements B2DatabaseClient {
  reads: string[] = [];
  readonly fixture: Fixture;
  readonly change: {
    secondCommerceRevision?: number; secondMemoryRevision?: number;
    memoryHash?: string; companyId?: string; sourceRole?: string;
  };
  constructor(fixture: Fixture, change: Readback["change"] = {}) {
    this.fixture = fixture;
    this.change = change;
  }
  from(table: string): B2QueryBuilder {
    return {
      select() { return this; },
      eq() { return this; },
      maybeSingle: async (): Promise<B2QueryResult> => {
        this.reads.push(table);
        const f = this.fixture;
        if (table === "conversations") return { data: {
          id: f.conversation_id, company_id: this.change.companyId ?? f.company_id,
        }, error: null };
        if (table === "messages") return { data: {
          id: f.source_message_id, conversation_id: f.conversation_id,
          role: this.change.sourceRole ?? "visitor", content: f.source_message_content,
        }, error: null };
        if (table === "conversation_commerce_state") return { data: {
          company_id: f.company_id,
          revision: this.reads.filter((x) => x === table).length > 1 &&
              this.change.secondCommerceRevision !== undefined
            ? this.change.secondCommerceRevision : f.commerce.revision,
          source_message_id: f.commerce.source_message_id,
          state: structuredClone(f.commerce.state),
        }, error: null };
        if (table === "conversation_memory_state") return { data: {
          conversation_id: f.conversation_id, company_id: f.company_id,
          revision: this.reads.filter((x) => x === table).length > 1 &&
              this.change.secondMemoryRevision !== undefined
            ? this.change.secondMemoryRevision : f.memory.revision,
          source_message_id: f.memory.source_message_id,
          commerce_state_revision: f.memory.commerce_state_revision,
          memory_hash: this.change.memoryHash ?? f.memory.memory_hash,
          memory: structuredClone(f.memory.memory),
        }, error: null };
        return { data: null, error: { message: "unexpected_table" } };
      },
    };
  }
}

Deno.test("Round 2: actual T11 receipt cannot intercept later read-only T12", async () => {
  const f = JSON.parse(await Deno.readTextFile(new URL(
    "./fixtures/t12-round2-production-shaped.json", import.meta.url,
  ))) as Fixture;
  const pending = f.memory.memory.pending_lifecycle_reply;
  assert(f.commerce.revision === 9 && f.memory.revision === 11 &&
    f.memory.commerce_state_revision === 9, "captured revision shape changed");
  assert(pending?.source_message_id === f.commerce.source_message_id &&
    pending.source_message_id !== f.source_message_id, "captured receipt scope changed");
  const commerce = { ...f.commerce, conversation_id: f.conversation_id,
    company_id: f.company_id };
  const resumed = resumeCommittedLifecycleReply({ conversation_id: f.conversation_id,
    company_id: f.company_id, source_message_id: f.source_message_id,
    memory: f.memory.memory, commerce });
  assert(resumed === null, "T11 receipt was incorrectly resumed for T12");
  assert(Boolean(pending && !resumed), "old unconditional guard did not reproduce 409");
  assert(!hasUnresolvedLifecycleReplyForSource(f.memory.memory, f.source_message_id, null),
    "T11 receipt blocked T12 before B2");
  for (const [kind, question] of [
    ["current_requirements", "而家我冷氣要求係點？"],
    ["quantity", "而家冷氣共幾部？"],
    ["checklist", "而家安裝仲有咩要核對？"],
    ["correction", "大房而家更正後幾多呎？"],
    ["entity_status", "雪櫃而家係咪暫停？"],
  ]) {
    const laterSource = kind === "current_requirements" ? f.source_message_id : crypto.randomUUID();
    assert(question.length > 0 && laterSource !== pending.source_message_id &&
      !hasUnresolvedLifecycleReplyForSource(
      f.memory.memory, laterSource, null,
    ), `${kind}: previous lifecycle receipt blocked a later read-only request`);
  }
  assert(hasUnresolvedLifecycleReplyForSource(f.memory.memory, pending.source_message_id, null),
    "same-source failed reply must remain guarded");
  assert(!hasUnresolvedLifecycleReplyForSource(f.memory.memory, pending.source_message_id, pending),
    "verified same-source resume must remain possible");
  assert(isCurrentRequirementsRecap(f.source_message_content), "T12 classification");
  const questions = [
    "三個位都有窗口位，而家裝緊嘅都係窗口機。",
    "另外個廳下晝西斜幾勁，揀機時要點考慮？",
    "細房我見到 CW-SUL70BA，佢有咩功能、係幾多匹？80呎用落夠唔夠？",
  ];
  const recall = prepareConversationRecall({
    conversation_id: f.conversation_id, company_id: f.company_id,
    source_message_id: f.source_message_id, question: f.source_message_content,
    memory: f.memory.memory, commerce, recent_questions: questions,
  }, "zh-TW");
  assert(recall.decision.handled && recall.decision.fact_type === "summary" && recall.reply,
    "current recap unresolved");
  const reply = recall.reply;
  for (const required of ["80平方呎", "110平方呎", "180平方呎", "窗口位",
    "西斜", "共三部", "CW-SUL70BA"]) assert(reply.includes(required), `recap missing ${required}`);
  assert(!reply.includes("100平方呎") && !reply.includes("雪櫃"), "stale/cancelled contamination");
  const proof = await buildB2ReadOnlyRecapProof({
    conversation_id: f.conversation_id, company_id: f.company_id,
    source_message_id: f.source_message_id, commerce_revision: 9,
    commerce_state: f.commerce.state, memory_revision: 11,
    memory_hash: f.memory.memory_hash, memory_source_message_id: f.memory.source_message_id,
    memory: f.memory.memory, reply,
  });
  const metadata = { ...recall.metadata, response_route: "canonical_memory_recall",
    recap_read_only: true, commerce_state_persist_result: "read_only",
    commerce_state_persistence_classification: "NO_SEMANTIC_CHANGE",
    recap_commerce_hash: proof.commerce_hash, recap_memory_hash: proof.memory_hash,
    recap_response_hash: proof.response_hash,
    b2_gate_contract: "executeB2PersistenceGate:allow_after_revalidation",
    b2_commit_source: "commit_ai_reply_tx", b2_source_message_id: f.source_message_id };
  const run = (client: Readback, change: Record<string, unknown> = {}) => {
    let rpc = "NOT_REACHED";
    return executeB2PersistenceGate({ client, conversation_id: f.conversation_id,
      source_message_id: f.source_message_id, proposed_response: reply,
      persistence_kind: "ai_reply", metadata, trusted_read_only_recap: proof,
      expected_commerce_state_revision: 9, ...change,
      commit: async (snapshot) => {
        const bound = await bindAuthorizedReply(snapshot, reply, metadata);
        rpc = bound.b2_expected_revision === 9 &&
            bound.b2_source_message_id === f.source_message_id &&
            bound.b2_expected_company_id === f.company_id &&
            bound.b2_response_hash === proof.response_hash
          ? "success" : "invalid_b2_revision_proof";
        return { result: rpc, message_id: "simulated-assistant-id" };
      },
    }).then((result) => ({ result, rpc }));
  };
  const client = new Readback(f);
  const approved = await run(client);
  assert(approved.result.committed && approved.result.decision.code ===
    "B2_ALLOW_AUTHORITATIVE_READ_ONLY_RECAP" && approved.rpc === "success",
  `T12 failed: ${JSON.stringify(approved)}`);
  assert(client.reads.filter((x) => x === "conversation_memory_state").length === 2,
    "Memory must be checked twice");
  for (const [name, change] of [
    ["stale_commerce", { secondCommerceRevision: 10 }],
    ["stale_memory_revision", { secondMemoryRevision: 12 }],
    ["stale_memory_hash", { memoryHash: "changed" }],
    ["wrong_tenant", { companyId: "wrong-tenant" }],
    ["wrong_source_role", { sourceRole: "assistant" }],
  ] as const) {
    const blocked = await run(new Readback(f, change));
    assert(!blocked.result.committed && blocked.rpc === "NOT_REACHED", name);
  }
  for (const [name, change] of [
    ["wrong_conversation", { trusted_read_only_recap: { ...proof, conversation_id: "wrong" } }],
    ["wrong_source", { trusted_read_only_recap: { ...proof, source_message_id: "wrong" } }],
    ["stale_100", { proposed_response: reply.replace("110平方呎", "100平方呎") }],
    ["deferred_revival", { proposed_response: `${reply} 雪櫃而家仍要換。` }],
    ["response_substitution", { metadata: { ...metadata, recap_response_hash: "wrong" } }],
  ] as const) {
    const blocked = await run(new Readback(f), change);
    assert(!blocked.result.committed && blocked.rpc === "NOT_REACHED", name);
  }
  console.log("T12-R2|first=stale-lifecycle-receipt-cross-source|recap=read_only|commerce=9→9|memory=11→11|B2_ALLOW_AUTHORITATIVE_READ_ONLY_RECAP|RPC=success|negatives=PASS");
});
