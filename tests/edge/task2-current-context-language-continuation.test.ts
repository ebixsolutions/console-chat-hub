import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveConversationMemoryResponse } from "../../supabase/functions/_shared/conversation-runtime-state.ts";

const grounded = {
  response_route: "prior_grounded_transform",
  source_message_id: "11111111-1111-4111-8111-111111111111",
  citation_lineage: {
    selected_document_id: "doc-hk",
    evidence_chunk_ids: ["chunk-hk"],
    evidence_count: 1,
  },
};

function baseBeforeT09() {
  return [
    { role: "assistant", content: "回收安排重點包括舊電器須獨立放置，並與送貨／安裝分開進行。", metadata: grounded },
    { role: "visitor", content: "簡單一點。" },
    { role: "assistant", content: "回收安排的重點是舊電器需獨立放置，回收與送貨／安裝分開處理。", metadata: grounded },
    { role: "visitor", content: "那回收安排的重點是什麼？" },
    { role: "assistant", content: "冷氣機屬於香港「四電一腦」受管制電器。", metadata: grounded },
    { role: "visitor", content: "只說冷氣機相關部分。" },
    { role: "assistant", content: "「四電一腦」是香港生產者責任計劃下的受管制產品。", metadata: grounded },
    { role: "visitor", content: "什么是四電一腦？" },
  ];
}

Deno.test("Task2 T09 derives current Hong Kong + air-conditioner context without explicit correction", () => {
  const latest = "我現在問的是哪個地區和哪個項目？";
  const reply = resolveConversationMemoryResponse(latest, [
    { role: "visitor", content: latest },
    ...baseBeforeT09(),
  ]);
  assert(reply);
  assertStringIncludes(reply, "香港");
  assertStringIncludes(reply, "冷氣機");
});

Deno.test("Task2 T10 repeats current context in English without relying on assistant route metadata", () => {
  const latest = "Answer the same question in English.";
  const reply = resolveConversationMemoryResponse(latest, [
    { role: "visitor", content: latest },
    { role: "assistant", content: "你現在問的是香港的冷氣機。", metadata: {} },
    { role: "visitor", content: "我現在問的是哪個地區和哪個項目？" },
    ...baseBeforeT09(),
  ]);
  assert(reply);
  assertEquals(reply, "Your current region is Hong Kong, and the current item is air conditioner.");
});

Deno.test("Task2 T11 can chain the same deterministic memory answer back to Traditional Chinese", () => {
  const latest = "回到繁體中文，不要增加新資料。";
  const reply = resolveConversationMemoryResponse(latest, [
    { role: "visitor", content: latest },
    { role: "assistant", content: "Your current region is Hong Kong, and the current item is air conditioner.", metadata: {} },
    { role: "visitor", content: "Answer the same question in English." },
    { role: "assistant", content: "你現在問的是香港的冷氣機。", metadata: {} },
    { role: "visitor", content: "我現在問的是哪個地區和哪個項目？" },
    ...baseBeforeT09(),
  ]);
  assert(reply);
  assertEquals(reply, "你現在問的是香港的冷氣機。");
});

Deno.test("Task2 unrelated old current-context memory does not hijack a later language request", () => {
  const latest = "Answer the same question in English.";
  const reply = resolveConversationMemoryResponse(latest, [
    { role: "visitor", content: latest },
    { role: "assistant", content: "這是另一個新問題的回答。" },
    { role: "visitor", content: "另一個完全不同的新問題是什麼？" },
    { role: "assistant", content: "再前一題。" },
    { role: "visitor", content: "又一個不同問題。" },
    { role: "assistant", content: "你現在問的是香港的冷氣機。" },
    { role: "visitor", content: "我現在問的是哪個地區和哪個項目？" },
    ...baseBeforeT09(),
  ]);
  assertEquals(reply, null);
});
