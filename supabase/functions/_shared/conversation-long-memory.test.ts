import {
  buildBoundedConversationContext,
  buildCanonicalConversationMemory,
  buildConversationMemoryMarkdown,
  C3_MEMORY_JSON_CHAR_BUDGET,
  C3_RECENT_RAW_TURN_LIMIT,
  CONVERSATION_MEMORY_VERSION,
  composeBoundedGenerationEnvelope,
  isCanonicalConversationMemory,
  resolveStructuredMemoryResponse,
  type CanonicalConversationMemory,
  type MemoryHistoryRow,
} from "./conversation-long-memory.ts";
import {
  createEmptyConversationCommerceState,
  type ConversationCommerceState,
} from "./commerce-state-contract.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

const CID = "00000000-0000-4000-8000-000000000001";
const COID = "00000000-0000-4000-8000-000000000002";
const MID = "00000000-0000-4000-8000-000000000003";

function commerce(): ConversationCommerceState {
  return createEmptyConversationCommerceState();
}

function build(options: {
  previous?: CanonicalConversationMemory | null;
  rows?: MemoryHistoryRow[];
  state?: ConversationCommerceState | null;
  revision?: number;
  turns?: number;
  memoryRevision?: number;
} = {}) {
  return buildCanonicalConversationMemory({
    previous: options.previous,
    conversation_id: CID,
    company_id: COID,
    source_message_id: MID,
    commerce_state_revision: options.revision ?? 1,
    commerce_state: options.state === undefined ? commerce() : options.state,
    newest_first: options.rows ?? [{ id: MID, role: "visitor", content: "I need two air conditioners for Hong Kong", created_at: "2026-09-15T00:00:00Z" }],
    visitor_turn_count: options.turns ?? 1,
    source_created_at: "2026-09-15T00:00:00Z",
    next_memory_revision: options.memoryRevision ?? 1,
  });
}

Deno.test("C3 memory schema validates versioned memory", () => assert(isCanonicalConversationMemory(build()), "valid memory rejected"));
Deno.test("C3 memory rejects an unknown version", () => assert(!isCanonicalConversationMemory({ ...build(), version: "future" }), "future version accepted"));
Deno.test("C3 memory rejects revision zero", () => assert(!isCanonicalConversationMemory({ ...build(), memory_revision: 0 }), "zero revision accepted"));
Deno.test("C3 memory is tenant bound", () => equal(build().company_id, COID, "company binding"));
Deno.test("C3 memory is conversation bound", () => equal(build().conversation_id, CID, "conversation binding"));
Deno.test("C3 memory is source-message bound", () => equal(build().source_message_id, MID, "source binding"));
Deno.test("C3 memory carries commerce revision", () => equal(build({ revision: 9 }).commerce_state_revision, 9, "commerce revision"));
Deno.test("C3 memory contract version is frozen", () => equal(build().version, CONVERSATION_MEMORY_VERSION, "version"));

Deno.test("incremental update retains an early durable customer fact", () => {
  const early = build({ rows: [{ role: "visitor", content: "We have 300 SKU and need membership features" }] });
  const later = build({ previous: early, rows: [{ role: "visitor", content: "Thanks, another question" }], memoryRevision: 2 });
  assert(later.current_customer_facts.some((fact) => fact.key === "product_count" && fact.value === 300), "early product count lost");
});

Deno.test("latest correction wins and remains bounded", () => {
  const state = commerce();
  state.latest_corrections = ["quantity is 2, not 3"];
  const memory = build({ state, rows: [{ role: "visitor", content: "Correction: quantity is 2, not 3" }] });
  assert(memory.latest_corrections[0].includes("2"), "latest correction absent");
  assert(memory.latest_corrections.length <= 8, "corrections unbounded");
});

