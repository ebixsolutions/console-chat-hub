from pathlib import Path

runtime_path = Path("supabase/functions/_shared/commerce-state-runtime.ts")
gate_path = Path(".github/scripts/task_a3_final_gate.mjs")
test_path = Path(".github/scripts/task_a3_hotfix6_calculation_state_test.ts")

runtime = runtime_path.read_text()

old = '''export function detectAdditiveEntityCreationSignal(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  return /(?:另外|再加|再要|加多|多要|多買|多买|新增多|加裝多|加装多|another|extra|additional|add\\s+(?:another|one|two|three|\\d))/i.test(t);
}'''
new = '''export function detectAdditiveEntityCreationSignal(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  return /(?:另外\\s*(?:加|要|買|买|訂|订|新增|加裝|加装)|再加|再要|加多|多要|多買|多买|新增多|加裝多|加装多|another|extra|additional|add\\s+(?:another|one|two|three|\\d))/i.test(t);
}'''
assert old in runtime, "STOP: additive detector baseline mismatch"
runtime = runtime.replace(old, new, 1)

old = '''export function extractCommerceCalculationTerms(
  texts: string[],
  state: ConversationCommerceState,
): { terms: CommerceCalculationTerm[]; currency: string | null } {
  const amounts: number[] = [];
  for (const raw of texts) {
    const text = clean(raw);
    if (!text) continue;
    for (const amount of parseMoneyTerms(text)) amounts.push(amount);
  }
  const textAmounts = new Set(amounts);
  for (const quote of state.quotes) {
    if (quote.quote_type !== "customer_reported_historical") continue;
    if (textAmounts.has(quote.amount)) continue;
    amounts.push(quote.amount);
  }
  const unique: number[] = [];
  const seen = new Map<number, number>();
  for (const amount of amounts) {
    const count = seen.get(amount) ?? 0;
    if (count < 2) {
      seen.set(amount, count + 1);
      unique.push(amount);
    }
  }
  if (!unique.length) return { terms: [], currency: null };

  const activeEntities = state.entities.filter(
    (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
  );
  const multiplier = activeEntities.length === 1
    ? Math.max(1, activeEntities[0].quantity)
    : activeEntities.reduce((sum, entity) => sum + Math.max(0, entity.quantity), 0) || 1;

  const currency = state.quotes.find((q) => q.currency)?.currency ?? "HKD";
  return {
    terms: unique.map((amount, index) => ({ label: `customer_term_${index + 1}`, value: amount, multiplier })),
    currency,
  };
}'''
new = '''export function extractCommerceCalculationTerms(
  texts: string[],
  state: ConversationCommerceState,
  options?: { include_historical_state?: boolean },
): { terms: CommerceCalculationTerm[]; currency: string | null } {
  const amounts: number[] = [];
  for (const raw of texts) {
    const text = clean(raw);
    if (!text) continue;
    for (const amount of parseMoneyTerms(text)) amounts.push(amount);
  }
  if (options?.include_historical_state) {
    const textAmounts = new Set(amounts);
    for (const quote of state.quotes) {
      if (quote.quote_type !== "customer_reported_historical") continue;
      if (textAmounts.has(quote.amount)) continue;
      amounts.push(quote.amount);
    }
  }
  const unique: number[] = [];
  const seen = new Map<number, number>();
  for (const amount of amounts) {
    const count = seen.get(amount) ?? 0;
    if (count < 2) {
      seen.set(amount, count + 1);
      unique.push(amount);
    }
  }
  if (!unique.length) return { terms: [], currency: null };

  const currentTurnMultiplier = parseCount(texts[0] ?? "");
  const activeEntities = state.entities.filter(
    (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
  );
  const stateMultiplier = activeEntities.length === 1
    ? Math.max(1, activeEntities[0].quantity)
    : activeEntities.reduce((sum, entity) => sum + Math.max(0, entity.quantity), 0) || 1;
  const multiplier = currentTurnMultiplier ?? stateMultiplier;

  const currency = state.quotes.find((q) => q.currency)?.currency ?? "HKD";
  return {
    terms: unique.map((amount, index) => ({ label: `customer_term_${index + 1}`, value: amount, multiplier })),
    currency,
  };
}

function calculationExplicitlyUsesHistory(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  return /(?:(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier).{0,40}(?:數字|数字|價|价|報價|报价|price|quote|figure|amount).{0,40}(?:計|计|算|calculate|total|合共|總共|总共)|(?:計|计|算|calculate|total|合共|總共|总共).{0,40}(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier))/i.test(t);
}'''
assert old in runtime, "STOP: calculation extraction baseline mismatch"
runtime = runtime.replace(old, new, 1)

