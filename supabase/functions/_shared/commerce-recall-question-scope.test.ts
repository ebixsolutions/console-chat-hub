import { isReadOnlyMemoryOrCurrentStateRecall } from "./commerce-state-authority.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { prepareConversationRecall } from "./conversation-recall.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("Task3C declared room count does not turn the original selection question into recall", () => {
  const text = "Hello，屋企想換冷氣，兩間睡房加個客廳，應該點揀好？";
  for (const frame of [undefined, { operation: "ASK_FACT", requested_facts: [] },
    { operation: "NO_STATE_CHANGE", requested_facts: [] },
    { operation: "ASK_FACT", requested_facts: ["selection_criteria"] }]) {
    assert(!isReadOnlyMemoryOrCurrentStateRecall(text, frame), JSON.stringify({ text, frame }));
  }
});

Deno.test("Task3C declared counts remain context for unrelated business questions across domains", () => {
  for (const text of [
    "公司有三位同事，呢個服務應該點樣選擇？",
    "中心已有兩間課室，課程應該點樣安排？",
    "想買三張枱，交貨政策係點？",
    "我們有三個方案，應該先比較哪些？",
    "我哋有三位同事，服務支援時間係點？",
    "現時唔需要三個方案，只想了解服務內容？",
    "之前用過兩間課室，今次應該點揀？",
    "以前我有三位同事，現在應該揀咩方案？",
    "Our team has 3 staff; what support does the service include?",
  ]) {
    assert(!isReadOnlyMemoryOrCurrentStateRecall(text), text);
  }
});

Deno.test("Task3C actual current and historical quantity questions keep their read-only classification", () => {
  for (const text of [
    "我而家有幾多張書枱？",
    "我而家要幾多部冷氣？",
    "我現在要多少個訂閱席位？",
    "我目前要幾多份套餐？",
    "我最後係買三部定兩部？",
    "冷氣而家係三部定兩部？",
    "我係買兩部打印機定三部？",
    "頭先嗰兩部呢？",
    "頭先冷氣嗰兩部你仲記唔記得？",
    "我之前最後話要幾多部？",
    "你記得我最後要幾多部嗎？",
    "Do you remember how many I settled on?",
    "Remind me what quantity I have now.",
    "以前我想選三個方案，現在還是三個嗎？",
  ]) {
    assert(isReadOnlyMemoryOrCurrentStateRecall(text), text);
  }
});

Deno.test("Task3C semantic quantity slots require a read operation without supplying quantity authority", () => {
  const text = "Is that what we recorded?";
  for (const operation of ["ASK_FACT", "NO_STATE_CHANGE"]) {
    assert(isReadOnlyMemoryOrCurrentStateRecall(text, { operation, requested_facts: ["current_quantity"] }), operation);
  }
  for (const operation of ["ADD_ITEM", "UPDATE_ITEM", "SET_QUANTITY", undefined]) {
    assert(!isReadOnlyMemoryOrCurrentStateRecall(text, { operation, requested_facts: ["current_quantity"] }), String(operation));
  }
});

Deno.test("Task3C status and delivery reads survive while corrections, cancellations and dimensions stay separate", () => {
  for (const text of ["客廳嗰部而家係咪取消？", "送星期幾？", "What is the current delivery day?"]) {
    assert(isReadOnlyMemoryOrCurrentStateRecall(text), text);
  }
  for (const text of [
    "唔係兩部，改做三部",
    "取消三個方案。",
    "Please set the quantity to 4.",
    "Please add 2 seats.",
    "我而家要三部。",
    "我目前要五份套餐。",
    "我見到一部598mm闊，放唔放得入？",
  ]) {
    assert(!isReadOnlyMemoryOrCurrentStateRecall(text), text);
  }
});

Deno.test("Task3C canonical recall does not answer a business question using its incidental declared count", () => {
  const state = createEmptyConversationCommerceState();
  state.entities = [{ entity_id: "service", category: "generic_service", quantity: 3, status: "tentative",
    attributes: { product_name: "培訓服務", unit: "位" }, constraints: {},
    provenance: { source_type: "customer", source_message_id: "prior-customer-source" } }];
  const before = JSON.stringify(state);
  const answer = prepareConversationRecall({ company_id: "company", conversation_id: "ticket",
    source_message_id: "current-question", question: "公司有三位同事，培訓服務應該點樣選擇？", memory: null,
    commerce: { company_id: "company", conversation_id: "ticket", source_message_id: "prior-customer-source", revision: 2, state },
  }, "zh-TW");
  assert(!answer.decision.handled && answer.decision.reason === "NOT_A_RECALL_QUERY", JSON.stringify(answer));
  assert(answer.decision.requested_facts.length === 0 && answer.reply === null, JSON.stringify(answer));
  assert(JSON.stringify(state) === before, "classification changed the retained customer state");
});