Deno.test("cancelled entity never remains active", () => {
  const state = commerce();
  state.entities.push({ entity_id: "a", category: "aircon", quantity: 3, status: "cancelled", attributes: {}, constraints: {}, provenance: { source_type: "customer" } });
  const memory = build({ state });
  assert(!memory.active_entities.some((entity) => entity.entity_id === "a"), "cancelled entity active");
  assert(memory.cancelled_or_superseded.some((fact) => fact.entity_id === "a"), "cancellation not retained");
});

Deno.test("deferred entity never remains active", () => {
  const state = commerce();
  state.entities.push({ entity_id: "a", category: "aircon", quantity: 1, status: "deferred", attributes: {}, constraints: {}, provenance: { source_type: "customer" } });
  assert(build({ state }).active_entities.length === 0, "deferred entity active");
});

Deno.test("historical quote remains historical", () => {
  const state = commerce();
  state.quotes.push({ quote_id: "q-old", amount: 8000, currency: "HKD", quote_type: "customer_reported_historical", validity_status: "historical", conditions: {}, provenance: { source_type: "customer" } });
  const memory = build({ state });
  assert(memory.historical_facts.some((fact) => fact.key === "quote:q-old"), "historical quote absent");
  assert(memory.transaction_summary.quotation === "none", "historical quote promoted");
});

Deno.test("unverified quote cannot confirm an order", () => {
  const state = commerce();
  state.quotes.push({ quote_id: "q", amount: 10, currency: "HKD", quote_type: "unverified", validity_status: "unknown", conditions: {}, provenance: { source_type: "customer" } });
  equal(build({ state }).transaction_summary.order, "none", "order promoted");
});
Deno.test("unpaid remains unpaid", () => equal(build().transaction_summary.payment, "none", "payment promoted"));
Deno.test("delivery discussion remains unconfirmed", () => equal(build().transaction_summary.delivery, "not_confirmed", "delivery promoted"));
Deno.test("installation discussion remains unknown", () => equal(build().transaction_summary.installation, "unknown", "installation promoted"));

Deno.test("multi-entity A and B stay isolated", () => {
  const state = commerce();
  state.entities.push(
    { entity_id: "A", category: "aircon", quantity: 2, status: "researching", attributes: { region: "hong_kong" }, constraints: {}, provenance: { source_type: "customer" } },
    { entity_id: "B", category: "washer", quantity: 1, status: "tentative", attributes: { region: "taiwan" }, constraints: {}, provenance: { source_type: "customer" } },
  );
  const memory = build({ state });
  equal(memory.active_entities.find((x) => x.entity_id === "A")?.quantity, 2, "A quantity");
  equal(memory.active_entities.find((x) => x.entity_id === "B")?.quantity, 1, "B quantity");
});

Deno.test("entity correction does not cross entity", () => {
  const state = commerce();
  state.entities.push(
    { entity_id: "A", category: "a", quantity: 3, status: "researching", attributes: {}, constraints: {}, provenance: { source_type: "customer" } },
    { entity_id: "B", category: "b", quantity: 2, status: "researching", attributes: {}, constraints: {}, provenance: { source_type: "customer" } },
  );
  equal(build({ state }).active_entities.map((x) => [x.entity_id, x.quantity]), [["A", 3], ["B", 2]], "entity isolation");
});

Deno.test("current and future regions stay distinct", () => {
  const memory = build({ rows: [
    { role: "visitor", content: "Our current main market is Hong Kong" },
    { role: "visitor", content: "Later we may plan Taiwan" },
  ] });
  assert(memory.current_regions.some((x) => x.region === "hong_kong" && x.temporal_scope === "current"), "HK current missing");
  assert(memory.current_regions.some((x) => x.region === "taiwan" && x.temporal_scope === "future"), "Taiwan future missing");
});

Deno.test("language switch does not duplicate facts", () => {
  const memory = build({ rows: [
    { role: "visitor", content: "請用繁體中文回答" },
    { role: "visitor", content: "Please reply in English" },
    { role: "visitor", content: "請用繁體中文回答" },
  ] });
  equal(new Set(memory.customer_preferences).size, memory.customer_preferences.length, "preference duplicates");
});

