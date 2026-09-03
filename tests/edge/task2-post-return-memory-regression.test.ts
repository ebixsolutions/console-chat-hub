import { classifyCanonicalConversationTurn } from "../../supabase/functions/_shared/conversation-semantic-contract.ts";
import { resolveConversationMemoryResponse } from "../../supabase/functions/_shared/conversation-runtime-state.ts";

const grounded = {
  role: "assistant",
  content: "香港的冷氣機回收安排需要按已確認資料處理。",
  metadata: {
    citation_lineage: {
      selected_document_id: "doc-1",
      evidence_chunk_ids: ["chunk-1"],
    },
  },
};

Deno.test("post-return mainly-asked recall is conversation memory", () => {
  const latest = "現在回到AI，請只用一句話說明我剛才主要問的是什麼。";
  const history = [
    { role: "visitor", content: latest },
    { role: "visitor", content: "我再補充一下，我沒有型號。" },
    { role: "visitor", content: "現在我要真人客服。" },
    { role: "visitor", content: "真人客服幾點有人？" },
    { role: "assistant", content: "你現在問的是香港的冷氣機。", metadata: { response_route: "conversation_memory" } },
    { role: "visitor", content: "只說冷氣機相關部分。" },
    grounded,
    { role: "visitor", content: "什么是四電一腦？" },
  ];
  const semantic = classifyCanonicalConversationTurn(latest, history);
  if (semantic.operation !== "CONVERSATION_MEMORY") throw new Error(JSON.stringify(semantic));
  if (semantic.requires_new_kb_retrieval) throw new Error("memory recall must not retrieve KB");
  const reply = resolveConversationMemoryResponse(latest, history);
  if (reply !== "你剛才主要問的是香港的冷氣機相關問題。") throw new Error(String(reply));
  if ((reply.match(/[。！？!?]/g) ?? []).length !== 1) throw new Error("reply must be one sentence");
});

Deno.test("English mainly-asked recall is deterministic", () => {
  const latest = "What was my main question?";
  const history = [
    { role: "visitor", content: latest },
    { role: "visitor", content: "只說冷氣機相關部分。" },
    grounded,
    { role: "visitor", content: "什么是四電一腦？" },
  ];
  const semantic = classifyCanonicalConversationTurn(latest, history);
  if (semantic.operation !== "CONVERSATION_MEMORY") throw new Error(JSON.stringify(semantic));
  const reply = resolveConversationMemoryResponse(latest, history);
  if (reply !== "You were mainly asking about air conditioner in Hong Kong.") throw new Error(String(reply));
});