old = '''export function reduceTurn(
  previous: ConversationCommerceState,
  input: CommerceRuntimeInput,
  rawHints: CommerceTurnEntityHint[],
): ConversationCommerceState {
  const hints = filterGhostUnscopedHints(input.text, previous, rawHints);
  const derived = deriveCommerceEventsFromCustomerTurn({
    text: input.text,
    source_message_id: input.source_message_id,
    occurred_at: input.occurred_at ?? null,
    entity_hints: hints,
    current_language: input.language,
  });
  const reduced = reduceCommerceState(previous, [...derived, ...deriveA3RuntimeEvents(input, hints, previous)]);
  const guard = enforceQuotationNotOrderEvents(clean(input.text), reduced);
  return guard.length ? reduceCommerceState(reduced, guard) : reduced;
}'''
new = '''export function reduceTurn(
  previous: ConversationCommerceState,
  input: CommerceRuntimeInput,
  rawHints: CommerceTurnEntityHint[],
): ConversationCommerceState {
  const calculationTurn = detectExplicitCalculationRequest(input.text);
  const hints = calculationTurn ? [] : filterGhostUnscopedHints(input.text, previous, rawHints);
  const derived = calculationTurn ? [] : deriveCommerceEventsFromCustomerTurn({
    text: input.text,
    source_message_id: input.source_message_id,
    occurred_at: input.occurred_at ?? null,
    entity_hints: hints,
    current_language: input.language,
  });
  const runtimeEvents = calculationTurn ? [] : deriveA3RuntimeEvents(input, hints, previous);
  const reduced = reduceCommerceState(previous, [...derived, ...runtimeEvents]);
  const guard = enforceQuotationNotOrderEvents(clean(input.text), reduced);
  return guard.length ? reduceCommerceState(reduced, guard) : reduced;
}'''
assert old in runtime, "STOP: reduceTurn baseline mismatch"
runtime = runtime.replace(old, new, 1)

old = '''function buildCalculationAnswer(language: CommerceLanguage, calculation: { expression: string; result: number; currency?: string | null }): string {
  const currency = calculation.currency ?? "HKD";
  if (language === "en") return `Based only on the figures you gave me, the total is ${currency} ${calculation.result}. These are your own historical figures — the latest prices and engineering fees still need to be confirmed by our team.`;
  if (language === "zh-CN") return `只按你提供的数字计算，合共 ${currency} ${calculation.result}。这些是你提供的历史数字，最新价格与工程费用仍需同事确认。`;
  return `只按你提供嘅數字計，合共 ${currency} ${calculation.result}。呢啲係你之前提供嘅歷史數字，最新價格同工程費用仍然要同事確認。`;
}'''
new = '''function formatCalculationNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function renderCalculationExpression(calculation: { expression: string; result: number }): string {
  const parsed = calculation.expression.split(" + ").map((part) => {
    const match = part.match(/^[^:]+:([0-9.]+)×([0-9.]+)$/);
    return match ? { value: Number(match[1]), multiplier: Number(match[2]) } : null;
  });
  if (parsed.length && parsed.every(Boolean)) {
    const terms = parsed as Array<{ value: number; multiplier: number }>;
    const multiplier = terms[0].multiplier;
    if (terms.every((term) => term.multiplier === multiplier)) {
      const values = terms.map((term) => formatCalculationNumber(term.value)).join(" + ");
      return `${formatCalculationNumber(multiplier)} × (${values}) = ${formatCalculationNumber(calculation.result)}`;
    }
  }
  return `${calculation.expression} = ${formatCalculationNumber(calculation.result)}`;
}

function buildCalculationAnswer(language: CommerceLanguage, calculation: { expression: string; result: number; currency?: string | null }): string {
  const currency = calculation.currency ?? "HKD";
  const rendered = renderCalculationExpression(calculation);
  if (language === "en") return `Based only on the figures in this calculation: ${rendered} (${currency}). Latest prices and engineering fees still need to be confirmed by our team.`;
  if (language === "zh-CN") return `只按你这次提供的数字计算：${rendered}（${currency}）。最新价格与工程费用仍需同事确认。`;
  return `只按你今次提供嘅數字計：${rendered}（${currency}）。最新價格同工程費用仍然要同事確認。`;
}'''
assert old in runtime, "STOP: calculation answer baseline mismatch"
runtime = runtime.replace(old, new, 1)

old = '''  const summaryIntent = detectTransactionSummaryIntent(text);
  const wantsCalculation = detectExplicitCalculationRequest(text);
  const calculation = wantsCalculation ? extractCommerceCalculationTerms(conversationTexts, state) : { terms: [] as CommerceCalculationTerm[], currency: null };
  const decision = resolveCommerceAnswerAuthority({'''