Deno.test("grounded citation lineage is retained without KB fact promotion", () => {
  const memory = build({ rows: [{ role: "assistant", content: "Grounded", metadata: { source_message_id: MID, citation_lineage: { selected_document_id: "doc", evidence_chunk_ids: ["chunk"] } } }, { role: "visitor", content: "next" }] });
  equal(memory.grounded_reference_lineage[0]?.document_id, "doc", "lineage missing");
  assert(!memory.current_customer_facts.some((fact) => fact.authority === "current_kb"), "KB content invented");
});

Deno.test("structured memory never mutates canonical commerce input", () => {
  const state = commerce();
  const before = JSON.stringify(state);
  build({ state });
  equal(JSON.stringify(state), before, "commerce state mutated");
});

Deno.test("canonical commerce outranks prior memory disagreement", () => {
  const prior = build();
  prior.transaction_summary.payment = "paid";
  equal(build({ previous: prior, state: commerce(), memoryRevision: 2 }).transaction_summary.payment, "none", "memory overrode canonical state");
});

Deno.test("current KB is not cached as authority in memory", () => {
  const memory = build();
  assert(memory.current_customer_facts.every((fact) => fact.authority !== "current_kb"), "stale KB cached");
});

Deno.test("memory facts outrank irrelevant old raw turns in context", () => {
  const state = commerce();
  state.entities.push({ entity_id: "A", category: "aircon", quantity: 2, status: "confirmed", attributes: {}, constraints: {}, provenance: { source_type: "customer" } });
  const memory = build({ state });
  const context = buildBoundedConversationContext(memory, [{ role: "visitor", content: "Long ago it was 3" }]);
  assert(context.block.includes("A: 2"), "current memory absent");
});

Deno.test("Markdown is a projection of structured transaction state", () => {
  const memory = build();
  const markdown = buildConversationMemoryMarkdown(memory);
  assert(markdown.includes(`- Payment: ${memory.transaction_summary.payment}`), "projection mismatch");
});
Deno.test("Markdown does not invent optional identifiers", () => assert(!/order id|ltv|crm tier/i.test(buildConversationMemoryMarkdown(build())), "optional fact invented"));
Deno.test("memory-specific summary uses structured projection", () => assert(resolveStructuredMemoryResponse("Summarize our current requirements", build())?.includes("### Transaction State"), "summary unavailable"));
Deno.test("ordinary requests do not trigger memory shortcut", () => equal(resolveStructuredMemoryResponse("What is the price?", build()), null, "false shortcut"));

Deno.test("recent raw window is turn bounded", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? "assistant" : "visitor", content: `turn ${i}` }));
  const context = buildBoundedConversationContext(build(), rows);
  assert(context.recent_turns <= C3_RECENT_RAW_TURN_LIMIT, "raw turns unbounded");
});

Deno.test("prompt context is character bounded", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ role: "visitor", content: `${i} ${"x".repeat(3000)}` }));
  const context = buildBoundedConversationContext(build(), rows);
  assert(context.recent_chars <= 10_000 && context.total_chars <= 22_300, "context unbounded");
});

Deno.test("complete generation envelope is bounded", () => {
  const envelope = composeBoundedGenerationEnvelope({
    required_parts: ["policy".repeat(1000), "current KB".repeat(800)],
    memory_part: "memory".repeat(5000),
    continuity_part: "old".repeat(5000),
    user: "latest customer request",
  });
  assert(envelope.total_chars <= 32768, "full envelope unbounded");
  assert(envelope.system.includes("current KB"), "required current KB truncated");
});

Deno.test("required authority overflow fails closed", () => {
  let failed = false;
  try {
    composeBoundedGenerationEnvelope({ required_parts: ["x".repeat(40000)], memory_part: "", continuity_part: "", user: "u" });
  } catch { failed = true; }
  assert(failed, "authority overflow did not fail closed");
});

