import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildInheritedTransformCitationMetadata,
  buildPriorGroundedTransformBlock,
  resolvePriorGroundedTransform,
} from "../../supabase/functions/_shared/prior-grounded-transform.ts";
import {
  extractGroundingBlock,
  validateExactFactGrounding,
} from "../../supabase/functions/_shared/llm-router.ts";

const priorMeta = {
  source_message_id: "visitor-source-1",
  citations: [
    {
      label: "四電一腦政策",
      source_type: "policy",
      relevance: "high",
      document_id: "doc-hk-1",
      chunk_id: "chunk-hk-1",
      chunk_type: "full_content",
    },
  ],
  citation_lineage: {
    selected_document_id: "doc-hk-1",
    evidence_chunk_ids: ["chunk-hk-1"],
    evidence_count: 1,
  },
};

function history(latest: string, meta: unknown = priorMeta) {
  return [
    { role: "visitor", content: latest, metadata: {} },
    {
      role: "assistant",
      content: "在香港，四電一腦包括洗衣機、雪櫃、電視機、冷氣機和電腦產品。",
      metadata: meta,
    },
    { role: "visitor", content: "什么是四電一腦？", metadata: {} },
  ];
}

Deno.test("Task2 transform: simplification reuses prior grounded authority", () => {
  const ctx = resolvePriorGroundedTransform("簡單一點解釋給我聽。", history("簡單一點解釋給我聽。"));
  assert(ctx);
  assertEquals(ctx.operation, "SIMPLIFY");
  assertEquals(ctx.selected_document_id, "doc-hk-1");
  assertEquals(ctx.evidence_chunk_ids, ["chunk-hk-1"]);
});

Deno.test("Task2 transform: translation reuses the same grounded answer", () => {
  const ctx = resolvePriorGroundedTransform("Explain that in English.", history("Explain that in English."));
  assert(ctx);
  assertEquals(ctx.operation, "TRANSLATE");
  assertEquals(ctx.prior_source_message_id, "visitor-source-1");
});

Deno.test("Task2 transform: missing immutable source linkage fails closed", () => {
  const meta = structuredClone(priorMeta) as Record<string, unknown>;
  delete meta.source_message_id;
  assertEquals(resolvePriorGroundedTransform("換句話說一次。", history("換句話說一次。", meta)), null);
});

Deno.test("Task2 transform: citation/document mismatch fails closed", () => {
  const meta = structuredClone(priorMeta) as any;
  meta.citations[0].document_id = "doc-other";
  assertEquals(resolvePriorGroundedTransform("總結一下剛才的內容。", history("總結一下剛才的內容。", meta)), null);
});

Deno.test("Task2 transform: inherited citation metadata preserves exact lineage", () => {
  const ctx = resolvePriorGroundedTransform("總結一下剛才的內容。", history("總結一下剛才的內容。"));
  assert(ctx);
  const meta = buildInheritedTransformCitationMetadata(ctx) as any;
  assertEquals(meta.citation_lineage.selected_document_id, "doc-hk-1");
  assertEquals(meta.citation_lineage.evidence_chunk_ids, ["chunk-hk-1"]);
  assertEquals(meta.transform_lineage.authority, "PRIOR_GROUNDED_ANSWER");
  assertEquals(meta.transform_lineage.prior_source_message_id, "visitor-source-1");
  assertEquals(meta.response_route, "prior_grounded_transform");
});

Deno.test("Task2 transform: prompt exposes prior answer but not internal chunk/document ids", () => {
  const ctx = resolvePriorGroundedTransform("簡單一點解釋給我聽。", history("簡單一點解釋給我聽。"));
  assert(ctx);
  const block = buildPriorGroundedTransformBlock(ctx);
  assert(block.includes("Prior Grounded Answer Evidence:"));
  assert(block.includes("四電一腦"));
  assertFalse(block.includes("chunk-hk-1"));
  assertFalse(block.includes("doc-hk-1"));
});

Deno.test("Task2 router: prior-grounded evidence overrides unrelated current KB block", () => {
  const system = [
    "Knowledge Base grounding rules:",
    "Full Content Evidence:\n[chunk:wrong-current] unrelated evidence",
    "Prior Grounded Answer transform rules:",
    "- Operation: SIMPLIFY",
    "Prior Grounded Answer Evidence:\n產品保養期為 24 個月。",
  ].join("\n\n");
  const grounding = extractGroundingBlock(system);
  assert(grounding);
  assertEquals(grounding.authority, "PRIOR_GROUNDED_ANSWER");
  assert(grounding.evidence_text.includes("24 個月"));
  assertFalse(grounding.evidence_text.includes("wrong-current"));
});

Deno.test("Task2 router: transform exact facts may be preserved but new exact facts are rejected", () => {
  const system = [
    "Prior Grounded Answer transform rules:",
    "Prior Grounded Answer Evidence:\n產品保養期為 24 個月。",
  ].join("\n");
  const grounding = extractGroundingBlock(system);
  assert(grounding);
  assertEquals(validateExactFactGrounding("簡單說，保養期是 24 個月。", grounding.evidence_text), { ok: true });
  const bad = validateExactFactGrounding("簡單說，保養期是 36 個月。", grounding.evidence_text);
  assertFalse(bad.ok);
});
