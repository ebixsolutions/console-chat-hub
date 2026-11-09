/** SAME Task3C/P0-1. Must run in the complete authoritative repository.
 * Regression fixture is an accepted-frame shape with reduced customer history,
 * NOT original provider raw, NOT a fresh Hosted sample, NOT an original UAT ID.
 * No DB/model/KB requests are made by this file.
 */
import {
  resolveCurrentFactualRequest,
  type ResolveCurrentFactualRequestInput,
  type CurrentFactualRequest,
} from "../../supabase/functions/_shared/current-factual-request.ts";
import {
  factualDemandPlan,
  buildCurrentFactualRequestPrompt,
  currentFactualRequestReceipt,
} from "../../supabase/functions/_shared/factual-request-context.ts";
import type {
  CommerceSemanticDemand, CommerceSemanticFrame,
} from "../../supabase/functions/_shared/commerce-semantic-frame.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)]));
  return value;
}
function equal(actual: unknown, expected: unknown, message = "values differ") {
  if (JSON.stringify(stable(actual)) !== JSON.stringify(stable(expected))) {
    throw new Error(`${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
const clear = () => ({is_ambiguous: false, reasons: [] as string[], clarification_question: null});
function demand(quote: string, name: string | null,
  overrides: Partial<CommerceSemanticDemand> = {}): CommerceSemanticDemand {
  return {question: quote, source_quote: quote, subject_refs: [], source_type: "product",
    requested_facts: ["product_features"], constraints: name ? {name} : {},
    customer_correction: false, explicit_negations: [], ambiguity: clear(), ...overrides};
}
function input(question: string, demands: CommerceSemanticDemand[]): ResolveCurrentFactualRequestInput {
  const semantic: CommerceSemanticFrame = {
    version: "commerce-semantic-1.0.0", operation: "ASK_FACT", confidence: 0.9,
    language: "und", intent: "unknown", topic: null, entities: [], referents: [],
    customer_facts: [], requested_facts: [], explicit_negations: [],
    customer_correction: false, additive: false, transaction_state: "unknown",
    payment_state: "unknown", booking_state: "unknown", fulfillment_state: "unknown",
    ambiguity: clear(), demands,
  };
  return {question, source_message_id: "10000000-0000-4000-8000-000000000001",
    trusted_company_id: "20000000-0000-4000-8000-000000000001", history: [], semantic};
}
const q = "我想分開確認兩件事：Panasonic CW-SUL70BA 有咩主要功能？另外，西斜約80呎房間用呢款是否合適？如果需要現場資料先可以判斷，請講清楚；暫時唔查售價或庫存。";
function observedShape(): ResolveCurrentFactualRequestInput {
  return input(q, [
    demand("Panasonic CW-SUL70BA 有咩主要功能?", "Panasonic CW-SUL70BA",
      {question: "What are the main functions of Panasonic CW-SUL70BA?"}),
    demand("西斜約80呎房間用呢款是否合適?", "Panasonic CW-SUL70BA", {
      question: "Is Panasonic CW-SUL70BA suitable for a west-facing room of approximately 80 square feet?",
      requested_facts: ["product_suitability"],
      constraints: {name: "Panasonic CW-SUL70BA", attributes: {
        sunlight: "strong_afternoon_sun", room_size: {value: 80},
      }},
    }),
  ]);
}
function queryRows(result: CurrentFactualRequest): Array<Record<string, unknown>> {
  return JSON.parse(result.query ?? '{"questions":[]}').questions;
}
function pair(): ResolveCurrentFactualRequestInput {
  const a = "Orion-X100 features?", b = "Is it suitable for 80 sq ft?";
  return input(a + " " + b, [demand(a, "Orion-X100"), demand(b, "Orion-X100", {
    requested_facts: ["product_suitability"],
    constraints: {name: "Orion-X100", area: {value: 80, unit: "sq_ft"}},
  })]);
}
function rejects(second: ResolveCurrentFactualRequestInput, index = 1) {
  const result = resolveCurrentFactualRequest(second);
  assert(result.unresolved_demand_ids.includes(`demand-${index + 1}`), "unproven demand must remain unresolved");
  assert(!result.demands[index].subject_binding_proof, "no fabricated binding proof");
}

Deno.test("P0-1 accepted frame retains both demands through actual public resolver", () => {
  for (const prior of [false, true]) {
    const fixture = observedShape();
    if (prior) fixture.history = [{id: "10000000-0000-4000-8000-000000000002", role: "visitor", content: q}];
    const immutable = JSON.stringify(fixture);
    const result = resolveCurrentFactualRequest(fixture);
    equal(result.demands.length, 2);
    equal(queryRows(result).length, 2);
    equal(result.unresolved_demand_ids, []);
    equal(result.demands.map(d => d.subjects), [["CW-SUL70BA"], ["CW-SUL70BA"]]);
    equal(result.demands.map(d => d.subject_source_message_ids), [[fixture.source_message_id], [fixture.source_message_id]]);
    equal(result.demands[0].subject_binding_proof?.basis, "current_customer_literal");
    equal(result.demands[1].subject_binding_proof?.basis, "same_turn_unique_antecedent");
    equal(JSON.stringify(fixture), immutable, "accepted frame/history must not be mutated");
    equal(result.demands[1].constraints, fixture.semantic!.demands![1].constraints);
    assert(result.query!.includes("80呎"), "source-stated unit must remain visible, not guessed");
    assert(result.answer_request!.includes("暫時唔查售價或庫存"));
    equal(factualDemandPlan(result).map(p => p.action), ["KB_READ_ELIGIBLE", "KB_READ_ELIGIBLE"]);
  }
});

Deno.test("P0-1 generic service/subscription labels need no SKU and preserve false/zero/null", () => {
  for (const name of ["Nimbus plan", "Wellness consultation", "活動預約方案"]) {
    const a = `${name} features?`, b = "Is it suitable for 0 active users, no automatic renewal, and an undecided option?";
    const conditions = {name, required_users: 0, automatic_renewal: false, unknown_option: null};
    const result = resolveCurrentFactualRequest(input(a + " " + b,
      [demand(a, name), demand(b, name, {constraints: conditions})]));
    equal(queryRows(result).length, 2);
    equal(result.demands[1].constraints, conditions);
  }
});

Deno.test("P0-1 no source or company cannot grant empty-reference recovery", () => {
  const noSource = pair(); delete noSource.source_message_id; rejects(noSource);
  const noCompany = pair(); delete noCompany.trusted_company_id; rejects(noCompany);
});

Deno.test("P0-1 two potential antecedents stay unresolved", () => {
  const a = "Orion-X100 features?", b = "Nova-X200 features?", c = "Is it suitable for my room?";
  rejects(input(a + " " + b + " " + c,
    [demand(a, "Orion-X100"), demand(b, "Nova-X200"), demand(c, "Orion-X100")]), 2);
  const named = "Orion-X100 and Nova-X200 features?";
  rejects(input(named, [demand(named, "Orion-X100")]), 0);
});

Deno.test("P0-1 empty reference is not permission for an invented or partial label", () => {
  const partial = "Orion-X100Plus features?";
  rejects(input(partial, [demand(partial, "Orion-X100")]), 0);
  const invented = pair(); invented.semantic!.demands![1].constraints.name = "Nova-X200"; rejects(invented);
  const quote = "Is it suitable for my room?";
  rejects(input(quote, [demand(quote, "Orion-X100", {question: "Is Orion-X100 suitable?"})]), 0);
});

Deno.test("P0-1 same-turn boundaries outside source quote cannot be skipped", () => {
  for (const boundary of ["Different topic.", "Cancel Orion-X100.", "Nova-X200."]) {
    const fixture = pair();
    fixture.question = "Orion-X100 features? " + boundary + " Is it suitable for 80 sq ft?";
    rejects(fixture);
  }
  const negated = "Not Orion-X100 features?";
  rejects(input(negated, [demand(negated, "Orion-X100")]), 0);
});

Deno.test("P0-1 source quotes must be unique and precede anaphoric demand", () => {
  const future = pair();
  future.question = "Is it suitable for 80 sq ft? Orion-X100 features?";
  future.semantic!.demands!.reverse(); rejects(future, 0);
  const duplicate = pair();
  duplicate.question = "Orion-X100 features? Orion-X100 features? Is it suitable for 80 sq ft?";
  rejects(duplicate, 0);
});

Deno.test("P0-1 partial plan retains unresolved need rather than treating it as answered", () => {
  const fixture = pair(); fixture.semantic!.demands![1].constraints.name = "Nova-X200";
  const result = resolveCurrentFactualRequest(fixture);
  equal(queryRows(result).length, 1);
  equal(factualDemandPlan(result).map(p => p.action), ["KB_READ_ELIGIBLE", "PENDING_SOURCE_OR_SUBJECT"]);
  const prompt = buildCurrentFactualRequestPrompt(result);
  assert(prompt.includes('"demand-2"') && prompt.includes("PENDING_SOURCE_OR_SUBJECT"));
  assert(prompt.includes("not retrieval success or answer completion"));
  assert(prompt.includes("Do not let one pending demand erase another independently supported answer"));
});

Deno.test("P0-1 plan receipt exposes IDs but never raw names, constraints or a success claim", async () => {
  const result = resolveCurrentFactualRequest(pair());
  const receipt = await currentFactualRequestReceipt(result, result.query!, result.source_message_id);
  equal(receipt.planned_kb_demand_ids, ["demand-1", "demand-2"]);
  equal(receipt.planned_pending_demand_ids, []);
  const text = JSON.stringify(receipt);
  assert(!text.includes("Orion-X100") && !text.includes("sq_ft"));
  assert(!Object.hasOwn(receipt, "remote_dispatch_success"));
});
