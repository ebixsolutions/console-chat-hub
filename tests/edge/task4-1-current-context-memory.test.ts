import { classifyCanonicalConversationTurn } from "../../supabase/functions/_shared/conversation-semantic-contract.ts";
import { resolveConversationMemoryResponse } from "../../supabase/functions/_shared/conversation-runtime-state.ts";

Deno.test("A19 classifies current region + item as conversation memory without KB retrieval", () => {
  const latest = "我現在問的是哪個地區和哪個項目？";
  const history = [
    { role: "visitor", content: latest },
    { role: "assistant", content: "已根據香港冷氣機安排回答。", metadata: { citation_lineage: { selected_document_id: "doc-hk-ac", evidence_chunk_ids: ["chunk-hk-ac"] }, source_message_id: "source-a18" } },
    { role: "visitor", content: "我更正一下，我問的是冷氣機，不是電視機。" },
    { role: "visitor", content: "在香港，它的回收安排還需要我準備什麼？" },
  ];
  const result = classifyCanonicalConversationTurn(latest, history);
  if (result.operation !== "CONVERSATION_MEMORY") throw new Error(`unexpected operation ${result.operation}`);
  if (result.requires_new_kb_retrieval) throw new Error("A19 must not retrieve KB");
  if (result.evidence_authority !== "CONVERSATION_MEMORY") throw new Error(`unexpected authority ${result.evidence_authority}`);
});

Deno.test("A19 deterministic memory response returns latest region and corrected item", () => {
  const latest = "我現在問的是哪個地區和哪個項目？";
  const history = [
    { role: "visitor", content: latest },
    { role: "assistant", content: "上一題已用繁體中文回答。" },
    { role: "visitor", content: "再用繁體中文回答上一題。" },
    { role: "assistant", content: "The confirmed facts concern the Hong Kong air-conditioner arrangement.", metadata: { citation_lineage: { selected_document_id: "doc-hk-ac", evidence_chunk_ids: ["chunk-hk-ac"] }, source_message_id: "source-a17" } },
    { role: "visitor", content: "In English, summarize only the facts you can actually confirm." },
    { role: "assistant", content: "官方安排已按冷氣機回答。" },
    { role: "visitor", content: "那這個更正後的項目，官方安排怎樣？" },
    { role: "visitor", content: "我更正一下，我問的是冷氣機，不是電視機。" },
    { role: "visitor", content: "在香港，它的回收安排還需要我準備什麼？" },
    { role: "visitor", content: "算了，不談 Mars，回香港的規則。" },
    { role: "visitor", content: "Mars 的冷氣機回收費是多少？" },
  ];
  const reply = resolveConversationMemoryResponse(latest, history);
  if (!reply) throw new Error("A19 memory reply missing");
  if (!reply.includes("香港")) throw new Error(`region missing: ${reply}`);
  if (!reply.includes("冷氣機")) throw new Error(`corrected item missing: ${reply}`);
  if (reply.includes("Mars") || reply.includes("火星") || reply.includes("電視機")) throw new Error(`superseded context leaked: ${reply}`);
});

Deno.test("A20 remains prior-grounded summarize and does not become conversation-memory summary", () => {
  const latest = "最後只根據已確認資料，用三點總結。";
  const history = [
    { role: "visitor", content: latest },
    { role: "assistant", content: "你現在問的是香港的冷氣機。", metadata: { response_route: "conversation_memory" } },
    { role: "visitor", content: "我現在問的是哪個地區和哪個項目？" },
    { role: "assistant", content: "已確認的香港冷氣機安排。", metadata: { citation_lineage: { selected_document_id: "doc-hk-ac", evidence_chunk_ids: ["chunk-hk-ac"] }, source_message_id: "source-a18" } },
  ];
  const result = classifyCanonicalConversationTurn(latest, history);
  if (result.operation !== "SUMMARIZE") throw new Error(`unexpected A20 operation ${result.operation}`);
  if (result.evidence_authority !== "PRIOR_GROUNDED_ANSWER") throw new Error(`unexpected A20 authority ${result.evidence_authority}`);
  if (result.requires_new_kb_retrieval) throw new Error("A20 must reuse prior grounded answer");
  if (result.prior_grounded_answer?.document_id !== "doc-hk-ac") throw new Error("A20 prior grounded lineage not preserved");
});
