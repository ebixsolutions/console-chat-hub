import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyCanonicalConversationTurn, findPriorGroundedAnswer } from "../../supabase/functions/_shared/conversation-semantic-contract.ts";
import { buildCanonicalRetrievalQuery, projectConversationRuntimeState, detectExplicitJurisdiction } from "../../supabase/functions/_shared/conversation-runtime-state.ts";
import { classifyConversationTurn } from "../../supabase/functions/_shared/conversation-intelligence.ts";

const groundedMeta = {
  source_message_id: "11111111-1111-4111-8111-111111111111",
  citations: [{ document_id: "doc-hk", chunk_id: "chunk-hk", chunk_type: "full_content", label: "四電一腦" }],
  citation_lineage: {
    selected_document_id: "doc-hk",
    evidence_chunk_ids: ["chunk-hk"],
    evidence_count: 1,
  },
};

function history(latest: string) {
  return [
    { role: "visitor", content: latest },
    { role: "assistant", content: "「四電一腦」包括受規管的電器。", metadata: groundedMeta },
    { role: "visitor", content: "什么是四電一腦？" },
  ];
}

Deno.test("Task1 semantic: simplification is a transform of prior grounded answer", () => {
  const t = classifyCanonicalConversationTurn("簡單一點解釋給我聽。", history("簡單一點解釋給我聽。"));
  assertEquals(t.operation, "SIMPLIFY");
  assertEquals(t.evidence_authority, "PRIOR_GROUNDED_ANSWER");
  assertEquals(t.requires_new_kb_retrieval, false);
  assertEquals(t.may_reuse_prior_grounded_answer, true);
  assertEquals(t.prior_grounded_answer?.document_id, "doc-hk");
});

Deno.test("Task1 semantic: translation preserves prior grounded authority", () => {
  const t = classifyCanonicalConversationTurn("Explain that in English.", history("Explain that in English."));
  assertEquals(t.operation, "TRANSLATE");
  assertEquals(t.evidence_authority, "PRIOR_GROUNDED_ANSWER");
  assertEquals(t.prior_grounded_answer?.chunk_ids, ["chunk-hk"]);
});

Deno.test("Task1 semantic: rephrase and summary are transforms, not new facts", () => {
  assertEquals(classifyCanonicalConversationTurn("換句話說一次。", history("換句話說一次。")).operation, "REPHRASE");
  assertEquals(classifyCanonicalConversationTurn("總結一下剛才的內容。", history("總結一下剛才的內容。")).operation, "SUMMARIZE");
});

Deno.test("Task1 semantic: factual follow-up and pronoun/ellipsis require history", () => {
  const a = classifyCanonicalConversationTurn("那包括哪些種類？", history("那包括哪些種類？"));
  const b = classifyCanonicalConversationTurn("那個呢？", history("那個呢？"));
  assertEquals(a.operation, "FOLLOW_UP_FACTUAL");
  assertEquals(a.needs_history, true);
  assertEquals(a.requires_new_kb_retrieval, true);
  assertEquals(b.operation, "PRONOUN_OR_ELLIPSIS");
  assertEquals(b.needs_history, true);
});

Deno.test("Task1 semantic: correction, switch and return are distinct state operations", () => {
  assertEquals(classifyCanonicalConversationTurn("我講錯，應該是洗衣機。", history("我講錯，應該是洗衣機。")).operation, "CORRECTION");
  assertEquals(classifyCanonicalConversationTurn("算了，另外問退款政策。", history("算了，另外問退款政策。")).operation, "TOPIC_SWITCH");
  assertEquals(classifyCanonicalConversationTurn("算了，不談 Mars，回香港的規則。", history("算了，不談 Mars，回香港的規則。")).operation, "RETURN_TO_PRIOR_TOPIC");
});

