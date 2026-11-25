/** The actual W19 Cantonese recap crossed a sentence boundary in B2's
 * inactive-item check. Exercise the real recap/proof/persistence gate; these
 * deterministic database reads are native evidence, not Hosted/Auth/RLS proof.
 */
import { canonicalJson, sameCanonicalJson } from "../../supabase/functions/_shared/canonical-json.ts";
import { createEmptyConversationCommerceState, type CommerceEntity } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { buildCanonicalConversationMemory, type CanonicalConversationMemory } from "../../supabase/functions/_shared/conversation-long-memory.ts";
import { resolveConversationRecall, renderConversationRecall } from "../../supabase/functions/_shared/conversation-recall.ts";
import { buildB2ReadOnlyRecapProof, evaluateB2BeforeCommit, executeB2PersistenceGate,
  type B2CanonicalSnapshot, type B2DatabaseClient, type B2EvaluationInput } from "../../supabase/functions/_shared/pre-send-conversion-supervisor.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const captured = JSON.parse(await Deno.readTextFile(new URL("./fixtures/phase1-large-lifecycle-memory.json", import.meta.url)));
type Fixture = { snapshot: B2CanonicalSnapshot; memory: CanonicalConversationMemory };
type Context = "captured-W19-rentals-and-subscriptions" | "restaurant-cancelled-refreshments" | "beauty-deferred-addon";
const contexts: Context[] = ["captured-W19-rentals-and-subscriptions", "restaurant-cancelled-refreshments", "beauty-deferred-addon"];
const question = "可唔可以用廣東話兩句總結我而家嘅要求？";

function item(id: string, name: string, quantity: number, unit: string,
  status: CommerceEntity["status"], source: string): CommerceEntity {
  return { entity_id: id, category: name, quantity, status,
    attributes: { product_name: name, unit, quantity_basis: "customer_explicit" }, constraints: {},
    provenance: { source_type: "customer", source_message_id: source } };
}

function fixture(context: Context, literalInactiveLabel?: string): Fixture {
  if (context === "captured-W19-rentals-and-subscriptions") {
    assert(literalInactiveLabel === undefined, "The captured reproducer must stay unmodified");
    const args = structuredClone(captured.args) as Parameters<typeof buildCanonicalConversationMemory>[0];
    assert(args.commerce_state && args.commerce_state_revision !== null, "Captured Commerce missing");
    const memory = buildCanonicalConversationMemory(args);
    assert(memory.pending_lifecycle_reply && "storage_encoding" in memory.pending_lifecycle_reply &&
      memory.pending_lifecycle_reply.storage_encoding === "lifecycle-state-table-v1", "Actual packed Memory missing");
    return { memory, snapshot: { company_id: args.company_id, conversation_id: args.conversation_id,
      source_message_id: "recap-current-W19", source_message_content: question.normalize("NFKC"),
      commerce_state_source_message_id: args.source_message_id,
      commerce_state_revision: args.commerce_state_revision, state: structuredClone(args.commerce_state) } };
  }
  const company_id = `recap-${context}-company`, conversation_id = `recap-${context}-ticket`;
  const committedSource = `requirements-${context}`, state = createEmptyConversationCommerceState();
  state.language = "zh-TW";
  const restaurant = context === "restaurant-cancelled-refreshments";
  state.entities = restaurant
    ? [item("vegetarian-meals", "素食餐盒", 20, "份", "tentative", committedSource),
      item("refreshments", literalInactiveLabel ?? "茶點拼盤", 6, "盤", "cancelled", committedSource)]
    : [item("consultation", "護理諮詢", 1, "次", "researching", committedSource),
      item("manicure-addon", literalInactiveLabel ?? "修甲加項 [VIP]", 2, "節", "deferred", committedSource)];
  state.current_topic = state.entities[0].category;
  state.conversion.tentative_entity_ids = restaurant ? [state.entities[0].entity_id] : [];
  state.conversion.cancelled_entity_ids = restaurant ? [state.entities[1].entity_id] : [];
  const fact = restaurant ? { key: "allergy_preference", value: "避免花生" }
    : { key: "appointment_preference", value: "只接受下午時段" };
  const memory = buildCanonicalConversationMemory({ company_id, conversation_id,
    source_message_id: committedSource, source_created_at: "2026-11-25T00:00:00Z",
    next_memory_revision: 4, commerce_state_revision: 9, commerce_state: state,
    visitor_turn_count: 4, newest_first: [{ id: committedSource, role: "visitor", content: fact.value }],
    customer_fact_delta: [{ ...fact, authority: "customer", source_message_id: committedSource }] });
  return { memory, snapshot: { company_id, conversation_id, source_message_id: `recap-${context}`,
    source_message_content: question.normalize("NFKC"), commerce_state_revision: 9,
    commerce_state_source_message_id: committedSource, state } };
}