Deno.test("structured memory size is bounded", () => {
  const state = commerce();
  state.latest_corrections = Array.from({ length: 100 }, (_, i) => `${i}-${"x".repeat(1000)}`);
  assert(JSON.stringify(build({ state })).length <= C3_MEMORY_JSON_CHAR_BUDGET, "memory unbounded");
});

Deno.test("historical list is bounded", () => {
  const state = commerce();
  state.quotes = Array.from({ length: 100 }, (_, i) => ({ quote_id: `q${i}`, amount: i, currency: "HKD", quote_type: "customer_reported_historical" as const, validity_status: "historical" as const, conditions: {}, provenance: { source_type: "customer" as const } }));
  assert(build({ state }).historical_facts.length <= 16, "history unbounded");
});

Deno.test("repeated compaction has no semantic drift", () => {
  const first = build();
  const second = build({ previous: first, memoryRevision: 2 });
  const semantic = (m: CanonicalConversationMemory) => ({ ...m, memory_revision: 0 });
  equal(semantic(second), semantic(first), "semantic drift");
});

Deno.test("deterministic rebuild matches incremental current semantics", () => {
  const rows = [{ role: "visitor", content: "We have 300 SKU in Hong Kong" }, { role: "visitor", content: "Please reply in English" }];
  const initial = build({ rows: [rows[1]], memoryRevision: 1 });
  const incremental = build({ previous: initial, rows, memoryRevision: 2 });
  const rebuilt = build({ rows, memoryRevision: 2 });
  equal(incremental.current_customer_facts, rebuilt.current_customer_facts, "rebuild facts");
  equal(incremental.current_regions, rebuilt.current_regions, "rebuild regions");
});

Deno.test("100-turn checkpoints remain bounded", () => {
  let memory: CanonicalConversationMemory | null = null;
  const sizes: number[] = [];
  for (let turn = 1; turn <= 105; turn++) {
    const content = turn === 1 ? "We have 300 SKU" : turn === 30 ? "Correction: quantity is 2, not 3" : `bounded turn ${turn}`;
    memory = build({ previous: memory, rows: [{ role: "visitor", content }], turns: turn, memoryRevision: turn });
    if ([20, 50, 105].includes(turn)) sizes.push(buildBoundedConversationContext(memory, [{ role: "visitor", content }]).total_chars);
  }
  assert(memory!.current_customer_facts.some((fact) => fact.key === "product_count" && fact.value === 300), "early fact lost at 105");
  assert(Math.max(...sizes) - Math.min(...sizes) < 2000, "context grew with raw turn count");
});

Deno.test("turn counter reaches 100+ without changing authority", () => equal(build({ turns: 105 }).updated_from_turn, 105, "turn count"));
Deno.test("no cross-tenant identifier can be inherited from prior memory", () => {
  const prior = build();
  const next = buildCanonicalConversationMemory({ previous: prior, conversation_id: CID, company_id: "00000000-0000-4000-8000-000000000099", source_message_id: MID, commerce_state_revision: 1, commerce_state: commerce(), newest_first: [{ role: "visitor", content: "new" }], visitor_turn_count: 2, source_created_at: "2026-09-15T00:00:00Z", next_memory_revision: 2 });
  equal(next.company_id, "00000000-0000-4000-8000-000000000099", "tenant inherited");
  assert(next.current_customer_facts.length === 0, "cross-tenant fact inherited");
});

Deno.test("handoff state uses active canonical entity ids", () => {
  const state = commerce();
  state.entities.push({ entity_id: "A", category: "a", quantity: 1, status: "confirmed", attributes: {}, constraints: {}, provenance: { source_type: "customer" } });
  equal(build({ state }).handoff_relevant_state.active_entity_ids, ["A"], "handoff entities");
});

Deno.test("raw audit rows are never mutated by compaction", () => {
  const rows = [{ role: "visitor", content: "audit history" }];
  const before = JSON.stringify(rows);
  build({ rows });
  equal(JSON.stringify(rows), before, "raw history mutated");
});
