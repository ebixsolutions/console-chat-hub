import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractGroundingBlock, validateExactFactGrounding } from "../../supabase/functions/_shared/llm-router.ts";

Deno.test("Task2 translated unit is exact-fact equivalent", () => {
  assertEquals(validateExactFactGrounding("The refrigerator has a total volume of no more than 500 litres.", "雪櫃（總容積 ≤ 500公升）"), { ok: true });
  const bad = validateExactFactGrounding("The refrigerator has a total volume of no more than 600 litres.", "雪櫃（總容積 ≤ 500公升）");
  assert(!bad.ok);
});

Deno.test("Task2 prior-grounded block carries TRANSLATE operation to verifier", () => {
  const system = [
    "Prior Grounded Answer transform rules:",
    "- Operation: TRANSLATE",
    "- Operations: TRANSLATE + SIMPLIFY",
    "Prior Grounded Answer Evidence:",
    "[chunk:PRIOR1]",
    "「四電一腦」包括空調機、洗衣機、雪櫃（總容積 ≤ 500公升）、電視機、電腦、列印機、掃描器及顯示器。",
  ].join("\n");
  const block = extractGroundingBlock(system);
  assert(block);
  assertEquals(block.authority, "PRIOR_GROUNDED_ANSWER");
  assertEquals(block.transform_operations, ["TRANSLATE", "SIMPLIFY"]);
});
