import assert from "node:assert/strict";
import {
  buildConversationContinuityBlock,
  buildCustomerAdvisoryContext,
  classifyConversationTurn,
  classifyHandoffIntent,
  hasUsableFullContentEvidence,
  isHumanControlState,
} from "../../supabase/functions/_shared/conversation-intelligence.ts";

const positive = [
  "而家正式幫我轉真人",
  "請直接轉真人客服",
  "I want a human agent now",
  "Please connect me to a live agent",
];
for (const text of positive) {
  assert.equal(classifyHandoffIntent(text).explicit_request, true, `explicit R1: ${text}`);
}

const nonPositive = [
  "唔好轉真人",
  "我未叫你轉真人",
  "我唔係要求真人",
  "如果你真係答唔到，之後先考慮搵真人",
  "你頭先話可以轉真人",
  "真人客服係咪24小時?",
  "而家未需要真人",
  "I didn't ask for a human",
  "Don't transfer me to a human",
  "If you cannot answer, then I may ask for a human later",
  "You mentioned a human agent earlier",
  "What hours is human support available?",
];
for (const text of nonPositive) {
  assert.equal(classifyHandoffIntent(text).explicit_request, false, `must not R1: ${text}`);
}

for (const text of ["唔好轉真人", "我未叫你轉真人", "Don't transfer me to a human"]) {
  assert.equal(classifyHandoffIntent(text).pure_negation, true, `negation signal: ${text}`);
}

for (const text of ["我有個訂單問題。", "我想問退款", "之前嗰樣嘢"]) {
  assert.equal(classifyConversationTurn(text).should_clarify_before_kb, true, `underspecified: ${text}`);
}
for (const text of [
  "退貨政策係幾多日？",
  "今日送貨仲未有人聯絡，我應該點做？",
  "我三日前收到雪櫃，琴晚開始唔凍，按政策可以換貨嗎？",
]) {
  assert.equal(classifyConversationTurn(text).should_clarify_before_kb, false, `specific: ${text}`);
}

assert.equal(classifyConversationTurn("我頭先講錯，唔係完全開唔到，係間中開到").kind, "correction");
assert.equal(classifyConversationTurn("另外，換貨又要幾耐？").kind, "follow_up");

assert.equal(isHumanControlState("pending", null), true);
assert.equal(isHumanControlState("transferred", null), true);
assert.equal(isHumanControlState("human_needed", null), true);
assert.equal(isHumanControlState("human_control", null), true);
assert.equal(isHumanControlState("open", "agent-1"), true);
assert.equal(isHumanControlState("open", null), false);

assert.equal(hasUsableFullContentEvidence([
  { chunk_type: "rag_summary", content: "summary", score: 0.9 },
], 0.55), false, "summary is orientation only");
assert.equal(hasUsableFullContentEvidence([
  { chunk_type: "full_content", content: "authoritative fact", score: 0.8 },
], 0.55), true, "full content is answerable evidence");

// Continuous conversation projection: 24 customer turns with corrections and constraints.
const multiTurn = Array.from({ length: 24 }, (_, i) => ({
  role: "visitor",
  content: `較早客戶資料 ${24 - i}`,
}));
multiTurn[0] = { role: "visitor", content: "我頭先講錯，地址唔係8樓B，係8樓A。" };
multiTurn[1] = { role: "visitor", content: "唔好取消訂單，我只係想知道可唔可以取消。" };
multiTurn[2] = { role: "visitor", content: "另外，今日送貨仍然未有人聯絡。" };
const continuity = buildConversationContinuityBlock(multiTurn);
assert.match(continuity, /地址唔係8樓B，係8樓A/);
assert.match(continuity, /唔好取消訂單/);
assert.match(continuity, /newest customer statement as authoritative/i);
assert.ok(continuity.length <= 5000, "continuity block must stay bounded");
assert.doesNotMatch(continuity, /較早客戶資料 1(?:\n|$)/, "very old turns must be outside bounded projection");

const advisory = buildCustomerAdvisoryContext({
  tier: "VIP",
  anger_flag: true,
  sentiment_score: -0.8,
  churn_risk: 0.9,
  escalation_score: 0.85,
});
assert.match(advisory, /attentive and efficient/i);
assert.match(advisory, /frustration or anger/i);
assert.match(advisory, /must never trigger human handoff/i);
assert.match(advisory, /not authorization for a required handoff/i);
assert.equal(buildCustomerAdvisoryContext({}), "");

console.log("PASS Task 3.3 conversation intelligence + continuous multi-turn regression matrix");
