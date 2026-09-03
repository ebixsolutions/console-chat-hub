import { GROUNDING_VERIFIER_MAX_TOKENS } from "../../supabase/functions/_shared/llm-router.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("grounding verifier budget is production-safe for reasoning models", () => {
  assert(
    GROUNDING_VERIFIER_MAX_TOKENS >= 2048,
    `grounding verifier budget must be >= 2048, got ${GROUNDING_VERIFIER_MAX_TOKENS}`,
  );
});

Deno.test("all grounding verifier provider calls use the shared budget", async () => {
  const source = await Deno.readTextFile("supabase/functions/_shared/llm-router.ts");
  assert(
    source.includes("redact(verifierUser),\n      GROUNDING_VERIFIER_MAX_TOKENS,\n      true,"),
    "Vertex verifier must use shared production-safe budget",
  );
  assert(
    source.includes("redact(verifierUser),\n      GROUNDING_VERIFIER_MAX_TOKENS,\n    );"),
    "Anthropic verifier must use shared production-safe budget",
  );
  assert(
    source.includes("maxTokens: GROUNDING_VERIFIER_MAX_TOKENS,\n    operationId: `${call.operationId}:grounding-verifier`,"),
    "verifier usage/audit call must record the same budget",
  );
  assert(
    !source.includes("redact(verifierUser),\n      512,"),
    "legacy 512-token provider verifier budget must not remain",
  );
});
