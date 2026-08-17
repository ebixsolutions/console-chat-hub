import {
  computeMethodology,
  LOCAL_EVALUATOR_SYSTEM_PROMPT,
} from "../../supabase/functions/_shared/ce-automation-engine.ts";
import {
  CE_DIMENSIONS,
  DIMENSION_WEIGHT,
  EVALUATOR_PROMPT_VERSION,
} from "../../supabase/functions/_shared/ce-contract.ts";

function assert(v: unknown, msg: string): asserts v {
  if (!v) throw new Error(msg);
}

Deno.test("Task2 methodology is deterministic and covers all six dimensions", async () => {
  assert(CE_DIMENSIONS.length === 6, "six dimensions");
  assert(Object.keys(LOCAL_EVALUATOR_SYSTEM_PROMPT).length === 6, "six local prompts");
  const weights = CE_DIMENSIONS.reduce((n,d)=>n+DIMENSION_WEIGHT[d],0);
  assert(Math.abs(weights-1) < 1e-9, "weights sum to one");
  const a=await computeMethodology();
  const b=await computeMethodology();
  assert(a.promptVersion===EVALUATOR_PROMPT_VERSION, "prompt version");
  assert(a.promptHash===b.promptHash, "prompt hash deterministic");
  assert(a.scoringHash===b.scoringHash, "scoring hash deterministic");
  assert(a.schemaHash===b.schemaHash, "schema hash deterministic");
  for (const h of [a.promptHash,a.scoringHash,a.schemaHash]) {
    assert(/^[0-9a-f]{64}$/.test(h), "sha256");
  }
});
