import {
  buildInheritedTransformCitationMetadata,
  buildPriorGroundedTransformGenerationSystem,
  buildPriorGroundedTransformGenerationUser,
  buildPriorGroundedTransformRetrySystem,
  detectRequestedSummaryCount,
  detectRequestedTransformOperations,
  resolvePriorGroundedTransform,
} from "../../supabase/functions/_shared/prior-grounded-transform.ts";
import {
  buildVerifierEvidenceAliases,
  extractGroundingBlock,
} from "../../supabase/functions/_shared/llm-router.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

const latestGrounded = {
  role: "assistant",
  content: "在香港，冷氣機屬受管制電器，回收安排應按現行官方規則處理。",
  metadata: {
    source_message_id: "source-current",
    citations: [{
      label: "香港冷氣機回收安排",
      source_type: "policy",
      relevance: "high",
      document_id: "doc-current-aircon",
      chunk_id: "chunk-current-1",
      chunk_type: "full_content",
    }],
    citation_lineage: {
      selected_document_id: "doc-current-aircon",
      evidence_chunk_ids: ["chunk-current-1"],
      evidence_count: 1,
    },
  },
};

const olderGrounded = {
  role: "assistant",
  content: "「四電一腦」包括空調機、洗衣機、雪櫃、電視機及電腦。",
  metadata: {
    source_message_id: "source-old",
    citations: [{
      label: "四電一腦",
      source_type: "policy",
      relevance: "high",
      document_id: "doc-old-four-appliances",
      chunk_id: "chunk-old-1",
      chunk_type: "full_content",
    }],
    citation_lineage: {
      selected_document_id: "doc-old-four-appliances",
      evidence_chunk_ids: ["chunk-old-1"],
      evidence_count: 1,
    },
  },
};

const history = [
  { role: "visitor", content: "In English, summarize only the facts you can actually confirm." },
  latestGrounded,
  { role: "visitor", content: "那這個更正後的項目，官方安排怎樣？" },
  olderGrounded,
];

Deno.test("A17 detects TRANSLATE + SUMMARIZE as one composite request", () => {
  const ops = detectRequestedTransformOperations(
    "In English, summarize only the facts you can actually confirm.",
    "TRANSLATE",
  );
  assert(ops.length === 2, `unexpected operations: ${ops.join(",")}`);
  assert(ops.includes("TRANSLATE"), "translation operation missing");
  assert(ops.includes("SUMMARIZE"), "summary operation missing");
});

Deno.test("A17 binds to latest grounded answer and never older topic lineage", () => {
  const context = resolvePriorGroundedTransform(
    "In English, summarize only the facts you can actually confirm.",
    history,
  );
  assert(context !== null, "A17 transform context missing");
  assert(context.selected_document_id === "doc-current-aircon", `wrong current doc: ${context.selected_document_id}`);
  assert(context.prior_source_message_id === "source-current", "wrong current source message");
  assert(context.evidence_chunk_ids.length === 1 && context.evidence_chunk_ids[0] === "chunk-current-1", "wrong current evidence chunks");
  assert(!context.citations.some((c) => c.document_id === "doc-old-four-appliances"), "older topic citation leaked");
  assert(context.operations?.includes("TRANSLATE") && context.operations?.includes("SUMMARIZE"), "composite operations missing");
});

Deno.test("A17 prompt requires every composite operation on same factual authority", () => {
  const context = resolvePriorGroundedTransform(
    "In English, summarize only the facts you can actually confirm.",
    history,
  );
  assert(context !== null);
  const system = buildPriorGroundedTransformGenerationSystem(context);
  const user = buildPriorGroundedTransformGenerationUser("In English, summarize only the facts you can actually confirm.");
  assert(system.includes("TRANSLATE + SUMMARIZE"), "composite operation contract missing");
  assert(system.includes("Apply ALL listed operations"), "all-operation requirement missing");
  assert(system.includes(context.prior_answer), "current grounded authority missing");
  assert(!system.includes(olderGrounded.content), "older grounded answer leaked into authority block");
  assert(user.includes("every transformation explicitly requested"), "composite user instruction missing");
});

Deno.test("A17 exposes a safe evidence alias to the frozen verifier without raw lineage ids", () => {
  const context = resolvePriorGroundedTransform(
    "In English, summarize only the facts you can actually confirm.",
    history,
  );
  assert(context !== null);
  const system = buildPriorGroundedTransformGenerationSystem(context);
  const grounding = extractGroundingBlock(system);
  assert(grounding !== null, "frozen verifier grounding block not extractable");
  assert(grounding.authority === "PRIOR_GROUNDED_ANSWER", `wrong authority: ${grounding.authority}`);
  const aliases = buildVerifierEvidenceAliases(grounding);
  assert(aliases.allowed_ids.length === 1 && aliases.allowed_ids[0] === "E1", `safe verifier alias missing: ${aliases.allowed_ids.join(",")}`);
  assert(!aliases.evidence_text.includes("doc-current-aircon"), "raw document id leaked to verifier evidence");
  assert(!aliases.evidence_text.includes("chunk-current-1"), "raw chunk id leaked to verifier evidence");
});

