/** Source-bound dimension writer regressions. Synthetic storage/Reading inputs;
 * actual runtime code, no Hosted/model/RLS claim. Original callbacks unchanged. */
import { createEmptyConversationCommerceState, type ConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { persistCommerceTurn, runCommerceStateRuntime, sourceBoundDimensionComparison, readSourceBoundDimensionComparison, type CommerceRuntimeInput, type CommerceStateDbClient } from "../../supabase/functions/_shared/commerce-state-runtime-base.ts";
import { normalizeCommerceSemanticFrame, type CommerceSemanticFrame } from "../../supabase/functions/_shared/commerce-semantic-frame.ts";
import { applyCustomerRequestDecision, resolveCustomerRequestDecision } from "../../supabase/functions/_shared/commerce-state-authority.ts";
import { buildCanonicalConversationMemory, buildBoundedConversationContext } from "../../supabase/functions/_shared/conversation-long-memory.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const owner = { company_id: "dimension-source-company", conversation_id: "dimension-source-ticket" };
const capabilities = { requires_delivery: false, supports_pickup: false, requires_installation: false,
  requires_booking: false, requires_quote: false, requires_site_check: false, digital_fulfilment: false,
  recurring_billing: false, rental_return: false, customization: false };
function reading(operation: CommerceSemanticFrame["operation"] = "UPDATE_ITEM"): CommerceSemanticFrame {
  return { version: "commerce-semantic-1.0.0", language: "en", operation,
    intent: "customer_requirement_update", topic: "display-rental", entities: [], referents: [], requested_facts: [],
    customer_correction: false, additive: false, explicit_negations: [], transaction_state: "none",
    payment_state: "none", booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: 0.99 };
}
function entity(id: string, name: string, quantity: number, category = "training-sessions") {
  return { entity_id: id, category, quantity, status: "tentative" as const,
    attributes: { product_name: name, unit: "sessions", quantity_basis: "customer_explicit" },
    constraints: {}, provenance: { source_type: "customer" as const, source_message_id: `prior-${id}` } };
}
function initialState(): ConversationCommerceState {
  const state = createEmptyConversationCommerceState(); state.language = "en";
  state.entities = [entity("retained", "Atlas training sessions", 2), entity("paused", "Beta training sessions", 1),
    entity("display", "Portable exhibition frame", 1, "display-rental")];
  state.conversion.tentative_entity_ids = state.entities.map(value => value.entity_id);
  return state;
}
function storage(initial = initialState(), revision = 21) {
  const live = { state: structuredClone(initial), revision, writes: 0, seen: new Set<string>(), source_message_id: "prior-source",
    company_id: owner.company_id, conversation_id: owner.conversation_id, fail: false };
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
      company_id: live.company_id, conversation_id: live.conversation_id, revision: live.revision,
      source_message_id: live.source_message_id, state: structuredClone(live.state) }, error: null }) }) }) }),
    rpc: async (_name, args) => {
      live.writes++;
      assert(args.p_company_id === owner.company_id && args.p_conversation_id === owner.conversation_id,
        "Native writer received another owner");
      if (live.fail) return { data: null, error: { message: "synthetic storage failure" } };
      if (args.p_expected_revision !== live.revision) return { data: { result: "revision_conflict" }, error: null };
      const source = String(args.p_source_message_id);
      if (live.seen.has(source)) return { data: { result: "source_message_already_applied", applied_revision: live.revision }, error: null };
      live.state = structuredClone(args.p_state as ConversationCommerceState); live.revision++; live.seen.add(source);
      live.source_message_id = source;
      return { data: { result: "success", applied_revision: live.revision }, error: null };
    },
  };
  return { live, db };
}
function turn(text: string, value = 600, key = "max_width_mm", ref = "display", source_message_id = "dimension-source"): CommerceRuntimeInput {
  const frame = reading();
  frame.entities = [{ entity_ref: ref, name: "Portable exhibition frame", kind: "physical_product", category_hint: "display-rental",
    model: null, sku: null, quantity: null, unit: null, attributes: {}, constraints: { [key]: value },
    capabilities, confidence: 0.99 }];
  frame.referents = [{ ref, source: "persistent_state", confidence: 0.99 }];
  frame.demands = [{ question: text, source_quote: text, subject_refs: [ref], source_type: "general", requested_facts: [],
    constraints: {}, customer_correction: false, explicit_negations: [],
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  const normalized = normalizeCommerceSemanticFrame(frame);
  assert(normalized, "Dimension fixture must satisfy the existing semantic schema");
  return { ...owner, text, semantic_frame: normalized, source_message_id, language: "en" };
}

for (const mode of ["value-not-in-source", "wrong-reference", "no-source-number", "wrong-dimension", "missing-reading"] as const) {
  Deno.test(`P1 dimension source negative ${mode}: no unverified constraint reaches storage`, async () => {
    const s = storage(), text = mode === "no-source-number"
      ? "Portable exhibition frame must be narrow." : "Portable exhibition frame must be at most 600mm wide.";
    const input = turn(text, mode === "value-not-in-source" ? 590 : 600,
      mode === "wrong-dimension" ? "max_height_mm" : "max_width_mm", mode === "wrong-reference" ? "retained" : "display");
    if (mode === "missing-reading") input.semantic_frame = null;
    const before = JSON.stringify(s.live.state), result = await runCommerceStateRuntime(s.db, input);
    console.log(JSON.stringify({ dimension_case: mode, writes: s.live.writes, revision: s.live.revision,
      entities: s.live.state.entities.map(e => ({ id: e.entity_id, constraints: e.constraints, quantity: e.quantity })),
      result: result ? { route: result.route, reason: result.reason, persist_result: result.persist_result } : null }));
    assert(s.live.writes === 0 && s.live.revision === 21 && JSON.stringify(s.live.state) === before,
      `Unverified ${mode} changed canonical state`);
    assert(result?.persist_result !== "success", `Unverified ${mode} claimed success`);
  });
}

Deno.test("P1 dimension source positive: stated limit, correction and comparison use the same canonical item", async () => {
  const s = storage(), original = structuredClone(s.live.state);
  await runCommerceStateRuntime(s.db, turn("Portable exhibition frame must be at most 600mm wide."));
  assert(s.live.state.entities[2].constraints.max_width_mm === 600 && s.live.revision === 22, "Stated limit was not stored");
  const input = turn("Correction: Portable exhibition frame width limit is 595mm, not 600mm.", 595, "max_width_mm", "display", "dimension-correction");
  input.semantic_frame!.customer_correction = true;
  await runCommerceStateRuntime(s.db, input);
  assert(Number(s.live.state.entities[2].constraints.max_width_mm) === 595 && Number(s.live.revision) === 23,
    "Latest correction did not replace the old limit");
  const text = "Would Portable exhibition frame width 598mm fit?", frame = reading("ASK_FACT");
  frame.intent = "compare a product dimension against the current constraint"; frame.requested_facts = ["width"];
  frame.referents = [{ ref: "display", source: "persistent_state", confidence: 0.99 }];
  frame.demands = [{ question: text, source_quote: text, subject_refs: ["display"], source_type: "general", requested_facts: ["width"],
    constraints: {}, customer_correction: false, explicit_negations: [],
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  const before = JSON.stringify(s.live.state), writes = s.live.writes;
  const result = await runCommerceStateRuntime(s.db, { ...owner, text, semantic_frame: frame, source_message_id: "dimension-comparison", language: "en" });
  assert(typeof result?.reply === "string" && result.state_path === "entities.2.constraints.max_width_mm" &&
    result.reply.includes("598") && result.reply.includes("595") && result.persist_result === "read_only", JSON.stringify(result));
  assert(s.live.writes === writes && JSON.stringify(s.live.state) === before &&
    JSON.stringify(s.live.state.entities.slice(0,2)) === JSON.stringify(original.entities.slice(0,2)), "Comparison or correction changed another item");
});

const businessDimensions = [
  { business: "exhibition rental", name: "Portable exhibition frame", axis: "width", unit: "mm", value: 600, mm: 600, corrected: 595, correctedMm: 595, itemUnit: "frames" },
  { business: "custom printing", name: "Conference welcome banner", axis: "height", unit: "cm", value: 120, mm: 1200, corrected: 119.5, correctedMm: 1195, itemUnit: "banners" },
  { business: "freight packaging", name: "Reusable shipping crate", axis: "depth", unit: "inches", value: 24, mm: 609.6, corrected: 23.5, correctedMm: 596.9, itemUnit: "crates" },
] as const;
type DimensionBusiness = typeof businessDimensions[number];
function businessState(spec: DimensionBusiness): ConversationCommerceState {
  const state = initialState();
  state.entities[2] = entity("display", spec.name, 1, spec.business);
  state.entities[2].attributes.unit = spec.itemUnit;
  return state;
}
function businessTurn(spec: DimensionBusiness, text = `${spec.name} ${spec.axis} limit is ${spec.value}${spec.unit}.`,
  value: number = spec.mm, source = "dimension-business"): CommerceRuntimeInput {
  const input = turn(text, value, `max_${spec.axis}_mm`, "display", source);
  const frame = input.semantic_frame;
  assert(frame, "Business dimension needs a real normalized Reading object");
  frame.topic = spec.business; frame.entities[0].name = spec.name; frame.entities[0].category_hint = spec.business;
  return input;
}
function noTransaction(state: ConversationCommerceState): void {
  assert(state.quotes.length === 0 && state.conversion.confirmed_entity_ids.length === 0,
    "Customer dimension/quantity became a merchant quote or confirmed transaction");
}

for (const spec of businessDimensions) {
  Deno.test(`P1 dimension ${spec.business}: researching allocated subject retains quantity and scope provenance`, async () => {
    const state = businessState(spec), target = state.entities[2];
    target.status = "researching"; target.quantity = 3;
    target.attributes.scoped_customer_updates = ["first", "second", "third"].map(scope => ({ scope,
      attribute: "quantity", action: "set", value: 1, source_text: `${scope} 1 ${spec.itemUnit}`,
      source_message_id: "prior-allocation", source_revision: 20 }));
    const rows = JSON.stringify(target.attributes.scoped_customer_updates), s = storage(state);
    const input = businessTurn(spec); assert(input.semantic_frame, "Normalized dimension Reading missing");
    input.semantic_frame = applyCustomerRequestDecision(input.semantic_frame,
      resolveCustomerRequestDecision(input.text, input.semantic_frame));
    const result = await runCommerceStateRuntime(s.db, input);
    assert(result?.persist_result === "success" && s.live.state.entities[2].constraints[`max_${spec.axis}_mm`] === spec.mm &&
      s.live.state.entities[2].quantity === 3 && s.live.state.entities[2].status === "researching" &&
      JSON.stringify(s.live.state.entities[2].attributes.scoped_customer_updates) === rows,
      "Dimension edit rewrote a researching allocation: " + JSON.stringify(result));
  });
  Deno.test(`P1 dimension ${spec.business}: explicit unit conversion, named correction, comparison and replay`, async () => {
    const s = storage(businessState(spec)), sibling = JSON.stringify(s.live.state.entities.slice(0, 2));
    const key = `max_${spec.axis}_mm`, initial = businessTurn(spec);
    const first = await runCommerceStateRuntime(s.db, initial);
    assert(first?.persist_result === "success" && s.live.writes === 1 && s.live.state.entities[2].constraints[key] === spec.mm,
      "Current explicit dimension did not reach the named canonical item: " + JSON.stringify(first));
    assert(s.live.state.entities[2].provenance.source_message_id === initial.source_message_id &&
      s.live.state.entities[2].quantity === 1 && s.live.state.entities.length === 3, "Dimension invented a quantity or shadow item");
    const correction = businessTurn(spec, `Correction: ${spec.name} ${spec.axis} limit is ${spec.corrected}${spec.unit}, not ${spec.value}${spec.unit}.`, spec.correctedMm, "dimension-business-correction");
    assert(correction.semantic_frame, "Correction Reading missing");
    correction.semantic_frame.customer_correction = true;
    // Actual handler projections may expose only the exact customer label.
    correction.semantic_frame.entities[0].entity_ref = spec.name;
    correction.semantic_frame.referents[0].ref = spec.name;
    correction.semantic_frame.demands![0].subject_refs = [spec.name];
    const corrected = await runCommerceStateRuntime(s.db, correction);
    assert(corrected?.persist_result === "success" && s.live.state.entities[2].constraints[key] === spec.correctedMm,
      "Named source-bound correction failed: " + JSON.stringify(corrected));
    const comparisonText = `Would ${spec.name} ${spec.axis} ${spec.value}${spec.unit} fit?`;
    const frame = reading("ASK_FACT"); frame.topic = spec.business; frame.requested_facts = [spec.axis];
    frame.referents = [{ ref: "display", source: "persistent_state", confidence: 0.99 }];
    frame.demands = [{ question: comparisonText, source_quote: comparisonText, subject_refs: ["display"], source_type: "general",
      requested_facts: [spec.axis], constraints: {}, customer_correction: false, explicit_negations: [],
      ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
    const before = JSON.stringify(s.live.state), writes = s.live.writes, revision = s.live.revision;
    const compared = await runCommerceStateRuntime(s.db, { ...owner, source_message_id: "dimension-business-compare",
      text: comparisonText, language: "en", semantic_frame: frame });
    assert(compared?.persist_result === "read_only" && compared.state_path === `entities.2.constraints.${key}` &&
      compared.reply?.includes(String(spec.correctedMm)), "Read-only comparison lost the current stored dimension: " + JSON.stringify(compared));
    await runCommerceStateRuntime(s.db, correction);
    assert(s.live.writes === writes && s.live.revision === revision && JSON.stringify(s.live.state) === before &&
      JSON.stringify(s.live.state.entities.slice(0, 2)) === sibling, "Read-only comparison/replay rewrote a revision or sibling");
    noTransaction(s.live.state);
  });

  for (const mode of ["missing-reading", "ambiguous-reading", "weak-reading", "wrong-reference", "wrong-name",
    "wrong-value", "wrong-axis", "missing-unit", "forged-unit", "history-only", "forged-quote", "other-subject-value",
    "negated-old-value", "wrong-negated-old-value", "partial-valid-proposal", "inactive-target", "unowned-target",
    "blank-provenance", "transaction", "question"] as const) {
    Deno.test(`P1 dimension ${spec.business} negative: ${mode}`, async () => {
      const s = storage(businessState(spec)), key = `max_${spec.axis}_mm`;
      let text = `${spec.name} ${spec.axis} limit is ${spec.value}${spec.unit}.`;
      if (mode === "missing-unit") text = `${spec.name} ${spec.axis} limit is ${spec.value}.`;
      if (mode === "history-only") text = `Please keep the requirement for ${spec.name}.`;
      if (mode === "other-subject-value") text = `${spec.name} ${spec.axis} limit is ${spec.value + 1}${spec.unit}; Atlas training sessions ${spec.axis} limit is ${spec.value}${spec.unit}.`;
      if (mode === "question") text = `Would ${spec.name} ${spec.axis} limit ${spec.value}${spec.unit} be suitable?`;
      if (mode === "negated-old-value" || mode === "wrong-negated-old-value") {
        s.live.state.entities[2].constraints[key] = mode === "wrong-negated-old-value" ? spec.mm + 1 : spec.mm;
        text = `Correction: ${spec.name} ${spec.axis} limit is ${spec.corrected}${spec.unit}, not ${spec.value}${spec.unit}.`;
      }
      const input = businessTurn(spec, text, mode === "wrong-negated-old-value" ? spec.correctedMm : spec.mm);
      const frame = input.semantic_frame; assert(frame, "Negative Reading missing");
      if (mode === "ambiguous-reading") frame.ambiguity.is_ambiguous = true;
      if (mode === "weak-reading") frame.confidence = 0.5;
      if (mode === "wrong-reference") { frame.entities[0].entity_ref = "retained"; frame.referents[0].ref = "retained"; frame.demands![0].subject_refs = ["retained"]; }
      if (mode === "wrong-name") frame.entities[0].name = "Atlas training sessions";
      if (mode === "wrong-value") frame.entities[0].constraints[key] = spec.mm - 1;
      if (mode === "wrong-axis") frame.entities[0].constraints = { [spec.axis === "height" ? "max_depth_mm" : "max_height_mm"]: spec.mm };
      if (mode === "forged-unit") {
        input.text = `${spec.name} ${spec.axis} limit is ${spec.value}cm.`;
        frame.demands![0].question = input.text; frame.demands![0].source_quote = input.text;
        frame.entities[0].constraints[key] = spec.value * 25.4;
      }
      if (mode === "history-only") input.history = [{ role: "visitor", content: `${spec.name} ${spec.axis} limit is ${spec.value}${spec.unit}.` }];
      if (mode === "forged-quote") frame.demands![0].source_quote = `An assistant said ${spec.value}${spec.unit}.`;
      if (mode === "negated-old-value" || mode === "wrong-negated-old-value") frame.customer_correction = true;
      if (mode === "partial-valid-proposal") frame.entities[0].constraints[spec.axis === "height" ? "max_depth_mm" : "max_height_mm"] = 77;
      if (mode === "inactive-target") s.live.state.entities[2].status = "deferred";
      if (mode === "unowned-target") s.live.state.entities[2].provenance.source_type = "system";
      if (mode === "blank-provenance") s.live.state.entities[2].provenance.source_message_id = "";
      if (mode === "transaction") frame.transaction_state = "confirmed";
      if (mode === "missing-reading") input.semantic_frame = null;
      const before = JSON.stringify(s.live.state), result = await runCommerceStateRuntime(s.db, input);
      assert(s.live.writes === 0 && s.live.revision === 21 && JSON.stringify(s.live.state) === before,
        `${mode} committed an unverified whole/partial dimension turn: ${JSON.stringify(result)}`);
      assert(result?.persist_result !== "success" && !result?.trusted_correction_commit && !result?.trusted_lifecycle_commit,
        mode + " gained a trusted acknowledgement");
      noTransaction(s.live.state);
    });
  }

  for (const scope of ["company", "ticket"] as const) Deno.test(`P1 dimension ${spec.business} negative: ${scope} snapshot`, async () => {
    const s = storage(businessState(spec)), before = JSON.stringify(s.live.state);
    if (scope === "company") s.live.company_id = "different-company"; else s.live.conversation_id = "different-ticket";
    let rejected = false;
    try { await runCommerceStateRuntime(s.db, businessTurn(spec)); } catch (error) {
      rejected = error instanceof Error && error.message === "commerce_state_scope_mismatch";
    }
    assert(rejected && s.live.writes === 0 && s.live.revision === 21 && JSON.stringify(s.live.state) === before,
      "Foreign canonical snapshot supplied a dimension write");
  });

  Deno.test(`P1 dimension ${spec.business}: CAS conflict rechecks the actual old constraint`, async () => {
    const s = storage(businessState(spec)), key = `max_${spec.axis}_mm`;
    s.live.state.entities[2].constraints[key] = spec.mm;
    const input = businessTurn(spec, `Correction: ${spec.name} ${spec.axis} limit is ${spec.corrected}${spec.unit}, not ${spec.value}${spec.unit}.`, spec.correctedMm);
    assert(input.semantic_frame, "Correction Reading missing"); input.semantic_frame.customer_correction = true;
    let fresh = "";
    s.db.rpc = async () => {
      s.live.writes++; assert(s.live.writes === 1, "Invalid stale correction retried a write");
      s.live.state.entities[2].constraints[key] = spec.mm + 1;
      s.live.state.entities[2].provenance.source_message_id = "independent-current-customer-source";
      s.live.revision++; fresh = JSON.stringify(s.live.state);
      return { data: { result: "revision_conflict" }, error: null };
    };
    const result = await runCommerceStateRuntime(s.db, input);
    assert(s.live.writes === 1 && s.live.revision === 22 && JSON.stringify(s.live.state) === fresh &&
      result?.persist_result === "read_only" && result.contextual_decision?.reason === "UNVERIFIED_CUSTOMER_REQUIREMENT" &&
      !result.trusted_correction_commit,
      "CAS retry reused an obsolete dimension proof: " + JSON.stringify(result));
  });
}

Deno.test("P1 dimension direct writer: copied hint constraint cannot bypass the complete source boundary", async () => {
  const s = storage(), before = JSON.stringify(s.live.state);
  const input = turn("Portable exhibition frame width limit is 600mm.");
  assert(input.semantic_frame, "Reading missing"); input.semantic_frame.entities = [];
  const result = await persistCommerceTurn(s.db, input, [{ entity_id: "display", category: "display-rental", aliases: ["Portable exhibition frame"],
    attributes: { product_name: "Portable exhibition frame" }, constraints: { max_height_mm: 600 } }]);
  assert(s.live.writes === 0 && s.live.revision === 21 && JSON.stringify(s.live.state) === before && result.result !== "success",
    "Direct writer accepted a wrong-axis hint beside a valid width clause");
});

for (const punctuation of [". ", "; ", "。 ", "\n"] as const) Deno.test(`P1 literal item quantity: sentence boundary ${JSON.stringify(punctuation)} retains the exact unit`, async () => {
  const s = storage(), name = "Event equipment rental", text = `Add ${name}: 1 kits${punctuation}This is a requirement, not an order.`;
  const input = turn(text); assert(input.semantic_frame, "Reading missing");
  const frame = input.semantic_frame; frame.operation = "ADD_ITEM"; frame.intent = "customer_requirements";
  frame.topic = name; frame.referents = []; frame.demands![0].subject_refs = [name];
  frame.entities[0] = { ...frame.entities[0], entity_ref: "current:1", name, kind: "service", category_hint: null, quantity: 1, unit: "kits", constraints: {} };
  await runCommerceStateRuntime(s.db, input);
  const added = s.live.state.entities.filter(entity => entity.attributes.product_name === name);
  assert(added.length === 1 && added[0].quantity === 1 && added[0].attributes.quantity_basis === "customer_explicit" &&
    added[0].attributes.unit === "kits" && added[0].provenance.source_message_id === input.source_message_id,
    "Literal count/unit was lost at an ordinary sentence boundary: " + JSON.stringify(added));
  noTransaction(s.live.state);
});

for (const mode of ["missing-numeral", "forged-numeral", "embedded-unit", "decimal-quantity"] as const)
  Deno.test(`P1 literal item quantity negative: ${mode} cannot establish a counted requirement`, async () => {
    const name = "Event equipment rental", s = storage();
    const text = mode === "missing-numeral" ? `Add ${name}: kits. This is a requirement.` :
      mode === "embedded-unit" ? `Add ${name}: 1 kitsExtra. This is a requirement.` :
      mode === "decimal-quantity" ? `Add ${name}: 1.5 kits. This is a requirement.` : `Add ${name}: 2 kits. This is a requirement.`;
    const input = turn(text); assert(input.semantic_frame, "Reading missing");
    const frame = input.semantic_frame; frame.operation = "ADD_ITEM"; frame.intent = "customer_requirements";
    frame.topic = name; frame.referents = []; frame.demands![0].subject_refs = [name];
    frame.entities[0] = { ...frame.entities[0], entity_ref: "current:1", name, kind: "service", category_hint: null, quantity: 1, unit: "kits", constraints: {} };
    await runCommerceStateRuntime(s.db, input);
    const added = s.live.state.entities.filter(entity => entity.attributes.product_name === name);
    assert(added.every(entity => entity.quantity === 0 && entity.attributes.quantity_basis === "system_default"),
      "A missing or mismatched literal count/unit became authoritative: " + JSON.stringify(added));
    noTransaction(s.live.state);
  });

Deno.test("P1 dimension later readback: actual ticket identity cannot be replaced by the request ticket", () => {
  const s = storage(), text = "Would Portable exhibition frame width 598mm fit?";
  s.live.state.entities[2].constraints.max_width_mm = 595;
  const frame = reading("ASK_FACT"); frame.topic = "Portable exhibition frame"; frame.requested_facts = ["width"];
  frame.referents = [{ ref: "display", source: "persistent_state", confidence: 0.99 }];
  frame.demands = [{ question: text, source_quote: text, subject_refs: ["display"], source_type: "unknown",
    requested_facts: ["width"], constraints: {}, customer_correction: false, explicit_negations: [],
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  const input: CommerceRuntimeInput = { ...owner, text, language: "en", semantic_frame: frame, source_message_id: "current-read-source" };
  const snapshot = { ...owner, source_message_id: s.live.source_message_id, revision: s.live.revision, state: s.live.state };
  assert(sourceBoundDimensionComparison(input, snapshot)?.reply, "Original same-owner comparison not proven");
  assert(sourceBoundDimensionComparison(input, { ...snapshot, conversation_id: "another-ticket" }) === null,
    "A later wrong-ticket row reused the original authorized reply/revision");
  assert(s.live.writes === 0 && s.live.revision === 21, "Pure readback validation invoked a writer");
});

Deno.test("P1 dimension read probe: absent tenant-filter capability fails closed", async () => {
  const s = storage(), input = turn("Would Portable exhibition frame width 598mm fit?");
  assert(input.semantic_frame, "Missing Reading fixture");
  input.semantic_frame.operation = "ASK_FACT";
  input.semantic_frame.entities = []; input.semantic_frame.topic = "Portable exhibition frame";
  input.semantic_frame.requested_facts = ["width"];
  assert(input.semantic_frame.demands?.[0], "Missing demand fixture");
  input.semantic_frame.demands[0].requested_facts = ["width"];
  s.live.state.entities[2].constraints.max_width_mm = 595;
  const before = JSON.stringify(s.live.state);
  let failed = false;
  try { await readSourceBoundDimensionComparison(s.db, input); } catch (error) {
    failed = error instanceof Error && error.message === "commerce_state_scope_filter_unavailable";
  }
  assert(failed && s.live.writes === 0 && s.live.revision === 21 && JSON.stringify(s.live.state) === before,
    "Missing company filter silently downgraded to an unscoped read");
});

function dimensionAdvice(spec: DimensionBusiness): CommerceRuntimeInput {
  const text = `I want to choose ${spec.name} for a space with width ${spec.value}${spec.unit} and depth 560mm. I prefer stability. Please explain the trade-offs and what to measure next.`;
  const frame = reading("ASK_FACT");
  frame.intent = "customer_guidance"; frame.topic = null;
  frame.customer_facts = [{ key: "preference", value: "stability" }];
  frame.entities = [{ entity_ref: "semantic:1", name: spec.name, kind: "physical_product", category_hint: null,
    model: null, sku: null, quantity: null, unit: null, attributes: {}, capabilities, confidence: 0.99,
    constraints: { width: { amount: spec.value, unit: spec.unit }, depth: { amount: 560, unit: "mm" } } }];
  return { ...owner, text, language: "en", semantic_frame: frame, source_message_id: "dimension-advice-source" };
}

for (const spec of businessDimensions) {
  Deno.test(`P1 dimension advice ${spec.business}: typed multi-axis context preserves source without phantom items`, async () => {
    const s = storage(createEmptyConversationCommerceState()), input = dimensionAdvice(spec);
    assert(input.semantic_frame, "Typed dimension guidance requires its accepted Reading");
    const source = JSON.stringify(input), result = await runCommerceStateRuntime(s.db, input);
    assert(result?.route === "product_guidance" && result.contextual_decision?.route === "product_guidance" &&
      result.contextual_decision.requires_generated_guidance === true &&
      result.reply === null && result.persist_result === "success", "Valid source-owned advice was rejected: " + JSON.stringify(result));
    assert(s.live.writes === 1 && s.live.revision === 22 && s.live.state.entities.length === 0 &&
      s.live.state.conversion.tentative_entity_ids.length === 0 && s.live.state.current_topic === spec.name,
      "Advice materialized a hinted/default entity, count or canonical dimension");
    noTransaction(s.live.state);
    const rows = [{ id: input.source_message_id, role: "visitor", content: input.text, created_at: "2026-11-25T12:00:00.000Z" }];
    const memory = buildCanonicalConversationMemory({ ...owner, source_message_id: input.source_message_id,
      commerce_state_revision: s.live.revision, commerce_state: s.live.state, newest_first: rows,
      visitor_turn_count: 1, source_created_at: rows[0].created_at, next_memory_revision: 1,
      request_decision: resolveCustomerRequestDecision(input.text, input.semantic_frame) });
    assert(memory.current_goal === input.text && memory.current_goal_source_message_id === input.source_message_id &&
      memory.active_entities.length === 0 && !memory.current_customer_facts.some(fact => fact.key.startsWith("entity:")) &&
      buildBoundedConversationContext(memory, rows).block.includes(input.text),
      "The source-owned advice context was lost or promoted to an entity/quantity: " + JSON.stringify(memory));
    assert(JSON.stringify(input) === source, "Advice rewrote the actual customer source or Reading");
    const before = JSON.stringify(s.live.state); await runCommerceStateRuntime(s.db, input);
    assert(s.live.writes === 1 && s.live.revision === 22 && JSON.stringify(s.live.state) === before,
      "Same-source advice replay created a duplicate write or entity");
  });
  for (const mode of ["wrong-value", "malformed-measurement", "wrong-context", "missing-current-number", "wrong-unit", "wrong-persisted-reference"] as const) {
    Deno.test(`P1 dimension advice ${spec.business} negative: ${mode} rejects the complete context turn`, async () => {
      const s = storage(mode === "wrong-persisted-reference" ? initialState() : createEmptyConversationCommerceState());
      const input = dimensionAdvice(spec), frame = input.semantic_frame; assert(frame, "Typed guidance fixture missing");
      if (mode === "wrong-value") frame.entities[0].constraints.depth = { amount: 559, unit: "mm" };
      if (mode === "malformed-measurement") frame.entities[0].constraints.width = { amount: spec.value, unit: spec.unit, unverified: true };
      if (mode === "wrong-context") frame.entities[0].name = "Unmentioned project";
      if (mode === "missing-current-number") input.text = input.text.replace(`width ${spec.value}${spec.unit}`, "limited width");
      if (mode === "wrong-unit") frame.entities[0].constraints.depth = { amount: 560, unit: "cm" };
      if (mode === "wrong-persisted-reference") {
        frame.entities[0].entity_ref = "retained";
        frame.referents = [{ ref: "retained", source: "persistent_state", confidence: 0.99 }];
      }
      const before = JSON.stringify(s.live.state), result = await persistCommerceTurn(s.db, input, []);
      assert(result.result === "unverified_customer_requirement" && s.live.writes === 0 && s.live.revision === 21 &&
        JSON.stringify(s.live.state) === before,
        "Invalid advice silently accepted a partial context/fact/entity write: " + JSON.stringify(result));
    });
  }
}

for (const path of ["canonical-writer", "guidance-context"] as const) {
  Deno.test(`P1 dimension literal unit negative: incomplete inch suffix cannot authorize ${path}`, async () => {
    const spec = businessDimensions[2], s = storage(path === "canonical-writer" ? businessState(spec) : createEmptyConversationCommerceState());
    const input = path === "canonical-writer"
      ? businessTurn(spec, `${spec.name} depth limit is 10inche.`, 254)
      : dimensionAdvice(spec);
    if (path === "guidance-context") {
      input.text = input.text.replace(`width ${spec.value}${spec.unit}`, "width 10inche");
      assert(input.semantic_frame, "Guidance Reading missing");
      input.semantic_frame.entities[0].constraints.width = { amount: 10, unit: "inch" };
    }
    const before = JSON.stringify(s.live.state), result = await persistCommerceTurn(s.db, input, []);
    assert(result.result === "unverified_customer_requirement" && s.live.writes === 0 && s.live.revision === 21 &&
      JSON.stringify(s.live.state) === before, "An incomplete inch unit acquired write authority: " + JSON.stringify(result));
  });
}


// Accepted Reading remains mandatory. Comparative words corroborate only a
// current literal upper bound on the exact owned subject and matching axis.
const comparativeDimensionCases = [
  { name: "Cantonese maximum", text: "Portable exhibition frame 最闊只可以 600mm。", axis: "width", mm: 600, language: "zh-TW" },
  { name: "English width", text: "Portable exhibition frame must be no wider than 60 cm.", axis: "width", mm: 600, language: "en" },
  { name: "Traditional Chinese height", text: "Conference welcome banner 最高只可 120 cm。", axis: "height", mm: 1200, language: "zh-TW" },
  { name: "Simplified Chinese width", text: "Portable exhibition frame 最宽只能 60厘米。", axis: "width", mm: 600, language: "zh-CN" },
  { name: "English height", text: "Conference welcome banner must be no taller than 120 cm.", axis: "height", mm: 1200, language: "en" },
  { name: "English depth", text: "Reusable shipping crate must be not deeper than 24 inches.", axis: "depth", mm: 609.6, language: "en" },
] as const;
for (const row of comparativeDimensionCases) {
  Deno.test("P1 comparative dimension source positive: " + row.name, async () => {
    const spec = businessDimensions.find(value => value.axis === row.axis)!;
    const s = storage(businessState(spec));
    const input = businessTurn(spec, row.text, row.mm);
    input.language = row.language;
    assert(input.semantic_frame, "Comparative dimension Reading missing");
    input.semantic_frame.language = row.language;
    const siblings = JSON.stringify(s.live.state.entities.slice(0, 2));
    const result = await runCommerceStateRuntime(s.db, input);
    assert(result?.persist_result === "success" && s.live.writes === 1 && s.live.revision === 22 &&
      s.live.state.entities[2].constraints["max_" + row.axis + "_mm"] === row.mm &&
      s.live.state.entities[2].provenance.source_message_id === input.source_message_id &&
      JSON.stringify(s.live.state.entities.slice(0, 2)) === siblings &&
      s.live.state.entities[2].quantity === 1 && s.live.state.entities.length === 3,
      "Valid comparative bound was refused or changed another subject: " + JSON.stringify(result));
    noTransaction(s.live.state);
    const before = JSON.stringify(s.live.state);
    await runCommerceStateRuntime(s.db, input);
    assert(s.live.writes === 1 && s.live.revision === 22 && JSON.stringify(s.live.state) === before,
      "Comparative same-source replay wrote again");
  });
}
const comparativeDimensionNegatives = [
  { name: "wrong amount", text: "Portable exhibition frame must be no wider than 60 cm.", axis: "width", mm: 590 },
  { name: "wrong axis", text: "Portable exhibition frame must be no wider than 60 cm.", axis: "height", mm: 600 },
  { name: "lower bound", text: "Portable exhibition frame must be wider than 60 cm.", axis: "width", mm: 600 },
  { name: "not required", text: "Portable exhibition frame is not required to be no wider than 60 cm.", axis: "width", mm: 600 },
  { name: "removed requirement", text: "Portable exhibition frame must be no wider than 60 cm is no longer required.", axis: "width", mm: 600 },
  { name: "historical", text: "Previously Portable exhibition frame had to be no wider than 60 cm.", axis: "width", mm: 600 },
  { name: "Cantonese negation", text: "Portable exhibition frame 唔需要最闊只可以 600mm。", axis: "width", mm: 600 },
  { name: "other subject", text: "Atlas training sessions must be no wider than 60 cm.", axis: "width", mm: 600 },
  { name: "other axis bound", text: "Portable exhibition frame must be no wider than 60 cm and height 120 cm.", axis: "height", mm: 1200 },
  { name: "conditional", text: "If Portable exhibition frame must be no wider than 60 cm.", axis: "width", mm: 600 },
  { name: "question", text: "Should Portable exhibition frame be no wider than 60 cm?", axis: "width", mm: 600 },
] as const;
for (const row of comparativeDimensionNegatives) {
  Deno.test("P1 comparative dimension source negative: " + row.name, async () => {
    const s = storage(), input = turn(row.text, row.mm, "max_" + row.axis + "_mm");
    const before = JSON.stringify(s.live.state);
    const result = await persistCommerceTurn(s.db, input, []);
    assert(result.result !== "success" && s.live.writes === 0 && s.live.revision === 21 &&
      JSON.stringify(s.live.state) === before, "Unverified comparative proposal gained write authority: " + JSON.stringify(result));
    noTransaction(s.live.state);
  });
}