new = '''  const summaryIntent = detectTransactionSummaryIntent(text);
  const wantsCalculation = detectExplicitCalculationRequest(text);
  const historicalCalculation = wantsCalculation && calculationExplicitlyUsesHistory(text);
  const calculationTexts = historicalCalculation ? conversationTexts : [text];
  const calculation = wantsCalculation
    ? extractCommerceCalculationTerms(calculationTexts, state, { include_historical_state: historicalCalculation })
    : { terms: [] as CommerceCalculationTerm[], currency: null };
  const decision = resolveCommerceAnswerAuthority({'''
assert old in runtime, "STOP: runtime calculation call baseline mismatch"
runtime = runtime.replace(old, new, 1)

runtime_path.write_text(runtime)

test_path.write_text(r'''import {
  buildCommerceEntityHints,
  detectAdditiveEntityCreationSignal,
  extractCommerceCalculationTerms,
  reduceTurn,
} from "../../supabase/functions/_shared/commerce-state-runtime.ts";
import { createEmptyConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { calculateCommerceTerms } from "../../supabase/functions/_shared/commerce-state-authority.ts";

const company = "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493";
const conversation = "22222222-2222-4222-8222-222222222222";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function apply(state: ReturnType<typeof createEmptyConversationCommerceState>, text: string, id: string) {
  const hints = buildCommerceEntityHints([text]);
  return reduceTurn(state, {
    conversation_id: conversation,
    company_id: company,
    source_message_id: id,
    text,
    language: "zh-TW",
  }, hints);
}

assert(detectAdditiveEntityCreationSignal("另外加1部冷氣。"), "explicit additive must remain true");
assert(!detectAdditiveEntityCreationSignal("另外每部材料費$550。"), "fee conjunction must not be additive");

let state = apply(createEmptyConversationCommerceState(), "我要3部冷氣。", "22222222-2222-4222-8222-222222222201");
assert(state.entities.length === 1 && state.entities[0].quantity === 3, "initial x3 failed");
state = apply(state, "更正，唔係3部，係2部。", "22222222-2222-4222-8222-222222222202");
assert(state.entities[0].quantity === 2, "correction x3 to x2 regressed");
const provenanceBeforeCalculation = state.entities[0].provenance.source_message_id;
const quotesBeforeCalculation = JSON.stringify(state.quotes);

const calculationText = "每部冷氣$5,600，安裝每部$550，另外每部材料費$550，2部總共幾錢？";
const terms = extractCommerceCalculationTerms([calculationText], state);
assert(terms.terms.length === 3, `expected 3 calculation terms, got ${terms.terms.length}`);
assert(terms.terms.map((term) => term.value).join(",") === "5600,550,550", "current-turn terms are wrong");
assert(terms.terms.every((term) => term.multiplier === 2), "explicit current-turn x2 must win as multiplier");
const calculation = calculateCommerceTerms(terms.terms, terms.currency);
assert(calculation?.result === 13400, `expected 13400, got ${calculation?.result}`);

const afterCalculation = apply(state, calculationText, "22222222-2222-4222-8222-222222222203");
assert(afterCalculation.entities[0].quantity === 2, "calculation turn mutated quantity");
assert(afterCalculation.entities[0].provenance.source_message_id === provenanceBeforeCalculation, "calculation turn rewrote entity provenance");
assert(JSON.stringify(afterCalculation.quotes) === quotesBeforeCalculation, "calculation turn mutated quotes");

const additive = apply(afterCalculation, "另外加1部冷氣。", "22222222-2222-4222-8222-222222222204");
const scoped = additive.entities.find((entity) => entity.entity_id === "air_conditioner:unscoped");
assert(scoped?.quantity === 3, `explicit additive after x2 must yield x3, got ${scoped?.quantity}`);

console.log(JSON.stringify({
  status: "PASS",
  gate: "TASK_A3_HOTFIX6_CALCULATION_STATE",
  assertions: {
    fee_conjunction_not_additive: true,
    correction_3_to_2_preserved: true,
    current_turn_terms_only: true,
    explicit_multiplier_2: true,
    deterministic_total_13400: true,
    calculation_state_read_only: true,
    provenance_preserved: true,
    explicit_additive_preserved: true
  }
}));
''')

gate = gate_path.read_text()
old_gate = '''execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", files.runtime, files.contract, files.reducer, files.authority], { stdio: "inherit" });'''
new_gate = '''execFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_hotfix6_calculation_state_test.ts"], { stdio: "inherit" });
execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", files.runtime, files.contract, files.reducer, files.authority], { stdio: "inherit" });'''
assert old_gate in gate, "STOP: final gate baseline mismatch"
gate = gate.replace(old_gate, new_gate, 1)
gate_path.write_text(gate)

Path(__file__).unlink()
print("HOTFIX6 APPLY PASS")
