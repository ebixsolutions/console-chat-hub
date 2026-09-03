import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyCanonicalConversationTurn } from "../../supabase/functions/_shared/conversation-semantic-contract.ts";
import { resolvePriorGroundedTransform } from "../../supabase/functions/_shared/prior-grounded-transform.ts";

const groundedMeta = {
  source_message_id: "11111111-1111-4111-8111-111111111111",
  citations: [{ document_id: "doc-hk", chunk_id: "chunk-hk", label: "HK recycling" }],
  citation_lineage: {
    selected_document_id: "doc-hk",
    evidence_chunk_ids: ["chunk-hk"],
    evidence_count: 1,
  },
};

function history(latest: string) {
  return [
    { role: "visitor", content: latest },
    { role: "assistant", content: "回收安排與送貨／安裝是分開處理。", metadata: groundedMeta },
    { role: "visitor", content: "那回收安排的重點是什麼？" },
  ];
}

for (const prompt of ["簡單一點。", "简单一点。", "簡單啲。", "講簡單一點。", "說簡單一點。", "simpler", "shorter"]) {
  Deno.test(`Task2 standalone simplify stays prior-grounded: ${prompt}`, () => {
    const rows = history(prompt);
    const turn = classifyCanonicalConversationTurn(prompt, rows);
    assertEquals(turn.operation, "SIMPLIFY");
    assertEquals(turn.evidence_authority, "PRIOR_GROUNDED_ANSWER");
    assertEquals(turn.requires_new_kb_retrieval, false);
    assertEquals(turn.prior_grounded_answer?.document_id, "doc-hk");
    assertEquals(turn.prior_grounded_answer?.chunk_ids, ["chunk-hk"]);

    const transform = resolvePriorGroundedTransform(prompt, rows);
    assertEquals(transform?.operation, "SIMPLIFY");
    assertEquals(transform?.authority, "PRIOR_GROUNDED_ANSWER");
    assertEquals(transform?.document_id, "doc-hk");
    assertEquals(transform?.chunk_ids, ["chunk-hk"]);
  });
}