function canonicalReply(f: Fixture): string {
  const s = f.snapshot;
  assert(typeof s.commerce_state_source_message_id === "string" && s.commerce_state_source_message_id.trim(),
    "Canonical recap fixture requires a sourced committed state");
  const decision = resolveConversationRecall({ company_id: s.company_id, conversation_id: s.conversation_id,
    source_message_id: s.source_message_id, question, memory: f.memory,
    commerce: { company_id: s.company_id, conversation_id: s.conversation_id,
      source_message_id: s.commerce_state_source_message_id, revision: s.commerce_state_revision, state: s.state } });
  assert(decision.handled && decision.fact_type === "summary", "Canonical recap not resolved: " + JSON.stringify(decision));
  const reply = renderConversationRecall(decision, "zh-TW");
  assert(reply && /已暫緩|已取消/u.test(reply) && reply.includes("。而家記低咗"),
    "Fixture does not exercise an inactive item followed by independent current facts: " + reply);
  for (const entity of s.state.entities) assert(reply.includes(entity.category) &&
    reply.includes(`${entity.quantity}${entity.attributes.unit}`), "Literal item/count/unit missing: " + reply);
  return reply;
}

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function evaluation(f: Fixture, reply = canonicalReply(f)): Promise<B2EvaluationInput> {
  const s = f.snapshot;
  const proof = await buildB2ReadOnlyRecapProof({ company_id: s.company_id, conversation_id: s.conversation_id,
    source_message_id: s.source_message_id, commerce_revision: s.commerce_state_revision,
    commerce_state: structuredClone(s.state), memory_revision: f.memory.memory_revision,
    memory_hash: await hash(f.memory), memory_source_message_id: f.memory.source_message_id,
    memory: structuredClone(f.memory), reply });
  return { proposed_response: reply, persistence_kind: "ai_reply", snapshot: structuredClone(s),
    trusted_read_only_recap: proof, metadata: { response_route: "canonical_memory_recall", recall_fact_type: "summary",
      recap_read_only: true, commerce_state_persist_result: "read_only",
      commerce_state_persistence_classification: "NO_SEMANTIC_CHANGE",
      recap_commerce_hash: proof.commerce_hash, recap_memory_hash: proof.memory_hash,
      recap_response_hash: proof.response_hash, conversation_memory_revision: proof.memory_revision } };
}

async function gate(f: Fixture, e: B2EvaluationInput) {
  const s = f.snapshot, beforeState = canonicalJson(s.state), beforeMemory = canonicalJson(f.memory);
  let commits = 0, stateReads = 0, memoryReads = 0;
  const memoryHash = await hash(f.memory);
  const client: B2DatabaseClient = { from(table) {
    const filters: Record<string, unknown> = {};
    const query = { select: (_columns: string) => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      maybeSingle: async () => {
        let row: Record<string, unknown>;
        if (table === "conversations") row = { id: s.conversation_id, company_id: s.company_id };
        else if (table === "messages") row = { id: s.source_message_id, conversation_id: s.conversation_id,
          role: "visitor", content: s.source_message_content };
        else if (table === "conversation_commerce_state") {
          stateReads++;
          row = { company_id: s.company_id, conversation_id: s.conversation_id,
            source_message_id: s.commerce_state_source_message_id, revision: s.commerce_state_revision,
            state: structuredClone(s.state) };
        } else {
          assert(table === "conversation_memory_state", "Unexpected B2 read: " + table); memoryReads++;
          row = { company_id: s.company_id, conversation_id: s.conversation_id,
            source_message_id: f.memory.source_message_id, revision: f.memory.memory_revision,
            commerce_state_revision: s.commerce_state_revision, memory: structuredClone(f.memory), memory_hash: memoryHash };
        }
        assert(Object.entries(filters).every(([key, value]) => row[key] === value), "Read escaped fixture scope");
        return { data: row, error: null };
      } };
    return query;
  } };
  const result = await executeB2PersistenceGate({ client, conversation_id: s.conversation_id,
    source_message_id: s.source_message_id, expected_commerce_state_revision: s.commerce_state_revision,
    proposed_response: e.proposed_response, persistence_kind: "ai_reply", metadata: e.metadata,
    trusted_read_only_recap: e.trusted_read_only_recap,
    commit: async snapshot => {
      commits++;
      assert(sameCanonicalJson(snapshot, s), "Final callback received different owner/source/revision/state");
      return "native-recap-reply";
    } });
  assert(canonicalJson(s.state) === beforeState && canonicalJson(f.memory) === beforeMemory,
    "Read-only recap mutated canonical Commerce or Memory");
  assert(s.state.quotes.length === 0 && s.state.conversion.order_status === "none" &&
    s.state.conversion.payment_status === "none", "Recap gained transaction authority");
  return { result, commits, stateReads, memoryReads };
}

async function allowed(f: Fixture, reply?: string) {
  const e = await evaluation(f, reply), decision = evaluateB2BeforeCommit(e);
  assert(decision.decision === "allow" && decision.code === "B2_ALLOW_AUTHORITATIVE_READ_ONLY_RECAP", JSON.stringify(decision));
  const checked = await gate(f, e);
  assert(checked.result.committed && checked.commits === 1 && checked.stateReads === 2 && checked.memoryReads === 2,
    "Recap did not pass fresh Commerce/Memory revalidation exactly once: " + JSON.stringify(checked));
}

