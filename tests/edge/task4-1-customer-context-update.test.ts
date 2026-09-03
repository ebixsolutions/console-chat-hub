import { classifyCanonicalConversationTurn } from "../../supabase/functions/_shared/conversation-semantic-contract.ts";
import { buildCustomerContextAcknowledgement } from "../../supabase/functions/_shared/conversation-intelligence.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

Deno.test("A5 customer-supplied missing model is context update, not factual query", () => {
  const turn = classifyCanonicalConversationTurn("我只知道它是家用電器，而且我沒有型號。", []);
  assert(turn.operation === "CUSTOMER_CONTEXT_UPDATE", `unexpected operation: ${turn.operation}`);
  assert(turn.requires_new_kb_retrieval === false, "context update must not retrieve KB");
  assert(turn.evidence_authority === "NONE", "context update must not claim factual evidence authority");
  assert(turn.needs_history === true, "context update must remain in conversation state");
  assert(turn.topic_action === "KEEP", "context update must keep the active topic");
});

Deno.test("customer detail families are classified consistently", () => {
  for (const text of [
    "品牌是 Panasonic，大約兩年前買，現在會開機但不冷。",
    "我沒有其他資料，不要猜。",
    "I don't have the model number.",
    "The brand is Panasonic. I bought it about two years ago. It powers on but does not cool.",
  ]) {
    const turn = classifyCanonicalConversationTurn(text, []);
    assert(turn.operation === "CUSTOMER_CONTEXT_UPDATE", `${text} => ${turn.operation}`);
    assert(turn.requires_new_kb_retrieval === false, `${text} unexpectedly retrieves KB`);
  }
});

Deno.test("questions are never swallowed as passive customer context updates", () => {
  for (const text of [
    "我沒有型號，應該怎麼辦？",
    "I don't have the model number. What should I do?",
    "Mars 的冷氣機回收費是多少？",
  ]) {
    const turn = classifyCanonicalConversationTurn(text, []);
    assert(turn.operation !== "CUSTOMER_CONTEXT_UPDATE", `${text} incorrectly classified as context update`);
  }
});

Deno.test("correction and explicit handoff keep higher-priority semantics", () => {
  const correction = classifyCanonicalConversationTurn("我更正一下，我沒有型號，是冷氣機。", []);
  assert(correction.operation === "CORRECTION", `correction became ${correction.operation}`);
  const handoff = classifyCanonicalConversationTurn("我沒有型號，現在請幫我轉真人客服。", [], { explicit_handoff: true });
  assert(handoff.operation === "EXPLICIT_HANDOFF", `handoff became ${handoff.operation}`);
});

Deno.test("acknowledgement is deterministic and does not invent KB facts", () => {
  const zh = buildCustomerContextAcknowledgement("zh-TW");
  const en = buildCustomerContextAcknowledgement("en");
  assert(zh.includes("已提供的資料") && zh.includes("不會自行猜測"), "zh acknowledgement contract missing");
  assert(en.includes("details you’ve provided") && en.includes("won’t guess"), "en acknowledgement contract missing");
  for (const text of [zh, en]) {
    assert(!/Knowledge Base|\bKB\b|RAG|vector|chunk|document_id|chunk_id/i.test(text), "internal retrieval term leaked");
  }
});

Deno.test("generate-reply commits context update before legacy factual path", async () => {
  const source = await Deno.readTextFile(new URL("../../supabase/functions/generate-reply/index.ts", import.meta.url));
  const canonical = source.indexOf('if (_canonicalTurn.operation === "CUSTOMER_CONTEXT_UPDATE")');
  const legacy = source.indexOf("const _turnClassification = classifyConversationTurn(_h1LastMsg)");
  assert(canonical >= 0, "customer context runtime branch missing");
  assert(legacy > canonical, "customer context branch must precede legacy classification/factual path");
  const block = source.slice(canonical, legacy);
  assert(block.includes('response_route: "customer_context_update"'), "context route metadata missing");
  assert(block.includes('escalation_action: "continue_ai"'), "continue-ai metadata missing");
  assert(block.includes("commitAiReplyWithControlGate"), "atomic commit gate bypassed");
  assert(block.includes("cleanupThinking"), "thinking cleanup missing");
  assert(!block.includes("callKBAdapter"), "context update branch must not call KB");
  assert(!block.includes("callModel"), "context update branch must not call LLM");
});