Deno.test("A17 inherited metadata preserves current document/chunk lineage and composite operations", () => {
  const context = resolvePriorGroundedTransform(
    "In English, summarize only the facts you can actually confirm.",
    history,
  );
  assert(context !== null);
  const metadata = buildInheritedTransformCitationMetadata(context) as Record<string, any>;
  assert(metadata.response_route === "prior_grounded_transform", "wrong response route");
  assert(metadata.citation_lineage.selected_document_id === "doc-current-aircon", "wrong selected document lineage");
  assert(metadata.citation_lineage.evidence_chunk_ids[0] === "chunk-current-1", "wrong chunk lineage");
  assert(metadata.transform_lineage.composite === true, "composite lineage flag missing");
  assert(metadata.transform_lineage.operations.includes("TRANSLATE"), "translate lineage missing");
  assert(metadata.transform_lineage.operations.includes("SUMMARIZE"), "summary lineage missing");
});

Deno.test("single-step transforms remain single-step", () => {
  const ops = detectRequestedTransformOperations("Explain that in English.", "TRANSLATE");
  assert(ops.length === 1 && ops[0] === "TRANSLATE", `single transform changed: ${ops.join(",")}`);
});

Deno.test("A20 detects Chinese and English fixed summary counts", () => {
  assert(detectRequestedSummaryCount("最後只根據已確認資料，用三點總結。") === 3, "Chinese three-point count missing");
  assert(detectRequestedSummaryCount("請用 3 點總結已確認資料") === 3, "numeric Chinese count missing");
  assert(detectRequestedSummaryCount("Summarize the confirmed facts in 3 bullets.") === 3, "English bullet count missing");
  assert(detectRequestedSummaryCount("簡單總結") === null, "count invented for unbounded summary");
});

Deno.test("A20 fixed-count summary contract makes grounding higher priority than count", () => {
  const context = resolvePriorGroundedTransform(
    "最後只根據已確認資料，用三點總結。",
    [
      { role: "visitor", content: "最後只根據已確認資料，用三點總結。" },
      latestGrounded,
      ...history.slice(2),
    ],
  );
  assert(context !== null, "A20 transform context missing");
  assert(context.operation === "SUMMARIZE", `wrong A20 operation: ${context.operation}`);
  assert(context.requested_summary_count === 3, `wrong requested count: ${context.requested_summary_count}`);
  const system = buildPriorGroundedTransformGenerationSystem(context);
  const user = buildPriorGroundedTransformGenerationUser("最後只根據已確認資料，用三點總結。");
  const retry = buildPriorGroundedTransformRetrySystem(context);
  assert(system.includes("Return AT MOST 3 supported points"), "A20 bounded count rule missing");
  assert(system.includes("Grounding has higher priority"), "A20 grounding priority missing");
  assert(system.includes("return fewer points"), "A20 insufficient-evidence rule missing");
  assert(system.includes("Never split one factual claim"), "A20 anti-padding rule missing");
  assert(user.includes("return fewer points rather than inventing filler"), "A20 user anti-filler rule missing");
  assert(retry.includes("soft formatting target only"), "A20 retry still treats count as hard factual requirement");
  assert(!retry.includes("do not drop the requested target language or summary constraint"), "old hard summary-constraint retry survived");
});

Deno.test("A20 fixed-count lineage records the request without changing factual authority", () => {
  const context = resolvePriorGroundedTransform(
    "最後只根據已確認資料，用三點總結。",
    [
      { role: "visitor", content: "最後只根據已確認資料，用三點總結。" },
      latestGrounded,
      ...history.slice(2),
    ],
  );
  assert(context !== null);
  const metadata = buildInheritedTransformCitationMetadata(context) as Record<string, any>;
  assert(metadata.transform_lineage.requested_summary_count === 3, "fixed summary count lineage missing");
  assert(metadata.transform_lineage.authority === "PRIOR_GROUNDED_ANSWER", "A20 authority changed");
  assert(metadata.citation_lineage.selected_document_id === "doc-current-aircon", "A20 document lineage changed");
  assert(metadata.citation_lineage.evidence_chunk_ids[0] === "chunk-current-1", "A20 evidence lineage changed");
});