for (const context of contexts) {
  Deno.test(`P1 recap clause ${context}: inactive sentence and independent current facts retain exact B2 authority`, async () => {
    await allowed(fixture(context));
  });
  Deno.test(`P1 recap clause ${context} negative: same-clause inactive-as-current claim cannot commit`, async () => {
    const f = fixture(context), inactive = f.snapshot.state.entities.find(entity => ["deferred", "cancelled"].includes(entity.status));
    assert(inactive, "Inactive fixture entity missing");
    const e = await evaluation(f, canonicalReply(f) + `${inactive.category} 而家仍要。`);
    const decision = evaluateB2BeforeCommit(e), checked = await gate(f, e);
    assert(decision.decision === "block" && decision.code === "UNPROVEN_READ_ONLY_RECAP" &&
      !checked.result.committed && checked.commits === 0 && checked.result.decision.code === "UNPROVEN_READ_ONLY_RECAP",
      "False active claim gained reply authority: " + JSON.stringify({ decision, checked }));
  });
  for (const fault of ["tenant", "revision", "source"] as const) {
    Deno.test(`P1 recap clause ${context} negative: wrong-${fault} proof cannot commit`, async () => {
      const f = fixture(context), e = await evaluation(f), proof = e.trusted_read_only_recap;
      assert(proof, "Recap proof missing");
      if (fault === "tenant") proof.company_id = "foreign-company";
      if (fault === "revision") proof.commerce_revision += 1;
      if (fault === "source") proof.source_message_id = "unrelated-visitor-source";
      const decision = evaluateB2BeforeCommit(e), checked = await gate(f, e);
      assert(decision.decision === "block" && decision.code === "UNPROVEN_READ_ONLY_RECAP" &&
        !checked.result.committed && checked.commits === 0 &&
        checked.result.decision.code === "READ_ONLY_RECAP_SCOPE_OR_HASH_MISMATCH",
        "Sentence boundary relaxed scope binding: " + JSON.stringify({ decision, checked }));
    });
  }
}

for (const [name, boundary] of [["period", "."], ["exclamation", "!"], ["question", "?"],
  ["fullwidth-exclamation", "！"], ["fullwidth-question", "？"], ["semicolon", ";"],
  ["fullwidth-semicolon", "；"]] as const) {
  Deno.test(`P1 recap clause boundary ${name}: the next current fact does not reactivate the paused item`, async () => {
    const f = fixture("captured-W19-rentals-and-subscriptions"), reply = canonicalReply(f);
    assert(reply.includes("已暫緩。而家"), "Actual W19 boundary missing");
    await allowed(f, reply.replace("已暫緩。而家", `已暫緩${boundary}而家`));
  });
}

// A bare line break can be layout within one clause. Preserve the original
// whitespace normalization and fail closed; punctuation supplies the boundary.
for (const [name, newline] of [["carriage-return", "\r"], ["line-feed", "\n"]] as const) {
  Deno.test(`P1 recap clause boundary ${name} negative: layout alone cannot exempt a current claim`, async () => {
    const f = fixture("captured-W19-rentals-and-subscriptions");
    const reply = canonicalReply(f).replace("已暫緩。而家", `已暫緩${newline}而家`);
    const e = await evaluation(f, reply), decision = evaluateB2BeforeCommit(e), checked = await gate(f, e);
    assert(decision.decision === "block" && decision.code === "UNPROVEN_READ_ONLY_RECAP" &&
      !checked.result.committed && checked.commits === 0, "Layout-only line break relaxed the original clause check");
  });
  Deno.test(`P1 recap clause boundary punctuated-${name}: punctuation survives layout normalization`, async () => {
    const f = fixture("captured-W19-rentals-and-subscriptions");
    await allowed(f, canonicalReply(f).replace("已暫緩。而家", `已暫緩。${newline}而家`));
  });
}

for (const [name, label] of [["parentheses-and-plus", "護理 (A+B)"],
  ["brackets-and-star", "修甲 [VIP].*"], ["alternation", "Repair|VIP"]] as const) {
  Deno.test(`P1 recap literal label ${name}: regex metacharacters cannot capture an unrelated current fact`, async () => {
    const f = fixture("beauty-deferred-addon", label);
    await allowed(f, canonicalReply(f) + " VIP 目前偏好下午時段。");
  });
  Deno.test(`P1 recap literal label ${name} negative: the full literal inactive label still rejects a current claim`, async () => {
    const f = fixture("beauty-deferred-addon", label), e = await evaluation(f, canonicalReply(f) + `${label} 目前仍要。`);
    const decision = evaluateB2BeforeCommit(e), checked = await gate(f, e);
    assert(decision.decision === "block" && decision.code === "UNPROVEN_READ_ONLY_RECAP" &&
      !checked.result.committed && checked.commits === 0, "Literal metacharacter label evaded inactive-state checking");
  });
}
