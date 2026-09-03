import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyCanonicalConversationTurn } from "../../supabase/functions/_shared/conversation-semantic-contract.ts";
import { resolvePriorGroundedTransform } from "../../supabase/functions/_shared/prior-grounded-transform.ts";

const groundedMeta = {
  source_message_id: "11111111-1111-4111-8111-111111111111",
  citations: [{ document_id: "doc-hk", chunk_id: "chunk-hk" }],
  citation_lineage: {
    selected_document_id: "doc-hk",
    evidence_chunk_ids: ["chunk-hk"],
    evidence_count: 1,
  },
};

function history(latest: string) {
  return [
    { role: "visitor", content: latest },
    { role: "assistant", content: "根據剛才的內容，除舊服務與送貨／安裝服務是分開進行的。", metadata: groundedMeta },
    { role: "visitor", content: "剛才內容有沒有提到回收和送貨／安裝是同一件事？" },
  ];
}

for (const prompt of [
  "用香港客戶聽得懂的人話回答。",
  "用白話回答。",
  "講口語一點。",
  "講得貼地啲。",
  "回答得自然一點。",
  "Say that in plain everyday language.",
]) {
  Deno.test(`Task2 human-language rewrite stays prior-grounded: ${prompt}`, () => {
    const rows = history(prompt);
    const turn = classifyCanonicalConversationTurn(prompt, rows);
    assertEquals(turn.operation, "SIMPLIFY");
    assertEquals(turn.evidence_authority, "PRIOR_GROUNDED_ANSWER");
    assertEquals(turn.requires_new_kb_retrieval, false);
    assertEquals(turn.prior_grounded_answer?.document_id, "doc-hk");

    const transform = resolvePriorGroundedTransform(prompt, rows);
    assertEquals(transform?.operation, "SIMPLIFY");
    assertEquals(transform?.selected_document_id, "doc-hk");
    assertEquals(transform?.evidence_chunk_ids, ["chunk-hk"]);
  });
}
