import {
  buildPriorGroundedTransformGenerationSystem,
  buildPriorGroundedTransformGenerationUser,
  buildPriorGroundedTransformRetrySystem,
  type PriorGroundedTransformContext,
} from "../../supabase/functions/_shared/prior-grounded-transform.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

const ctx: PriorGroundedTransformContext = {
  operation: "SIMPLIFY",
  prior_answer: "「四電一腦」包括空調機、洗衣機、雪櫃、電視機及電腦。",
  selected_document_id: "doc-1",
  evidence_chunk_ids: ["chunk-1"],
  prior_source_message_id: "source-1",
  citations: [{
    label: "四電一腦",
    source_type: "policy",
    relevance: "high",
    document_id: "doc-1",
    chunk_id: "chunk-1",
    chunk_type: "full_content",
  }],
};

Deno.test("transform generation system uses only prior grounded factual authority", () => {
  const system = buildPriorGroundedTransformGenerationSystem(ctx);
  assert(system.includes("ONLY factual authority"));
  assert(system.includes(ctx.prior_answer));
  assert(system.includes("Do not use facts from conversation history"));
  assert(!system.includes("customer_tier"));
  assert(!system.includes("RAG"));
});

Deno.test("transform user input contains only latest instruction", () => {
  const user = buildPriorGroundedTransformGenerationUser("簡單一點解釋給我聽。");
  assert(user.includes("簡單一點解釋給我聽。"));
  assert(!user.includes(ctx.prior_answer));
  assert(user.includes("Do not answer any other question"));
});

Deno.test("retry remains strict rather than bypassing verifier", () => {
  const retry = buildPriorGroundedTransformRetrySystem(ctx);
  assert(retry.includes("STRICT RETRY"));
  assert(retry.includes(ctx.prior_answer));
  assert(retry.includes("Do not introduce even plausible explanatory facts"));
});

Deno.test("missing transform context cannot create isolated prompt", () => {
  assert(buildPriorGroundedTransformGenerationSystem(null) === "");
  assert(buildPriorGroundedTransformRetrySystem(null) === "");
});
