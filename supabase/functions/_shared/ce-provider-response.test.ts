import {
  CE_CORRECTION_MAX_CHARS,
  CE_EVIDENCE_MAX_CHARS,
  CE_EVALUATOR_MAX_TOKENS,
  CE_EVALUATOR_THINKING_BUDGET,
  CE_JUSTIFICATION_MAX_CHARS,
  ceEvaluatorProviderPolicy,
  ceSignalsProviderPolicy,
  normalizeCeProviderResponse,
  validateCeProviderResponse,
} from "./ce-provider-response.ts";
import { EVALUATOR_RESPONSE_SCHEMA } from "./ce-contract.ts";
import { buildVertexGenerationConfig } from "./vertex-generation-config.ts";

const known = new Set(["chunk-a"]);
const canonical = {
  score: 82,
  justification: "The reply follows the latest customer correction and current state.",
  evidence: ["The latest customer message is used."],
  grounding_refs: ["chunk-a"],
  recommended_correction: "",
};
const json = JSON.stringify(canonical);

function assert(condition: unknown, message = "assertion_failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function valid(raw: unknown) {
  const result = validateCeProviderResponse(raw, known);
  assert(result.ok, result.ok ? "" : result.reason);
  return result;
}

Deno.test("provider 01 canonical JSON", () => assert(valid(json).value.score === 82));
Deno.test("provider 02 fenced JSON", () =>
  assert(valid(`\`\`\`json\n${json}\n\`\`\``).value.score === 82),
);
Deno.test("provider 03 prose wrapped JSON", () =>
  assert(valid(`result follows: ${json} done`).value.score === 82),
);
Deno.test("provider 04 direct object", () => assert(valid(canonical).value.score === 82));
Deno.test("provider 05 parsed object wrapper", () =>
  assert(valid({ parsed: canonical }).value.score === 82),
);
Deno.test("provider 06 output string wrapper", () =>
  assert(valid({ output: json }).value.score === 82),
);
Deno.test("provider 07 result object wrapper", () =>
  assert(valid({ result: canonical }).value.score === 82),
);
Deno.test("provider 08 response string wrapper", () =>
  assert(valid({ response: json }).value.score === 82),
);
Deno.test("provider 09 json object wrapper", () =>
  assert(valid({ json: canonical }).value.score === 82),
);
Deno.test("provider 10 multiple content blocks", () => {
  const split = Math.floor(json.length / 2);
  assert(
    valid({
      content: [
        { type: "text", text: json.slice(0, split) },
        { type: "text", text: json.slice(split) },
      ],
    }).value.score === 82,
  );
});
Deno.test("provider 11 Vertex JSON part", () =>
  assert(
    valid({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: json }] } }] }).value
      .score === 82,
  ),
);
Deno.test("provider 12 Vertex thought excluded", () =>
  assert(
    valid({
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ thought: true, text: "private reasoning" }, { text: json }] },
        },
      ],
    }).value.score === 82,
  ),
);
Deno.test("provider 13 numeric string score", () =>
  assert(valid({ ...canonical, score: "82.5" }).value.score === 82.5),
);
Deno.test("provider 14 evidence single string", () =>
  assert(valid({ ...canonical, evidence: "A grounded quote." }).value.evidence.length === 1),
);
Deno.test("provider 15 null correction", () =>
  assert(valid({ ...canonical, recommended_correction: null }).value.recommended_correction === ""),
);
Deno.test("provider 16 unknown grounding refs dropped", () =>
  assert(valid({ ...canonical, grounding_refs: ["unknown"] }).value.grounding_refs.length === 0),
);
Deno.test("provider 17 harmless metadata", () =>
  assert(valid({ ...canonical, provider_request_id: "redacted" }).value.score === 82),
);
Deno.test("provider 18 surrounding whitespace", () =>
  assert(valid(`  \n${json}\n  `).value.score === 82),
);
Deno.test("provider 19 missing score rejected", () =>
  assert(!validateCeProviderResponse({ ...canonical, score: undefined }, known).ok),
);
Deno.test("provider 20 null score rejected", () =>
  assert(!validateCeProviderResponse({ ...canonical, score: null }, known).ok),
);
Deno.test("provider 21 object score rejected", () =>
  assert(!validateCeProviderResponse({ ...canonical, score: { value: 82 } }, known).ok),
);
Deno.test("provider 22 out of range score rejected", () =>
  assert(!validateCeProviderResponse({ ...canonical, score: 101 }, known).ok),
);
Deno.test("provider 23 short justification rejected", () =>
  assert(!validateCeProviderResponse({ ...canonical, justification: "too short" }, known).ok),
);
Deno.test("provider 24 missing evidence rejected", () =>
  assert(!validateCeProviderResponse({ ...canonical, evidence: undefined }, known).ok),
);
Deno.test("provider 25 empty evidence rejected", () =>
  assert(!validateCeProviderResponse({ ...canonical, evidence: [] }, known).ok),
);
Deno.test("provider 26 invalid grounding type rejected", () =>
  assert(!validateCeProviderResponse({ ...canonical, grounding_refs: "chunk-a" }, known).ok),
);
Deno.test("provider 27 invalid JSON rejected", () =>
  assert(!validateCeProviderResponse("{bad json}", known).ok),
);
Deno.test("provider 28 empty output rejected", () =>
  assert(!validateCeProviderResponse("", known).ok),
);
Deno.test("provider 29 refusal rejected", () =>
  assert(!validateCeProviderResponse({ refusal: "cannot comply" }, known).ok),
);
Deno.test("provider 30 truncated JSON rejected", () =>
  assert(!validateCeProviderResponse(json.slice(0, -2), known).ok),
);
Deno.test("provider 31 unknown wrapper rejected", () =>
  assert(!validateCeProviderResponse({ payload: canonical }, known).ok),
);
Deno.test("provider 32 Vertex MAX_TOKENS rejected", () =>
  assert(
    !validateCeProviderResponse(
      { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: json }] } }] },
      known,
    ).ok,
  ),
);
Deno.test("provider 33 Vertex safety block rejected", () =>
  assert(
    !validateCeProviderResponse(
      { promptFeedback: { blockReason: "SAFETY" }, candidates: [] },
      known,
    ).ok,
  ),
);
Deno.test("provider 34 array root rejected", () =>
  assert(!validateCeProviderResponse([canonical], known).ok),
);
Deno.test("provider 35 manual automatic parity", () => {
  const manual = validateCeProviderResponse(json, known);
  const automatic = validateCeProviderResponse(json, known);
  assert(JSON.stringify(manual) === JSON.stringify(automatic));
});
Deno.test("provider 36 invalid output has no persistence side effect", () => {
  let writes = 0;
  if (validateCeProviderResponse("{", known).ok) writes++;
  assert(writes === 0);
});
Deno.test("provider 37 invalid output has no handoff side effect", () => {
  let handoffs = 0;
  if (validateCeProviderResponse({ refusal: "blocked" }, known).ok) handoffs++;
  assert(handoffs === 0);
});
Deno.test("provider 38 governed evaluator ceiling remains hard bounded", () =>
  assert(CE_EVALUATOR_MAX_TOKENS === 4096),
);
Deno.test("provider 39 normalization never repairs truncation", () =>
  assert(normalizeCeProviderResponse('{"score":82') === null),
);
Deno.test("provider 40 canonical CE policy disables Gemini 2.5 Flash thinking", () => {
  const policy = ceEvaluatorProviderPolicy();
  assert(CE_EVALUATOR_THINKING_BUDGET === 0);
  assert(policy.thinkingBudget === 0);
});
Deno.test("provider 41 automatic and manual evaluator policy is identical", () => {
  const automatic = ceEvaluatorProviderPolicy();
  const manual = ceEvaluatorProviderPolicy();
  assert(JSON.stringify(automatic) === JSON.stringify(manual));
  assert(automatic.responseSchema === EVALUATOR_RESPONSE_SCHEMA);
});
Deno.test("provider 42 signals share the canonical generation controls", () => {
  const evaluator = ceEvaluatorProviderPolicy();
  const signals = ceSignalsProviderPolicy();
  assert(signals.maxTokens === evaluator.maxTokens);
  assert(signals.thinkingBudget === evaluator.thinkingBudget);
  assert(signals.responseFormat === evaluator.responseFormat);
});
Deno.test("provider 43 Vertex request preserves an explicit zero thinking budget", () => {
  const policy = ceEvaluatorProviderPolicy();
  const config = buildVertexGenerationConfig(
    policy.maxTokens,
    true,
    policy.responseSchema,
    policy.thinkingBudget,
  );
  assert(
    JSON.stringify(config).includes('"thinkingConfig":{"thinkingBudget":0}'),
    "thinking_config_missing",
  );
  assert(config.maxOutputTokens === CE_EVALUATOR_MAX_TOKENS);
  assert(config.responseMimeType === "application/json");
});
Deno.test("provider 44 non-CE Vertex calls retain default thinking behavior", () => {
  const config = buildVertexGenerationConfig(256, false, undefined, undefined);
  assert(!("thinkingConfig" in config));
});
Deno.test("provider 45 invalid thinking budgets are rejected before request", () => {
  let rejected = false;
  try {
    buildVertexGenerationConfig(256, true, undefined, -1);
  } catch {
    rejected = true;
  }
  assert(rejected);
});
Deno.test("provider 46 concise valid structured result is below configured ceiling", () => {
  const result = valid(canonical);
  assert(result.value.justification.length <= CE_JUSTIFICATION_MAX_CHARS);
  assert(JSON.stringify(result.raw).length < CE_EVALUATOR_MAX_TOKENS);
});
Deno.test("provider 47 maximum bounded text lengths remain valid", () => {
  assert(
    validateCeProviderResponse(
      {
        ...canonical,
        justification: "j".repeat(CE_JUSTIFICATION_MAX_CHARS),
        evidence: ["e".repeat(CE_EVIDENCE_MAX_CHARS)],
        recommended_correction: "c".repeat(CE_CORRECTION_MAX_CHARS),
      },
      known,
    ).ok,
  );
});
Deno.test("provider 48 overlong justification fails closed", () =>
  assert(
    !validateCeProviderResponse(
      { ...canonical, justification: "j".repeat(CE_JUSTIFICATION_MAX_CHARS + 1) },
      known,
    ).ok,
  ),
);
Deno.test("provider 49 overlong evidence fails closed", () =>
  assert(
    !validateCeProviderResponse(
      { ...canonical, evidence: ["e".repeat(CE_EVIDENCE_MAX_CHARS + 1)] },
      known,
    ).ok,
  ),
);
Deno.test("provider 50 overlong correction fails closed", () =>
  assert(
    !validateCeProviderResponse(
      { ...canonical, recommended_correction: "c".repeat(CE_CORRECTION_MAX_CHARS + 1) },
      known,
    ).ok,
  ),
);
Deno.test("provider 51 excessive evidence count fails closed", () =>
  assert(
    !validateCeProviderResponse({ ...canonical, evidence: ["one", "two", "three", "four"] }, known)
      .ok,
  ),
);
Deno.test("provider 52 timeout and provider errors cannot validate", () => {
  assert(!validateCeProviderResponse({ error: "LLM_TIMEOUT" }, known).ok);
  assert(!validateCeProviderResponse({ error: "LLM_NETWORK" }, known).ok);
});
