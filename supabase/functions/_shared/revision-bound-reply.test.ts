function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
import { sameCanonicalJson } from "./canonical-json.ts";
import { reduceTurn } from "./commerce-state-runtime-base.ts";
import { b2JourneyTransactionBoundary, verifyEntityLifecycleTransition, type B2TrustedLifecycleCommit } from "./b2-journey-progress-contract.ts";
import { buildCanonicalConversationMemory, isCanonicalConversationMemory,
  verifyCommittedLifecycleMemory, type CanonicalConversationMemory } from "./conversation-long-memory.ts";
import { evaluateB2BeforeCommit } from "./pre-send-conversion-supervisor.ts";
import { bindAuthorizedReply, resumeCommittedLifecycleReply } from "./revision-bound-reply.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";

Deno.test("fictional T10→T11 runtime shape: JSONB reorder and B2 revision 9", async () => {
  const fixture = JSON.parse(await Deno.readTextFile(new URL("./fixtures/t11-synthetic-jsonb-reorder.json", import.meta.url)));
  const before = fixture.pre.state as ConversationCommerceState;
  const after = fixture.post.state as ConversationCommerceState;
  const source = fixture.source;
  const proposed = reduceTurn(before, {
    conversation_id: fixture.conversation_id, company_id: fixture.post.company_id,
    source_message_id: source.id, text: source.content, language: "zh-TW",
    occurred_at: source.created_at, history: [],
  }, []);
  assert(JSON.stringify(proposed) !== JSON.stringify(after), "reproduce exact false-409 raw inequality");
  assert(sameCanonicalJson(proposed, after), "same values despite JSONB key order");
  assert(!sameCanonicalJson([1, 2], [2, 1]), "array order remains material");
  assert(!sameCanonicalJson({ quantity: 3 }, { quantity: 2 }), "drift must be rejected");
  const transition = verifyEntityLifecycleTransition(source.content, before, after, source.id);
  assert(transition.valid);
  const reply = "好，雪櫃先暫停；而家繼續處理冷氣，之前嘅要求同數量會保留。";
  const receipt: B2TrustedLifecycleCommit = {
    contract: "entity-lifecycle-commit-v1", company_id: fixture.post.company_id,
    source_message_id: source.id, source_text: source.content,
    previous_revision: 8, committed_revision: 9,
    plans: transition.plans, target_entity_ids: transition.targetIds,
    previous_state: before, committed_state: proposed, reply,
    transaction_before: b2JourneyTransactionBoundary(before),
    transaction_after: b2JourneyTransactionBoundary(proposed),
  };
  const memory = fixture.memory as CanonicalConversationMemory;
  assert(verifyCommittedLifecycleMemory({ memory, receipt, commerce: fixture.post }));
  const retryMemory = buildCanonicalConversationMemory({
    previous: memory, conversation_id: fixture.conversation_id,
    company_id: fixture.post.company_id, source_message_id: source.id,
    source_created_at: source.created_at, commerce_state_revision: 9,
    commerce_state: after, newest_first: [{
      id: source.id, role: "visitor", content: source.content,
      created_at: source.created_at,
    }], visitor_turn_count: 11, next_memory_revision: 12,
    pending_lifecycle_reply: receipt,
  });
  assert(isCanonicalConversationMemory(retryMemory));
  const roundTrip = JSON.parse(JSON.stringify(retryMemory)) as CanonicalConversationMemory;
  const resumeInput = {
    conversation_id: fixture.conversation_id, company_id: fixture.post.company_id,
    source_message_id: source.id, memory: roundTrip, commerce: fixture.post,
  };
  assertEquals(resumeCommittedLifecycleReply(resumeInput)?.reply, reply);
  assertEquals(resumeCommittedLifecycleReply({ ...resumeInput, company_id: crypto.randomUUID() }), null);
  assertEquals(resumeCommittedLifecycleReply({ ...resumeInput, conversation_id: crypto.randomUUID() }), null);
  assertEquals(resumeCommittedLifecycleReply({ ...resumeInput, source_message_id: crypto.randomUUID() }), null);
  assertEquals(resumeCommittedLifecycleReply({ ...resumeInput, commerce: {
    ...fixture.post, revision: 10,
  } }), null);
  assert(verifyCommittedLifecycleMemory({ memory: roundTrip,
    receipt: roundTrip.pending_lifecycle_reply ?? null,
    commerce: fixture.post }), "same-source reply can resume without a second state event");
  const metadata = {
    response_route: "commerce_state_answer", commerce_reason: "authoritative_scoped_lifecycle_applied",
    commerce_authority: "CONVERSATION_STATE", commerce_state_persist_result: "success",
    commerce_state_persistence_classification: "COMMITTED", commerce_state_revision: 9,
  };
  const snapshot = {
    conversation_id: fixture.conversation_id, company_id: fixture.post.company_id,
    source_message_id: source.id, source_message_content: source.content,
    commerce_state_revision: 9, commerce_state_source_message_id: source.id, state: after,
  };
  assertEquals(evaluateB2BeforeCommit({ proposed_response: reply, persistence_kind: "ai_reply",
    metadata, snapshot, trusted_lifecycle_commit: receipt }),
    { decision: "allow", code: "B2_ALLOW_COMMITTED_SCOPED_LIFECYCLE" });
  const bound = await bindAuthorizedReply(snapshot, reply, metadata);
  assertEquals(bound.b2_expected_revision, 9);
  assertEquals(bound.b2_expected_company_id, fixture.post.company_id);
  assertEquals(bound.b2_source_message_id, source.id);
  assertEquals(bound.b2_response_hash, await crypto.subtle.digest("SHA-256", new TextEncoder().encode(reply))
    .then((buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("")));
  assert(!verifyCommittedLifecycleMemory({ memory, receipt, commerce: {
    ...fixture.post, revision: 10,
  } }), "newer revision must invalidate receipt");
});
