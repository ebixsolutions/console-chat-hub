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
import type { FactualReadRequest } from "./semantic-history-recovery.ts";

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
  sourceFactualTurn?: boolean;
  factualReadRequest?: FactualReadRequest;
} = {}) {
  return buildCanonicalConversationMemory({
    previous: options.previous,
    source_factual_turn:options.sourceFactualTurn,
    factual_read_request:options.factualReadRequest,
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

Deno.test("Task2 Memory merges repeated demand bindings before limiting distinct source lineage",()=>{
  const source="previous-customer";
  const binding=(document:string)=>({selected_document_id:document,evidence_chunk_ids:[document+"-chunk"],
    reference_authority:{decision:"USE_CURRENT_KB",selected_source_id:document}});
  const memory=build({rows:[{id:MID,role:"visitor",content:"Tell me the applicable conditions"},
    {id:"previous-answer",role:"assistant",content:"The source conditions apply.",metadata:{source_message_id:source,
      citation_lineage:{source_bindings:[...Array.from({length:16},()=>binding("product")),binding("delivery-policy")]}}}]});
  equal(memory.grounded_reference_lineage.map(item=>item.document_id),["product","delivery-policy"],"later distinct source was truncated before deduplication");
});

Deno.test("Phase1 mixed factual answer retains merchant-owned stock unknown in handoff memory", () => {
 const rows:MemoryHistoryRow[]=[{id:"answer",role:"assistant",content:"TEA-R21 嘅重量：200 g。現貨仍需商家核實。",metadata:{control_commit:"ai",source_message_id:MID,response_route:"canonical_kb_direct_answer",answer_kind:"specification",unresolved_fact_fields:["stock"],authoritative_kb_facts:[{model:"TEA-R21",field:"weight",value:"200 g",authority:"CURRENT_KB",currentness_at_answer:"current"}]}},{id:MID,role:"visitor",content:"TEA-R21 嘅重量係幾多？有冇現貨？"}];
 const pending=build({rows});
 assert(pending.open_questions.some(q=>q.includes("TEA-R21") && q.includes("stock")),"mixed answer incorrectly resolves live stock");
 const later=build({previous:pending,memoryRevision:2,rows:[{id:"later-answer",role:"assistant",content:"重量：200 g",metadata:{control_commit:"ai",source_message_id:"later",response_route:"canonical_kb_direct_answer",answer_kind:"specification",unresolved_fact_fields:[]}},{id:"later",role:"visitor",content:"TEA-R21 的重量是多少？"}]});
 assert(later.open_questions.some(q=>q.includes("stock")),"unrelated fact answer erased merchant-owned pending question");
 const known=build({rows:rows.map(r=>r.role==="assistant"?{...r,metadata:{...(r.metadata as Record<string,unknown>),unresolved_fact_fields:[]}}:r)});
 assert(!known.open_questions.some(q=>q.includes("stock")),"stock unknown fabricated without authoritative answer marker");
});

Deno.test("unbound suitability questions cannot supersede one another through null entity scope", () => {
  const prior = build();
  const old = { source_message_id: "earlier", text: "Product suitability needs confirmation", status: "pending" as const,
    entity_id: null, resolution: "professional/site confirmation pending", resolution_source_message_id: "earlier-reply" };
  prior.question_lifecycle = [old];
  const next = build({ previous: prior, memoryRevision: 2, rows: [
    { id: "english-reply", role: "assistant", content: "I cannot confirm a suitable room area.",
      metadata: { control_commit: "ai", source_message_id: MID, response_route: "canonical_kb_direct_answer" } },
    { id: MID, role: "visitor", content: "Can you confirm whether CW-SUL70BA is suitable for 80 sq ft?" },
  ] });
  equal(next.question_lifecycle?.find(q => q.source_message_id === "earlier"), old, "unbound earlier lifecycle changed");
  equal(next.question_lifecycle?.find(q => q.source_message_id === MID)?.resolution_source_message_id, "english-reply", "new reply binding");
});
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

Deno.test("room-size correction replaces the superseded value in current memory", () => {
  const memory = build({ rows: [
    { id: "correction", role: "visitor", content: "大房面積更正返，唔係100呎，係110呎。" },
    { id: "sizes", role: "visitor", content: "細房大概80呎，大房100呎，個廳就180呎。" },
  ] });
  const roomSizes = memory.current_customer_facts.find((fact) => fact.key === "room_size");
  assert(JSON.stringify(roomSizes?.value).includes("110平方呎") && !JSON.stringify(roomSizes?.value).includes("100平方呎"), JSON.stringify(roomSizes));
  assert(memory.cancelled_or_superseded.some((fact) => fact.key === "superseded_room_size" && JSON.stringify(fact.value).includes("100平方呎")), JSON.stringify(memory.cancelled_or_superseded));
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
Deno.test("memory-specific summary renders naturally while internal structured projection remains available", () => {
  const memory=build(),reply=resolveStructuredMemoryResponse("Summarize our current requirements", memory);
  assert(reply && !/###|\{[^}]*\}|entity_id|payment_status/.test(reply), "customer recap exposes the internal projection");
  assert(buildConversationMemoryMarkdown(memory).includes("### Transaction State"), "internal projection unavailable");
});
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

Deno.test("Task 1 factual current source outranks old Commerce topic without changing Commerce",()=>{
 const state=commerce();state.current_topic="air_conditioner";
 const rows:MemoryHistoryRow[]=[{id:MID,role:"visitor",content:"請按香港現行資料解釋四電一腦包含哪些電器類別？"}];
 const current=build({state,rows,sourceFactualTurn:true});
 assert((current.current_goal??"").includes("四電一腦"),"factual goal stale");
 assert((current.current_topic??"").includes("四電一腦"),"factual current topic stale");
 equal(current.commerce_state_revision,1,"commerce revision changed");
 const unverified=build({state,rows});
 assert(unverified.current_topic!==current.current_topic,"unverified frame changed current topic");
 const unboundRows=[{...rows[0],id:"not-source"}];
 const baseline=build({state,rows:unboundRows});
 const mismatch=build({state,rows:unboundRows,sourceFactualTurn:true});
 equal(mismatch.current_goal,baseline.current_goal,"unbound ASK_FACT changed original goal projection");
 equal(mismatch.current_topic,baseline.current_topic,"unbound ASK_FACT changed original topic projection");
});

Deno.test("Task1C recorded catalogue price/stock never become a current customer quote or confirmed stock",()=>{
 const state=commerce();const before=JSON.stringify(state);
 const rows:MemoryHistoryRow[]=[{id:"catalogue-answer",role:"assistant",content:"來源價格欄位記錄 CNY 2,100。記錄庫存數量：0；現貨仍須商家核實。",metadata:{control_commit:"ai",source_message_id:MID,response_route:"canonical_kb_direct_answer",answer_kind:"recorded_product_facts",unresolved_fact_fields:["stock"],recorded_kb_facts:[{field:"price_amount",value:2100,currentness:"unverified",model:"P002-NV-XL",document_id:"doc",chunk_id:"chunk"},{field:"price_currency",value:"CNY",currentness:"unverified",model:"P002-NV-XL",document_id:"doc",chunk_id:"chunk"},{field:"stock_quantity",value:0,currentness:"unverified",model:"P002-NV-XL",document_id:"doc",chunk_id:"chunk"}],citation_lineage:{selected_document_id:"doc",evidence_chunk_ids:["chunk"]}}},{id:MID,role:"visitor",content:"P002-NV-XL 價格及現貨？"}];
 const memory=build({state,rows,sourceFactualTurn:true});
 assert(memory.open_questions.some(q=>q.includes("stock")),"recorded zero incorrectly resolved current inventory");
 assert(!memory.current_customer_facts.some(f=>f.value===2100||f.key.includes("stock")),"merchant snapshot became customer current fact");
 equal(JSON.stringify(state),before,"catalogue snapshot mutated canonical Commerce");
});
Deno.test("Task1C product-name and SKU confirmation remain pending through compaction",()=>{
 for(const fields of [["variant"],["product_identity"],["price"]]){
  const rows:MemoryHistoryRow[]=[{id:"catalogue-question",role:"assistant",content:"已發布資料有兩款規格；你指邊個 SKU？",metadata:{control_commit:"ai",source_message_id:MID,response_route:"canonical_kb_direct_answer",answer_kind:"catalogue_variant_clarification",unresolved_fact_fields:fields,identity_confirmation_required:fields[0]==="product_identity"}},{id:MID,role:"visitor",content:"轻量冲锋衣 價錢同庫存？"}];
  const first=build({rows,sourceFactualTurn:true});
  const q=first.question_lifecycle?.find(item=>item.source_message_id===MID);
  assert(q?.status==="pending"&&q.resolution?.includes("catalogue"),"catalogue choice incorrectly resolved");
  const second=build({previous:first,rows:[],memoryRevision:2});
  assert(second.question_lifecycle?.some(item=>item.source_message_id===MID&&item.status==="pending"),"compaction discarded pending identity");
 }
});

Deno.test("factual reading/comparison stores customer references without creating purchase entities", () => {
  const state = commerce(), before = JSON.stringify(state);
  const memory = build({state, rows: [{id: MID, role: "visitor", content: "比較 Cedar Flex 和 Maple Support 的服務內容"}],
    factualReadRequest: {source_message_id: MID, subjects: ["Cedar Flex", "Maple Support"],
      subject_source_message_ids: [MID], requested_facts: ["service scope", "comparison"]}});
  equal(memory.active_entities, [], "reading created a purchase entity");
  equal(JSON.stringify(state), before, "reading mutated Commerce");
  equal(memory.factual_read_anchors?.[0].subjects, ["Cedar Flex", "Maple Support"], "comparison lost one subject");
  equal(memory.factual_read_anchors?.[0].subject_source_message_ids, [MID], "read reference has no customer source");
  equal(memory.current_goal_source_message_id, MID, "goal not source-bound");
  equal(memory.current_topic_source_message_id, MID, "topic not source-bound");
  assert(memory.question_lifecycle?.some(q => q.source_message_id === MID && q.status === "pending"), "unpunctuated factual request silently completed");
});

Deno.test("an unbound semantic subject cannot enter factual Memory", () => {
  const memory = build({rows: [{id: MID, role: "visitor", content: "講解一下支援安排"},
    {id: "assistant-claim", role: "assistant", content: "The service is Imaginary Gold."}],
    factualReadRequest: {source_message_id: MID, subjects: ["Imaginary Gold"],
      subject_source_message_ids: ["assistant-claim"], requested_facts: ["support"]}});
  equal(memory.factual_read_anchors?.[0].subjects, [], "assistant claim became customer read subject");
  assert(!memory.current_goal?.includes("Imaginary Gold"), "unverified subject inserted into current goal");
  const rejected = build({rows: [{id: MID, role: "visitor", content: "請介紹 Cedar Flex"}],
    factualReadRequest: {source_message_id: "different-source", subjects: ["Cedar Flex"],
      subject_source_message_ids: [MID], requested_facts: ["introduction"]}});
  assert(!rejected.factual_read_anchors?.length, "foreign request source stored");
});

Deno.test("103-turn Memory retains early read-only referents across topic changes and returns", () => {
  let previous: CanonicalConversationMemory | null = null;
  const sourceId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const timestamp = (n: number) => new Date(Date.UTC(2026, 8, 15, 0, n)).toISOString();
  const state = commerce();
  for (let n = 1; n <= 103; n++) {
    const text = n === 1 ? "我想了解 Nova Flow 的服務內容，並非訂購" :
      n === 51 ? "另外請介紹 Cedar Flex" : n === 103 ? "返回之前的 Nova Flow，取消條件如何" : "好，已明白，謝謝";
    const reading = [1, 51, 103].includes(n);
    previous = buildCanonicalConversationMemory({previous, conversation_id: CID, company_id: COID,
      source_message_id: sourceId(n), source_created_at: timestamp(n), commerce_state_revision: 0,
      commerce_state: state, newest_first: [{id: sourceId(n), role: "visitor", content: text, created_at: timestamp(n)}],
      visitor_turn_count: n, next_memory_revision: n,
      ...(reading ? {factual_read_request: {source_message_id: sourceId(n),
        subjects: [n === 51 ? "Cedar Flex" : "Nova Flow"],
        subject_source_message_ids: [sourceId(n === 103 ? 1 : n)], requested_facts: [n === 103 ? "cancellation" : "information"]}} : {}),
    });
  }
  assert(previous, "missing memory");
  assert(previous.factual_read_anchors?.some(a => a.source_message_id === sourceId(1)), "early reading source evicted by small talk");
  assert(previous.factual_read_anchors?.some(a => a.source_message_id === sourceId(51)), "topic change erased old references");
  equal(previous.factual_read_anchors?.at(-1)?.subjects, ["Nova Flow"], "return bound to stale different topic");
  assert(previous.current_topic?.includes("Nova Flow"), "wrong current topic after return");
  equal(previous.active_entities, [], "long read conversation created commerce entities");
  equal(state.entities, [], "external state mutated");
  assert(JSON.stringify(previous).length <= C3_MEMORY_JSON_CHAR_BUDGET, "reading memory unbounded");
});

Deno.test("factual follow-up goal retains the bound subject rather than an isolated short question", () => {
  const prior = build({rows: [{id: "old-source", role: "visitor", content: "請介紹 AX-17"}], sourceFactualTurn: false});
  prior.factual_read_anchors = [{source_message_id: "old-source", created_at: "2026-09-14T00:00:00Z", customer_text: "請介紹 AX-17",
    subjects: ["AX-17"], subject_source_message_ids: ["old-source"], requested_facts: ["introduction"]}];
  const current = build({previous: prior, memoryRevision: 2,
    rows: [{id: MID, role: "visitor", content: "售後點安排"}],
    factualReadRequest: {source_message_id: MID, subjects: ["AX-17"], subject_source_message_ids: ["old-source"], requested_facts: ["after-sales"]}});
  assert(current.current_goal?.includes("AX-17") && current.current_goal.includes("售後"), "subject lost from current goal");
  equal(current.current_topic_source_message_id, MID, "goal provenance uses old turn");
  equal(current.factual_read_anchors?.at(-1)?.subject_source_message_ids, ["old-source"], "reference provenance lost");
});

Deno.test("price_unknown and any unresolved requested field remain pending without a phrase-specific rule", () => {
  for (const meta of [{answer_kind: "price_unknown"}, {answer_kind: "price", unresolved_fact_fields: ["discount_eligibility"]}]) {
    const memory = build({rows: [{id: "answer", role: "assistant", content: "有相關商品記錄，但這項條件暫時未能核實。",
      metadata: {control_commit: "ai", source_message_id: MID, response_route: "canonical_kb_direct_answer", ...meta}},
      {id: MID, role: "visitor", content: "請列出目前價格及優惠資格"}], sourceFactualTurn: true});
    equal(memory.question_lifecycle?.find(q => q.source_message_id === MID)?.status, "pending", "incomplete answer marked resolved");
    assert(memory.open_questions.length > 0, "unresolved fact dropped from handoff memory");
  }
});

Deno.test("new citation lineage merges retained references and ignores visitor-supplied citations", () => {
  const prior = build();
  prior.grounded_reference_lineage = [{document_id: "old-doc", evidence_chunk_ids: ["old-chunk"], source_message_id: "old-source"}];
  const next = build({previous: prior, memoryRevision: 2, rows: [{id: "reply", role: "assistant", content: "Source-bound answer",
    metadata: {source_message_id: MID, citation_lineage: {selected_document_id: "new-doc", evidence_chunk_ids: ["new-chunk"]}}},
    {id: MID, role: "visitor", content: "Customer question", metadata: {source_message_id: MID,
      citation_lineage: {selected_document_id: "visitor-injected-doc", evidence_chunk_ids: ["fake"]}}}]});
  equal(next.grounded_reference_lineage.map(item => item.document_id), ["new-doc", "old-doc"], "lineage erased old references or accepted customer injection");
  assert(next.current_customer_facts.every(f => f.authority !== "current_kb"), "citation became merchant authority");
});

Deno.test("an early unresolved question survives 103 later resolved turns", () => {
  let memory = build({rows: [{id: MID, role: "visitor", content: "特別安裝條件能否處理？"}], sourceFactualTurn: true});
  for (let n = 1; n <= 103; n++) {
    const id = `customer-${n}`;
    memory = build({previous: memory, memoryRevision: n + 1, turns: n + 1, rows: [
      {id: `reply-${n}`, role: "assistant", content: "這個問題已按適用資料回答。", metadata: {
        control_commit: "ai", source_message_id: id, response_route: "canonical_kb_direct_answer", answer_kind: "specification"}},
      {id, role: "visitor", content: `另一個規格問題 ${n}？`},
    ]});
  }
  assert(memory.question_lifecycle?.some(q => q.source_message_id === MID && q.status === "pending"), "resolved history evicted original unresolved question");
  assert(memory.open_questions.includes("特別安裝條件能否處理?"), "handoff lost the old unresolved question");
  assert(!memory.question_lifecycle_incomplete, "resolved-history trimming falsely marked pending overflow");
});

Deno.test("pending-question capacity overflow is explicit rather than silently complete", () => {
  const memory = build({rows: Array.from({length: 30}, (_, i) => ({id: `pending-${i}`, role: "visitor", content: `尚未解決的服務條件 ${i}？`}))});
  assert(memory.question_lifecycle_incomplete === true, "pending overflow hidden");
  assert((memory.question_lifecycle?.length ?? 0) <= 24, "unbounded pending memory");
  equal(build({previous: memory, memoryRevision: 2, rows: []}).question_lifecycle_incomplete, true, "compaction falsely cleared incomplete context");
});