Deno.test("Task1 semantic: conversation-memory requests never require KB retrieval", () => {
  const t = classifyCanonicalConversationTurn("我一開始問的是什麼？", history("我一開始問的是什麼？"));
  assertEquals(t.operation, "CONVERSATION_MEMORY");
  assertEquals(t.evidence_authority, "CONVERSATION_MEMORY");
  assertEquals(t.requires_new_kb_retrieval, false);
});

Deno.test("Task1 semantic: explicit handoff is represented in the same contract", () => {
  const t = classifyCanonicalConversationTurn("幫我轉真人客服。", history("幫我轉真人客服。"), { explicit_handoff: true });
  assertEquals(t.operation, "EXPLICIT_HANDOFF");
  assertEquals(t.requires_new_kb_retrieval, false);
  assertEquals(t.explicit_handoff, true);
});

Deno.test("Task1 semantic: prior grounded answer requires immutable lineage", () => {
  const bad = [
    { role: "visitor", content: "簡單一點。" },
    { role: "assistant", content: "Unverified previous answer", metadata: { citations: [{ label: "x" }] } },
    { role: "visitor", content: "原本問題" },
  ];
  assertEquals(findPriorGroundedAnswer(bad, "簡單一點。"), null);
  const t = classifyCanonicalConversationTurn("簡單一點。", bad);
  assertEquals(t.evidence_authority, "CURRENT_KB_REQUIRED");
});

Deno.test("Task1 adapter: conversation-intelligence uses canonical transform classification", () => {
  assertEquals(classifyConversationTurn("簡單一點解釋給我聽。").kind, "follow_up");
  assertEquals(classifyConversationTurn("Explain that in English.").kind, "follow_up");
  assertEquals(classifyConversationTurn("我講錯，應該是洗衣機。").kind, "correction");
});

Deno.test("Task1 retrieval: transform keeps prior customer topic in semantic query", () => {
  const q = buildCanonicalRetrievalQuery("簡單一點解釋給我聽。", history("簡單一點解釋給我聽。"));
  assertEquals(q.mode, "contextual");
  assertEquals(q.state.current_operation, "SIMPLIFY");
  assertEquals(q.state.evidence_authority, "PRIOR_GROUNDED_ANSWER");
  assertStringIncludes(q.query, "什么是四電一腦？");
});

Deno.test("Task1 jurisdiction: newest non-negated jurisdiction wins over cancelled Mars", () => {
  assertEquals(detectExplicitJurisdiction("算了，不談 Mars，回香港的規則。"), "hong_kong");
  const state = projectConversationRuntimeState([
    { role: "visitor", content: "算了，不談 Mars，回香港的規則。" },
    { role: "assistant", content: "之前無法確認 Mars 規則" },
    { role: "visitor", content: "Mars 的冷氣機回收費是多少？" },
    { role: "assistant", content: "四電一腦資料", metadata: groundedMeta },
    { role: "visitor", content: "什么是四電一腦？" },
  ]);
  assertEquals(state.jurisdiction, "hong_kong");
  assertEquals(state.current_operation, "RETURN_TO_PRIOR_TOPIC");
});

Deno.test("Task1 retrieval: topic correction does not lose the oldest policy anchor", () => {
  const rows = [
    { role: "visitor", content: "那官方的回收安排是什麼？" },
    { role: "assistant", content: "已回香港規則" },
    { role: "visitor", content: "算了，不談 Mars，回香港的規則。" },
    { role: "assistant", content: "Mars 無法確認" },
    { role: "visitor", content: "Mars 的冷氣機回收費是多少？" },
    { role: "assistant", content: "四電一腦資料", metadata: groundedMeta },
    { role: "visitor", content: "什么是四電一腦？" },
  ];
  const q = buildCanonicalRetrievalQuery("那官方的回收安排是什麼？", rows);
  assertEquals(q.mode, "contextual");
  assertStringIncludes(q.query, "什么是四電一腦？");
  assertEquals(q.state.jurisdiction, "hong_kong");
});
