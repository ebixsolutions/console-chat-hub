import { assert, assertEquals } from "jsr:@std/assert@1";
import { classifyHandoffIntent } from "../../supabase/functions/_shared/conversation-intelligence.ts";
import { detectExplicitJurisdiction, resolveConversationMemoryResponse } from "../../supabase/functions/_shared/conversation-runtime-state.ts";
import { classifyCurrentTurnEmotion } from "../../supabase/functions/_shared/runtime-signal-lifecycle.ts";

Deno.test("multilingual explicit R1 phrases and negation", () => {
  for (const text of ["我要真人客服。", "幫我轉真人客服。", "帮我转真人客服。", "我要搵真人。", "Connect me to a human agent.", "I want customer service."]) {
    assertEquals(classifyHandoffIntent(text).explicit_request, true, text);
  }
  assertEquals(classifyHandoffIntent("我現在先想弄清楚問題，不要立即轉真人。").explicit_request, false);
});
Deno.test("generic words are not jurisdictions", () => {
  assertEquals(detectExplicitJurisdiction("那官方的回收安排是什麼？"), null);
  assertEquals(detectExplicitJurisdiction("Please summarize the policy."), null);
});
Deno.test("conversation memory recalls supplied and missing information across language", () => {
  const rows = [
    { role: "visitor", content: "What information have I already given you, and what is still missing?" },
    { role: "assistant", content: "請提供冷氣機型號及訂單號碼。" },
    { role: "visitor", content: "品牌是 Panasonic，大約兩年前買，現在會開機但不冷。" },
    { role: "visitor", content: "我沒有型號，也沒有訂單號。" },
  ];
  const reply = resolveConversationMemoryResponse(rows[0].content, rows);
  assert(reply && reply.includes("Panasonic"));
  assert(reply && (reply.includes("型號") || reply.includes("model")));
});
Deno.test("general summary is routed to conversation memory", () => {
  const rows = [
    { role: "visitor", content: "最後用三點總結我們剛才談過的內容。" },
    { role: "assistant", content: "好的。" },
    { role: "visitor", content: "我沒有型號。" },
    { role: "visitor", content: "什么是四電一腦？" },
  ];
  const reply = resolveConversationMemoryResponse(rows[0].content, rows);
  assert(reply && reply.includes("四電一腦"));
});
Deno.test("Chinese anger becomes realtime signal", () => {
  const x = classifyCurrentTurnEmotion("我是 VIP 客戶，真的很生氣，但先不要轉真人。");
  assertEquals(x.anger_flag, true);
  assert(typeof x.sentiment_score === "number" && x.sentiment_score < -0.5);
});
