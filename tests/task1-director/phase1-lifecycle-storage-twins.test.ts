/** Actual full-handler receipt that overflowed Memory; independent state,
 * ownership, replay and malformed-storage negatives. No Hosted claim. */
import { sameCanonicalJson } from "../../supabase/functions/_shared/canonical-json.ts";
import { compactLifecycleReceipt, readStoredLifecycleReceipt,
  type CompactLifecycleReceipt } from "../../supabase/functions/_shared/lifecycle-receipt-storage.ts";
import type { B2TrustedLifecycleCommit } from "../../supabase/functions/_shared/b2-journey-progress-contract.ts";
import { buildCanonicalConversationMemory, C3_MEMORY_JSON_CHAR_BUDGET,
  isCanonicalConversationMemory, verifyCommittedLifecycleMemory } from "../../supabase/functions/_shared/conversation-long-memory.ts";
import { resumeCommittedLifecycleReply, hasUnresolvedLifecycleReplyForSource } from "../../supabase/functions/_shared/revision-bound-reply.ts";
import { evaluateB2BeforeCommit } from "../../supabase/functions/_shared/pre-send-conversion-supervisor.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const captured = JSON.parse(await Deno.readTextFile(new URL("./fixtures/phase1-large-lifecycle-receipt.json", import.meta.url)));
const conversation_id = "00000000-0000-4000-8000-000000000002";
function fixture() {
  const receipt: B2TrustedLifecycleCommit = structuredClone(captured.receipt);
  const input = { company_id: receipt.company_id, conversation_id, source_message_id: receipt.source_message_id,
    source_created_at: "2026-11-25T00:00:00.000Z", next_memory_revision: 9,
    commerce_state_revision: receipt.committed_revision, commerce_state: receipt.committed_state,
    newest_first: [{ id: receipt.source_message_id, role: "visitor", content: receipt.source_text }], visitor_turn_count: 7,
    pending_lifecycle_reply: receipt };
  const memory = buildCanonicalConversationMemory(input);
  const commerce = { company_id: receipt.company_id, source_message_id: receipt.source_message_id,
    revision: receipt.committed_revision, state: structuredClone(receipt.committed_state) };
  return { receipt, memory, commerce, resume: { conversation_id, company_id: receipt.company_id,
    source_message_id: receipt.source_message_id, memory, commerce } };
}

Deno.test("P1 lifecycle storage: actual oversized handler receipt fits unchanged Memory budget and resumes full B2 proof", () => {
  const f = fixture(), compact = f.memory.pending_lifecycle_reply;
  assert(JSON.stringify(f.receipt).length === 14381, "Captured reproducer changed");
  assert(compact && "storage_encoding" in compact, "Oversized receipt did not use lossless storage");
  assert(C3_MEMORY_JSON_CHAR_BUDGET === 16384 && JSON.stringify(f.memory).length <= 16384 &&
    isCanonicalConversationMemory(f.memory), "Memory boundary changed or overflowed");
  const roundTrip = JSON.parse(JSON.stringify(f.memory));
  const restored = resumeCommittedLifecycleReply({ ...f.resume, memory: roundTrip });
  assert(restored && sameCanonicalJson(restored, f.receipt), "Lossless roundtrip lost an original proof field");
  assert(verifyCommittedLifecycleMemory({ memory: roundTrip, receipt: roundTrip.pending_lifecycle_reply,
    commerce: f.commerce }), "Compact storage broke canonical Memory parity");
  const decision = evaluateB2BeforeCommit({ persistence_kind: "ai_reply", proposed_response: restored.reply,
    trusted_lifecycle_commit: restored, snapshot: { company_id: restored.company_id, conversation_id,
      source_message_id: restored.source_message_id, source_message_content: restored.source_text,
      commerce_state_revision: restored.committed_revision, commerce_state_source_message_id: restored.source_message_id,
      state: f.commerce.state }, metadata: { response_route: "commerce_state_answer",
        commerce_reason: "authoritative_scoped_lifecycle_applied", commerce_authority: "CONVERSATION_STATE",
        commerce_state_persist_result: "success", commerce_state_persistence_classification: "COMMITTED",
        commerce_state_revision: restored.committed_revision } });
  assert(decision.decision === "allow" && decision.code === "B2_ALLOW_COMMITTED_SCOPED_LIFECYCLE",
    JSON.stringify(decision));
  assert(hasUnresolvedLifecycleReplyForSource(roundTrip, restored.source_message_id, null) &&
    !hasUnresolvedLifecycleReplyForSource(roundTrip, "later-source", null), "Pending receipt escaped its original turn");
  assert(readStoredLifecycleReceipt(f.receipt) && sameCanonicalJson(readStoredLifecycleReceipt(f.receipt), f.receipt),
    "Legacy full receipt lost backwards compatibility");
});

