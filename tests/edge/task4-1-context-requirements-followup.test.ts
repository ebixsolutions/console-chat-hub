import { classifyCanonicalConversationTurn } from "../../supabase/functions/_shared/conversation-semantic-contract.ts";
import { buildCustomerContextRequirementsResponse } from "../../supabase/functions/_shared/conversation-intelligence.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const history = [
  { role: "visitor", content: "我只知道它是家用電器，而且我沒有型號。" },
  { role: "assistant", content: "收到。我會繼續使用你已提供的資料，未確認的部分不會自行猜測；如果還需要其他資料，我會直接告訴你。" },
  { role: "visitor", content: "什么是四電一腦？" },
];

Deno.test("A6 requirements request stays inside CUSTOMER_CONTEXT_UPDATE workflow", () => {
  const turn = classifyCanonicalConversationTurn("那你需要我提供什麼資料？", history);
  assert(turn.operation === "CUSTOMER_CONTEXT_UPDATE", `unexpected operation: ${turn.operation}`);
  assert(turn.reason === "customer_context_requirements_request", `unexpected reason: ${turn.reason}`);
  assert(turn.requires_new_kb_retrieval === false, "A6 must not retrieve KB");
  assert(turn.evidence_authority === "CONVERSATION_MEMORY", "A6 should use conversation memory only");
  assert(turn.needs_history === true, "A6 needs supplied context");
});

Deno.test("same root covers multilingual requirements wording", () => {
  for (const text of [
    "你還需要我提供哪些資料？",
    "还需要我提供什么信息？",
    "What information do you still need from me?",
    "What else do you need from me?",
  ]) {
    const turn = classifyCanonicalConversationTurn(text, history);
    assert(turn.operation === "CUSTOMER_CONTEXT_UPDATE", `${text} => ${turn.operation}`);
    assert(turn.reason === "customer_context_requirements_request", `${text} => ${turn.reason}`);
    assert(!turn.requires_new_kb_retrieval, `${text} unexpectedly retrieves KB`);
  }
});

Deno.test("A10 historical recommendation memory keeps MEMORY priority", () => {
  const turn = classifyCanonicalConversationTurn("你剛才建議我要提供哪些資料？", history);
  assert(turn.operation === "CONVERSATION_MEMORY", `A10 became ${turn.operation}`);
});

Deno.test("explicit handoff remains higher priority than requirements wording", () => {
  const turn = classifyCanonicalConversationTurn("你需要我提供什麼資料？不過現在幫我轉真人。", history, { explicit_handoff: true });
  assert(turn.operation === "EXPLICIT_HANDOFF", `handoff became ${turn.operation}`);
});

Deno.test("requirements response does not re-ask known missing model", () => {
  const reply = buildCustomerContextRequirementsResponse("zh-TW", history);
  assert(reply.includes("沒有型號"), "known missing model not acknowledged");
  assert(reply.includes("不用重複提供"), "known detail would be re-asked");
  assert(reply.includes("家用電器"), "appliance type follow-up missing");
  assert(reply.includes("品牌"), "brand follow-up missing");
  assert(reply.includes("購買時間"), "purchase-time follow-up missing");
  assert(reply.includes("目前出現的情況"), "current-condition follow-up missing");
});

Deno.test("requirements response never exposes internal retrieval terms", () => {
  for (const lang of ["zh-TW", "zh-CN", "en"] as const) {
    const reply = buildCustomerContextRequirementsResponse(lang, history);
    assert(!/Knowledge Base|\bKB\b|RAG|vector|chunk|document_id|chunk_id|verifier/i.test(reply), `${lang} leaked internal term`);
  }
});

Deno.test("runtime context branch remains before factual retrieval path", async () => {
  const source = await Deno.readTextFile(new URL("../../supabase/functions/generate-reply/index.ts", import.meta.url));
  const req = source.indexOf('buildCustomerContextRequirementsResponse(_canonicalTurn.language');
  const legacy = source.indexOf("const _turnClassification = classifyConversationTurn(_h1LastMsg)");
  assert(req >= 0, "requirements responder not wired");
  assert(legacy > req, "requirements path must run before legacy factual classification");
});