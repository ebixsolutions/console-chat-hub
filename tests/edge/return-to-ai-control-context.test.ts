import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildReturnToAiGenerationGuard } from "../../supabase/functions/_shared/return-to-ai-control.ts";

Deno.test("Return-to-AI guard activates only after explicit return and no human owner", () => {
  const guard = buildReturnToAiGenerationGuard("Return to AI", null);
  assertStringIncludes(guard, "AI_ACTIVE_AFTER_EXPLICIT_RETURN_TO_AI");
  assertStringIncludes(guard, "CURRENT visitor turn");
});

Deno.test("Return-to-AI guard is absent while human owner remains", () => {
  assertEquals(buildReturnToAiGenerationGuard("Return to AI", "agent-1"), "");
});

Deno.test("historical takeover or R1 event does not masquerade as Return-to-AI", () => {
  assertEquals(buildReturnToAiGenerationGuard("Agent takeover", null), "");
  assertEquals(buildReturnToAiGenerationGuard("Visitor explicitly requested human agent (R1)", null), "");
});
