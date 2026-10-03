import { deriveTypedCustomerMoneyFacts } from "./customer-money-facts.ts";
import { deriveTypedCustomerCalculation } from "./conversation-service-runtime.ts";
import { classifyNaturalCustomerIntent, renderNaturalImmediateResponse } from "./natural-customer-response.ts";
import { planConversationService, renderServicePlanReply } from "./conversation-service-planner.ts";

const equal = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
};
Deno.test("COMPONENT: monetary role and basis follow words, independent of the amounts", () => {
  for (const [unit, delivery] of [[5788,550],[4137,283],[6981,742]]) {
    const facts = deriveTypedCustomerMoneyFacts(`假設機價每部 HK$${unit}，整單送貨 HK$${delivery}`).facts;
    equal(facts.map((f) => [f.amount,f.charge_basis,f.labels[2]]),[[unit,"per_unit","unit price"],[delivery,"per_order","delivery"]]);
    const parsed=deriveTypedCustomerCalculation({question:`Assuming HK$${unit} per unit plus HK$${delivery} delivery per order, calculate for three units.`,current_source_message_id:"customer-source"});
    equal(parsed.result,unit*3+delivery);
    equal(parsed.terms.map((term)=>term.source_message_id),["customer-source","customer-source"]);
  }
  equal(deriveTypedCustomerCalculation({question:"假設兩部合共 HK$5,600，再加 HK$550 送貨，合共幾多？"}).result,6150);
  equal(deriveTypedCustomerCalculation({question:"假設機價 HK$4,137，試算幾多？"}).status,"missing_explicit_basis");
  equal(deriveTypedCustomerCalculation({question:"假設每部 USD 100，再加整單 HKD 50，兩部試算？"}).status,"mixed_currency");
});
Deno.test("COMPONENT: historical acknowledgement never invents installation or a unit basis", () => {
  for (const question of ["之前機價 HK$5,788，送貨 HK$550。","之前兩部合共 HK$5,600。","之前四部合共 HK$9,312。"] ) {
    const plan=planConversationService({question,language:"zh-TW",recall:{handled:false,reason:"NOT_A_RECALL_QUERY"},memory:null,commerce:null});
    const reply=renderServicePlanReply(plan,null) ?? "";
    if (/鋁架|安裝同|每部 HKD 5,600/.test(reply)) throw new Error(reply);
  }
});
Deno.test("COMPONENT: unspecified goal is distinct from unavailable knowledge; concrete tasks and human requests stay out of greeting", () => {
  for(const text of ["你好，可以幫我嗎？","早晨，可唔可以幫我？","Hello, could you help me please?"]) {
    const intent=classifyNaturalCustomerIntent(text);equal(intent.kind,"greeting");
    if(!renderNaturalImmediateResponse(intent,"zh-TW"))throw new Error(text);
  }
  for(const text of ["你好，想退款。","Hi, help me choose a refrigerator.","你好，我想搵真人客服。","早晨，ZZ-KL88 有咩功能？"]) {
    if(classifyNaturalCustomerIntent(text).kind === "greeting")throw new Error(text);
  }
  const plan=planConversationService({question:"我想請教你，可以幫忙嗎？",language:"zh-TW",recall:{handled:false,reason:"NOT_A_RECALL_QUERY"},memory:null,commerce:null});
  equal(plan.knowledge_state,"not_needed");
  const reply=renderServicePlanReply(plan,null) ?? "";
  if(/現行資料|核實|日期/.test(reply))throw new Error(reply);
});