for (const fault of ["unknown-encoding", "duplicate-target", "wrong-target", "extra-delta-field", "extra-entity-field",
  "missing-previous-provenance", "injected-full-previous-state", "changed-current-value", "changed-plan",
  "changed-source-text", "wrong-current-source", "wrong-transaction", "wrong-revision",
  "invalid-previous-provenance", "unsafe-revision"] as const) {
  Deno.test(`P1 lifecycle storage negative ${fault}: malformed encoded proof cannot resume`, () => {
    const f = fixture(), stored = structuredClone(f.memory.pending_lifecycle_reply) as CompactLifecycleReceipt;
    const malformed = stored as unknown as Record<string, unknown>;
    if (fault === "unknown-encoding") malformed.storage_encoding = "unknown-v9";
    if (fault === "duplicate-target") stored.previous_state_delta.entities.push(structuredClone(stored.previous_state_delta.entities[0]));
    if (fault === "wrong-target") stored.previous_state_delta.entities[0].entity_id = "not-a-canonical-target";
    if (fault === "extra-delta-field") (stored.previous_state_delta as unknown as Record<string, unknown>).quantity = 999;
    if (fault === "extra-entity-field") (stored.previous_state_delta.entities[0] as unknown as Record<string, unknown>).quantity = 999;
    if (fault === "missing-previous-provenance") delete (stored.previous_state_delta.entities[0] as unknown as Record<string, unknown>).provenance;
    if (fault === "injected-full-previous-state") malformed.previous_state = f.receipt.previous_state;
    if (fault === "changed-current-value") stored.committed_state.entities[0].constraints.max_width_mm = 590;
    if (fault === "changed-plan") stored.plans[0].action = "deferred";
    if (fault === "changed-source-text") stored.source_text = "Cancel an unrelated item.";
    if (fault === "wrong-current-source") stored.source_message_id = "other-source";
    if (fault === "wrong-transaction") stored.transaction_after.order_status = "confirmed";
    if (fault === "wrong-revision") stored.committed_revision += 1;
    if (fault === "invalid-previous-provenance") (stored.previous_state_delta.entities[0] as unknown as Record<string, unknown>).provenance = {};
    if (fault === "unsafe-revision") { stored.previous_revision = Number.MAX_SAFE_INTEGER + 1; stored.committed_revision = stored.previous_revision + 1; }
    f.memory.pending_lifecycle_reply = stored;
    assert(resumeCommittedLifecycleReply(f.resume) === null, "Malformed storage bypassed live Memory/source/transition binding");
  });
}

for (const fault of ["owner", "ticket", "source", "commerce-revision", "commerce-state", "memory-active-quantity",
  "memory-inactive", "memory-current-source"] as const) {
  Deno.test(`P1 lifecycle storage bound negative ${fault}: full restored proof still needs original live authority`, () => {
    const f = fixture();
    if (fault === "owner") f.resume.company_id = "foreign-company";
    if (fault === "ticket") f.resume.conversation_id = "foreign-ticket";
    if (fault === "source") f.resume.source_message_id = "later-source";
    if (fault === "commerce-revision") f.commerce.revision += 1;
    if (fault === "commerce-state") f.commerce.state.entities[0].quantity += 1;
    if (fault === "memory-active-quantity") f.memory.active_entities[0].quantity = 999;
    if (fault === "memory-inactive") f.memory.cancelled_or_superseded = [];
    if (fault === "memory-current-source") f.memory.source_message_id = "unrelated-turn";
    assert(resumeCommittedLifecycleReply(f.resume) === null, "Restored receipt bypassed original source ownership or parity");
  });
}

Deno.test("P1 lifecycle storage: invalid original full transition is never compressed into authority", () => {
  const receipt = structuredClone(captured.receipt) as B2TrustedLifecycleCommit;
  receipt.committed_state.entities[0].quantity += 1;
  assert(compactLifecycleReceipt(receipt) === null && readStoredLifecycleReceipt(receipt) === null,
    "An unrelated quantity mutation was accepted as lifecycle-only");
});

const largeMemory = JSON.parse(await Deno.readTextFile(new URL("./fixtures/phase1-large-lifecycle-memory.json", import.meta.url)));
for (const fault of ["none", "owner", "current-revision", "current-value", "invalid-table"] as const) {
  Deno.test(`P1 lifecycle storage full W19 correction journey ${fault}: packed proof retains the complete durable receipt`, () => {
    const args = structuredClone(largeMemory.args) as Parameters<typeof buildCanonicalConversationMemory>[0];
    const receipt = args.pending_lifecycle_reply;
    assert(receipt && JSON.stringify(receipt).length === 18602, "Actual second reproducer changed");
    const memory = buildCanonicalConversationMemory(args);
    assert(isCanonicalConversationMemory(memory) && JSON.stringify(memory).length <= 16384 &&
      memory.pending_lifecycle_reply && "storage_encoding" in memory.pending_lifecycle_reply &&
      memory.pending_lifecycle_reply.storage_encoding === "lifecycle-state-table-v1", "Large receipt was not stored losslessly within the original budget");
    const resume = { company_id: args.company_id, conversation_id: args.conversation_id,
      source_message_id: args.source_message_id, memory: JSON.parse(JSON.stringify(memory)),
      commerce: { company_id: args.company_id, source_message_id: args.source_message_id,
        revision: receipt.committed_revision, state: structuredClone(receipt.committed_state) } };
    if (fault === "owner") resume.company_id = "another-company";
    if (fault === "current-revision") resume.commerce.revision += 1;
    if (fault === "current-value") resume.commerce.state.entities[0].quantity += 1;
    if (fault === "invalid-table") resume.memory.pending_lifecycle_reply.committed_state_json.root = 100000;
    const restored = resumeCommittedLifecycleReply(resume);
    if (fault === "none") {
      assert(restored && sameCanonicalJson(restored, receipt), "Packed state changed the original full proof");
      assert(verifyCommittedLifecycleMemory({ memory: resume.memory, receipt: restored, commerce: resume.commerce }),
        "Packed lifecycle lost canonical parity or prior correction facts");
    } else assert(restored === null, "Packed storage bypassed current live authority");
  });
}
