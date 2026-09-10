// TASK A3 production calculation-context adapter.
// Keeps the previously validated commerce runtime intact and only enriches an
// elliptical calculation turn with the nearest non-historical customer-provided
// monetary context. A1/A2 mutation/authority remain owned by the base runtime.

export * from "./commerce-state-runtime-base.ts";

import {
  detectCurrentPriceValidityQuestion,
  detectExplicitCalculationRequest,
  runCommerceStateRuntime as runCommerceStateRuntimeBase,
  type CommerceRuntimeInput,
  type CommerceRuntimeOutcome,
  type CommerceStateDbClient,
} from "./commerce-state-runtime-base.ts";

function cleanText(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 1600)
    : "";
}

function containsMoney(text: string): boolean {
  return /(?:HK\$|HKD|\$|元|價|价|費|费|收費|收费|fee|price)\s*(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.[0-9]{1,2})?|(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.[0-9]{1,2})?\s*(?:元|蚊|dollars?)/i.test(text);
}

function isHistoricalMoneyContext(text: string): boolean {
  return /(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier|old)/i.test(text)
    && /(?:報價|报价|價|价|price|quote|quotation|收費|收费|fee|HK\$|HKD|\$|元|蚊|dollars?)/i.test(text);
}

function calculationExplicitlyUsesHistory(text: string): boolean {
  return /(?:(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier).{0,40}(?:數字|数字|價|价|報價|报价|price|quote|figure|amount).{0,40}(?:計|计|算|calculate|total|合共|總共|总共)|(?:計|计|算|calculate|total|合共|總共|总共).{0,40}(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier))/i.test(text);
}

function enrichEllipticalCalculation(input: CommerceRuntimeInput): CommerceRuntimeInput {
  const current = cleanText(input.text);
  if (!detectExplicitCalculationRequest(current)) return input;
  if (containsMoney(current)) return input;
  if (detectCurrentPriceValidityQuestion(current)) return input;
  if (calculationExplicitlyUsesHistory(current)) return input;

  const history = (input.history ?? []).filter((turn) =>
    turn.role === "visitor" || turn.role === "user" || turn.role === "customer"
  );
  for (const turn of history) {
    const candidate = cleanText(turn.content);
    if (!candidate || candidate === current) continue;
    if (!containsMoney(candidate)) continue;
    if (isHistoricalMoneyContext(candidate)) continue;
    return {
      ...input,
      // Base runtime treats calculation turns as read-only state operations, so
      // continuity figures can safely be appended for deterministic arithmetic.
      text: `${current} ${candidate}`,
    };
  }
  return input;
}

export async function runCommerceStateRuntime(
  db: CommerceStateDbClient,
  input: CommerceRuntimeInput,
): Promise<CommerceRuntimeOutcome | null> {
  return await runCommerceStateRuntimeBase(db, enrichEllipticalCalculation(input));
}
