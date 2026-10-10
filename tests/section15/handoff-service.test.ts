import { planConversationService, renderServicePlanReply } from "../../supabase/functions/_shared/conversation-service-planner.ts";
import type { CanonicalConversationMemory } from "../../supabase/functions/_shared/conversation-long-memory.ts";
import type { CommerceSemanticFrame } from "../../supabase/functions/_shared/commerce-semantic-frame.ts";

const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const input = { language: "zh-TW" as const, recall: { handled: false, reason: "NOT_A_RECALL_QUERY" as const, detail: "CUSTOMER_STATEMENT_NOT_QUERY" }, memory: null, commerce: null };
const statements = ["唔好轉真人，幫我再講清楚", "如果一直未解決，再轉真人客服", "假設你唔識答，請轉真人客服", "等聽日再轉真人客服", "客人話「請轉真人客服」", 'The customer said: "Please transfer me to a human"'];
for (const question of statements) Deno.test(`non-immediate handoff statement avoids unrelated product clarification: ${question}`, () => {
  const plan = planConversationService({ ...input, question });
  assert(plan.action === "handoff_context_acknowledgement", JSON.stringify(plan));
  assert(!plan.handoff_requested && !plan.missing_slots.length && !plan.clarification_target, "not a handoff or missing business slot");
  const reply = renderServicePlanReply(plan, null);
  assert(reply && !/[?？]/.test(reply) && !reply.includes("邊項產品"), String(reply));
});

Deno.test("a mixed current-KB question retains lookup precedence over handoff negation", () => {
  const plan = planConversationService({ ...input, question: "暫時唔使轉真人客服。我想知 CW-SUL70BA 而家賣幾錢？", recall: { handled: false, reason: "CURRENT_KB_REQUIRED" } });
  assert(plan.knowledge_state === "lookup_required" && plan.action === "published_kb_lookup", JSON.stringify(plan));
});
Deno.test("explicit R1 still belongs to its authoritative control path", () => {
  const plan = planConversationService({ ...input, question: "請幫我轉真人客服。", explicit_handoff: true });
  assert(plan.action === "explicit_handoff" && plan.handoff_requested, JSON.stringify(plan));
});
Deno.test("customer state operations cannot be swallowed by handoff acknowledgement", () => {
  const semantic_frame = { operation: "UPDATE_ITEM", confidence: 0.9, ambiguity: {is_ambiguous:false}, requested_facts: [] } as unknown as CommerceSemanticFrame;
  const plan = planConversationService({ ...input, question: "唔好轉真人。改為三件。", semantic_frame });
  assert(plan.action !== "handoff_context_acknowledgement", JSON.stringify(plan));
});
Deno.test("canonical pending question stops repetition even when legacy counters are zero", () => {
  const memory = { current_goal: "產品查詢", customer_preferences: [], active_constraints: [], question_lifecycle: [{text:"你想核對產品資料,定係跟進使用問題?",status:"pending"}] } as unknown as CanonicalConversationMemory;
  const recent_messages = [{role:"assistant",content:"你想核對產品資料，定係跟進使用問題？"}, {role:"assistant",content:"產品資料售價為 HK$5,680。"}];
  for (const history of [recent_messages, [...recent_messages].reverse()]) {
    const plan = planConversationService({ ...input, question: "未處理好", memory, recent_messages:history, clarification_attempts: 0 });
    assert(plan.clarification_previously_asked && plan.action === "offer_handoff_or_reframe", JSON.stringify(plan));
  }
});
Deno.test("a resolved historical question does not suppress a new clarification", () => {
  const memory = { current_goal:"", customer_preferences:[], active_constraints:[], question_lifecycle:[{text:"你今次最想完成哪一件事？",status:"resolved"}] } as unknown as CanonicalConversationMemory;
  const plan = planConversationService({...input,question:"另一項未處理嘅事",memory});
  assert(!plan.clarification_previously_asked && plan.action !== "offer_handoff_or_reframe",JSON.stringify(plan));
});
