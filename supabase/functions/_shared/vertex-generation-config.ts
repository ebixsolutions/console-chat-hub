/**
 * Pure Vertex generation-config builder.
 *
 * Kept free of provider SDK imports so the exact request policy can be tested
 * without credentials or environment access.
 */
export function buildVertexGenerationConfig(
  maxTokens: number,
  jsonOutput: boolean,
  responseSchema: Record<string, unknown> | undefined,
  thinkingBudget: number | undefined,
): Record<string, unknown> {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("vertex_max_tokens_invalid");
  }
  if (thinkingBudget !== undefined && (!Number.isInteger(thinkingBudget) || thinkingBudget < 0)) {
    throw new Error("vertex_thinking_budget_invalid");
  }
  return {
    maxOutputTokens: maxTokens,
    temperature: 0,
    ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
    ...(jsonOutput ? { responseMimeType: "application/json" } : {}),
    ...(jsonOutput && responseSchema ? { responseSchema } : {}),
  };
}
