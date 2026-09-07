import { classifyCanonicalConversationTurn } from "../../supabase/functions/_shared/conversation-semantic-contract.ts";

type Row = { role: string; content: string };

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) {
    console.error(`FAIL ${label}`);
    Deno.exit(1);
  }
  console.log(`PASS ${label}`);
}

function classify(input: string, history: Row[] = []) {
  return classifyCanonicalConversationTurn(input, [
    { role: "visitor", content: input },
    ...history,
  ]);
}

function assertCustomerCorrection(input: string, history: Row[], label: string) {
  const got = classify(input, history);
  console.log(label, JSON.stringify(got));
  assert(got.operation === "CUSTOMER_CONTEXT_UPDATE", `${label}:operation`);
  assert(got.requires_new_kb_retrieval === false, `${label}:no_kb_retrieval`);
  assert(got.may_reuse_prior_grounded_answer === false, `${label}:no_prior_grounded_reuse`);
  assert(got.evidence_authority === "CONVERSATION_MEMORY", `${label}:conversation_memory_authority`);
  assert(got.topic_action === "CORRECT", `${label}:topic_correct`);
}

assertCustomerCorrection(
  "記住最新係300，唔係30。",
  [{ role: "visitor", content: "我而家大約30件商品。" }],
  "SKU_CORRECTION",
);

assertCustomerCorrection(
  "最新係4個staff，唔係2個。",
  [{ role: "visitor", content: "我有兩個staff。" }],
  "STAFF_CORRECTION",
);

assertCustomerCorrection(
  "其實目前主要市場係香港，唔係台灣。",
  [{ role: "visitor", content: "市場主要係台灣。" }],
  "MARKET_CORRECTION",
);

const factual = classify("Growth SKU limit係幾多？");
console.log("FACTUAL_QUERY", JSON.stringify(factual));
assert(factual.requires_new_kb_retrieval === true, "FACTUAL_QUERY:kb_retrieval_required");
assert(factual.operation !== "CUSTOMER_CONTEXT_UPDATE", "FACTUAL_QUERY:not_context_update");

const topicSwitch = classify("其實 Growth 唔係我要問，我想問 Pro。", [
  { role: "visitor", content: "想問 Growth plan。" },
]);
console.log("TOPIC_SWITCH_CORRECTION", JSON.stringify(topicSwitch));
assert(topicSwitch.requires_new_kb_retrieval === true, "TOPIC_SWITCH_CORRECTION:kb_retrieval_required");
assert(topicSwitch.operation !== "CUSTOMER_CONTEXT_UPDATE", "TOPIC_SWITCH_CORRECTION:not_context_update");

console.log("CUSTOMER_STATE_CORRECTION_SEMANTIC_GATE=PASS");
