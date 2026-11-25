/**
 * Targeted business axes for the existing Phase1 safety obligations.
 * Existing education fixtures and exhaustive shared failure variants remain in
 * the original five twin files. These registrations vary actual quantities,
 * units, scopes, parent/add-on relationships and language instead of multiplying
 * every fault by every business. Readings are explicit fixtures, not model proof.
 * Literal no-Reading lifecycle compatibility remains LEGACY_WORD_GATE evidence
 * in the unchanged safety file; it is not a desired-behaviour requirement here.
 */
import { createEmptyConversationCommerceState, type CommerceEntity, type ConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import type { CommerceRuntimeInput } from "../../supabase/functions/_shared/commerce-state-runtime-base.ts";
import { normalizeCommerceSemanticFrame, type CommerceSemanticCapabilities, type CommerceSemanticKind } from "../../supabase/functions/_shared/commerce-semantic-frame.ts";
import type { SourceBoundContextualGoal, ScopedCustomerValue } from "../../supabase/functions/_shared/contextual-customer-update.ts";
import { buildCanonicalConversationMemory, refreshConversationLongMemory, verifyCommittedLifecycleMemory, verifyCommittedScopedCorrectionMemory } from "../../supabase/functions/_shared/conversation-long-memory.ts";
import { prepareConversationRecall, type ConversationRecallInput } from "../../supabase/functions/_shared/conversation-recall.ts";
import { evaluateB2BeforeCommit } from "../../supabase/functions/_shared/pre-send-conversion-supervisor.ts";
import { sameCanonicalJson } from "../../supabase/functions/_shared/canonical-json.ts";
import { assert, unchanged, noTransaction, reading, storage, evaluation, gate, memory, memoryArgs, memoryStorage,
  type BusinessStorage } from "./fixtures/phase1-business-context.ts";

interface PairSpec {
  business: string;
  language: "en" | "zh-TW";
  base: { name: string; quantity: number; unit: string; requirements: Record<string, unknown> };
  addon: { name: string; quantity: number; unit: string; requirements: Record<string, unknown> };
}
const lifecycleCases: PairSpec[] = [
  { business: "retail", language: "en",
    base: { name: "Ergonomic chair", quantity: 2, unit: "chairs", requirements: { upholstery: "blue fabric" } },
    addon: { name: "Footrest", quantity: 1, unit: "footrests", requirements: { material: "wood" } } },
  { business: "beauty", language: "zh-TW",
    base: { name: "護理諮詢", quantity: 1, unit: "次", requirements: { preferred_window: "星期四傍晚", booking_confirmed: false } },
    addon: { name: "修甲加項", quantity: 2, unit: "節", requirements: { finish: "透明", booking_confirmed: false } } },
  { business: "saas", language: "en",
    base: { name: "Workspace subscription", quantity: 12, unit: "licences", requirements: { requested_period: "monthly" } },
    addon: { name: "Analytics add-on", quantity: 3, unit: "seats", requirements: { requested_retention: "30 days" } } },
];
function pair(spec: PairSpec): ConversationCommerceState {
  const state = createEmptyConversationCommerceState(); state.language = spec.language;
  state.current_topic = `${spec.business}-base`;
  state.entities = [spec.base, spec.addon].map((item, index): CommerceEntity => ({
    entity_id: `${spec.business}:${index ? "addon" : "base"}`, category: `${spec.business}-${index ? "addon" : "base"}`,
    model: `${spec.business.toUpperCase()}-${index ? "ADD" : "BASE"}`, quantity: item.quantity,
    status: index ? "tentative" : "researching", attributes: { product_name: item.name, unit: item.unit,
      quantity_basis: "customer_explicit", ...(index ? { parent_entity_id: `${spec.business}:base` } : {}) },
    constraints: structuredClone(item.requirements), provenance: { source_type: "customer", source_message_id: `${spec.business}-prior-${index}` },
  }));
  state.conversion.tentative_entity_ids = [state.entities[1].entity_id];
  return state;
}
function lifecycleInput(h: BusinessStorage, spec: PairSpec, cancel = false) {
  const text = spec.language === "zh-TW"
    ? `${cancel ? "取消" : "暫緩"} ${spec.addon.name}；先處理 ${spec.base.name}。`
    : `${cancel ? "Cancel" : "Pause"} ${spec.addon.name}; focus on ${spec.base.name}.`;
  const frame = reading(cancel ? "CANCEL_ITEM" : "DEFER", `${spec.business}-addon`, spec.language);
  frame.intent = "lifecycle";
  frame.referents = [{ ref: `${spec.business}:addon`, source: "persistent_state", confidence: .99 }];
  return h.turn(text, frame, `${spec.business}-${cancel ? "cancel" : "defer"}`, spec.language);
}
async function committedLifecycle(spec: PairSpec, cancel = false) {
  const initial = pair(spec), h = storage(spec.business, initial, 8), input = lifecycleInput(h, spec, cancel);
  const out = await h.ask(input);
  assert(out?.trusted_lifecycle_commit && out.reply && out.persist_result === "success" && h.live.writes === 1 &&
    h.live.revision === 9, "business lifecycle did not actually commit: " + JSON.stringify(out));
  const receipt = out.trusted_lifecycle_commit, m = memory(h, input);
  assert(verifyCommittedLifecycleMemory({ memory: m, receipt, commerce: { ...h.owner,
    source_message_id: h.live.source, revision: h.live.revision, state: h.live.state } }), "business lifecycle lost Memory parity");
  return { initial, h, input, out, receipt, m, e: evaluation(h, input, out) };
}

for (const spec of lifecycleCases) {
  for (const cancel of [false, true]) Deno.test(`P1 business lifecycle ${spec.business}: compound ${cancel ? "cancel" : "defer"} preserves the named parent`, async () => {
    const f = await committedLifecycle(spec, cancel), target = f.h.live.state.entities[1];
    unchanged(f.h.live.state.entities[0], f.initial.entities[0], "compound operation changed parent quantity/requirements/provenance");
    unchanged(target.attributes, f.initial.entities[1].attributes, "lifecycle changed add-on quantity or parent binding");
    unchanged(target.constraints, f.initial.entities[1].constraints, "lifecycle changed add-on requirements");
    assert(target.status === (cancel ? "cancelled" : "deferred") && target.quantity === spec.addon.quantity &&
      target.provenance.source_message_id === f.input.source_message_id &&
      f.receipt.target_entity_ids.length === 1 && f.receipt.target_entity_ids[0] === target.entity_id,
      "compound lifecycle selected the wrong subject or status");
    assert(f.m.active_entities.length === 1 && f.m.active_entities[0].quantity === spec.base.quantity &&
      f.m.cancelled_or_superseded.some(row => row.key === `entity:${target.entity_id}` && row.value === target.status),
      "Memory did not partition actual parent and inactive add-on");
    assert(evaluateB2BeforeCommit(f.e).code === "B2_ALLOW_COMMITTED_SCOPED_LIFECYCLE", "valid lifecycle receipt rejected");
    const sent = await gate(f.h, f.input, f.e);
    assert(sent.result.committed && sent.commits === 1 && sent.stateReads === 2, "final B2 boundary did not authorize one bounded reply");
    noTransaction(f.h.live.state);
  });
  for (const mode of ["missing-reading", "wrong-subject", "wrong-operation", "transaction"] as const)
    Deno.test(`P1 business lifecycle ${spec.business} negative: ${mode}`, async () => {
      const h = storage(spec.business, pair(spec), 8), input = lifecycleInput(h, spec);
      if (mode === "missing-reading") { input.text = spec.language === "en" ? "Pause it." : "暫緩嗰項。"; input.semantic_frame = null; }
      if (mode === "wrong-subject") input.semantic_frame!.referents[0].ref = `${spec.business}:base`;
      if (mode === "wrong-operation") input.semantic_frame!.operation = "ASK_FACT";
      if (mode === "transaction") input.semantic_frame!.transaction_state = "confirmed";
      const before = structuredClone(h.live.state), out = await h.ask(input);
      assert(h.live.writes === 0 && h.live.revision === 8 && !out?.trusted_lifecycle_commit,
        mode + " acquired lifecycle mutation authority: " + JSON.stringify(out));
      unchanged(h.live.state, before, "invalid Reading changed Commerce");
    });
  Deno.test(`P1 business lifecycle ${spec.business}: same-source replay keeps the parent and revision unchanged`, async () => {
    const f = await committedLifecycle(spec), before = structuredClone(f.h.live.state);
    await f.h.ask(f.input);
    assert(f.h.live.writes === 1 && f.h.live.revision === 9, "replay committed lifecycle twice");
    unchanged(f.h.live.state, before, "replay changed parent/add-on state");
  });
  Deno.test(`P1 business lifecycle ${spec.business} B2 negative: customer requirement cannot confirm a transaction`, async () => {
    const f = await committedLifecycle(spec);
    f.e.proposed_response += spec.language === "en" ? " Your order is confirmed." : " 訂單已確認。";
    assert(evaluateB2BeforeCommit(f.e).decision !== "allow", "lifecycle receipt authorized a phantom transaction");
    const result = await gate(f.h, f.input, f.e);
    assert(!result.result.committed && result.commits === 0, "phantom transaction reached final callback");
  });
  const drift = spec.business === "retail" ? "source-drift" : spec.business === "beauty" ? "tenant-drift" : "revision-drift";
  Deno.test(`P1 business lifecycle ${spec.business} B2 negative: ${drift} after evaluation`, async () => {
    const f = await committedLifecycle(spec), result = await gate(f.h, f.input, f.e, drift);
    assert(!result.result.committed && result.commits === 0 && result.stateReads === 2,
      "final source/tenant/revision drift reached the reply callback");
  });
}

interface CorrectionSpec {
  business: string; subject: string; unit: string; kind: CommerceSemanticKind;
  scopes: Array<{ name: string; count: number; value: number; grouped: boolean }>;
  changedScope: number; next: number; sibling: string; siblingUnit: string;
  capabilities: Partial<CommerceSemanticCapabilities>;
}
const corrections: CorrectionSpec[] = [
  { business: "restaurant", subject: "Lunch catering", unit: "portions", kind: "service",
    scopes: [{ name: "vegetarian guests", count: 3, value: 1, grouped: true }, { name: "standard guests", count: 5, value: 2, grouped: true }],
    changedScope: 0, next: 2, sibling: "Drink station", siblingUnit: "stations", capabilities: { requires_delivery: true } },
  { business: "saas", subject: "Workspace subscriptions", unit: "licences", kind: "subscription",
    scopes: [{ name: "engineering department", count: 1, value: 8, grouped: false }, { name: "finance department", count: 1, value: 2, grouped: false }],
    changedScope: 1, next: 4, sibling: "Analytics add-on", siblingUnit: "seats", capabilities: { recurring_billing: true, digital_fulfilment: true } },
  { business: "b2b", subject: "Packing supplies", unit: "boxes", kind: "b2b_product",
    scopes: [{ name: "loading bays", count: 2, value: 4, grouped: true }, { name: "repair bench", count: 1, value: 3, grouped: false }],
    changedScope: 0, next: 5, sibling: "Inspection tools", siblingUnit: "kits", capabilities: { requires_quote: true, customization: true } },
];
const baseCapabilities: CommerceSemanticCapabilities = { requires_delivery: false, supports_pickup: false,
  requires_installation: false, requires_booking: false, requires_quote: false, requires_site_check: false,
  digital_fulfilment: false, recurring_billing: false, rental_return: false, customization: false };
function correctionInput(h: BusinessStorage, spec: CorrectionSpec, ref: string, correction = false, oldOverride?: number) {
  const selected = spec.scopes[spec.changedScope], old = oldOverride ?? selected.value;
  const quote = `${selected.name} from ${old} ${spec.unit}${selected.grouped ? " each" : ""} to ${spec.next} ${spec.unit}${selected.grouped ? " each" : ""}`;
  const rows = correction ? [{ scope: selected.name, attribute: "quantity", action: "set", previous_value: old,
    value: spec.next, unit: spec.unit, source_text: quote }] : spec.scopes.map(scope => ({ scope: scope.name,
    attribute: "quantity", action: "set", value: scope.value, unit: spec.unit,
    source_text: `${scope.name} ${scope.value} ${spec.unit}${scope.grouped ? " each" : ""}`,
    ...(scope.grouped ? { per_scope_quantity: scope.value, scope_count: null } : {}) }));
  const frame = reading("UPDATE_ITEM", spec.subject); frame.intent = correction ? "customer_correction" : "scoped allocation";
  frame.customer_correction = correction;
  frame.entities = [{ entity_ref: ref, name: spec.subject, kind: spec.kind, category_hint: null, model: null, sku: null,
    quantity: null, unit: spec.unit, attributes: { scoped_customer_updates: rows }, constraints: {},
    capabilities: { ...baseCapabilities, ...spec.capabilities }, confidence: .99 }];
  frame.referents = [{ ref, source: "persistent_state", confidence: .99 }];
  const actual = normalizeCommerceSemanticFrame(frame); assert(actual, "invalid typed business fixture");
  return h.turn(correction ? `Correct ${spec.subject}: ${quote}` : rows.map(row => row.source_text).join("; "),
    actual, `${spec.business}-${correction ? "correction" : "allocation"}`);
}
async function correctionFixture(spec: CorrectionSpec) {
  const initial = createEmptyConversationCommerceState(); initial.language = "en";
  initial.entities = [{ entity_id: `${spec.business}:retained`, category: `${spec.business}-additional-requirement`,
    quantity: 2, status: "researching", attributes: { product_name: spec.sibling, unit: spec.siblingUnit, quantity_basis: "customer_explicit" },
    constraints: { customer_requirement: "retain separately" }, provenance: { source_type: "customer", source_message_id: `${spec.business}-sibling-source` } }];
  const h = storage(`${spec.business}-correction`, initial), sibling = structuredClone(initial.entities[0]);
  const quotes = spec.scopes.map(scope => `${scope.count} ${scope.name}`);
  const text = `${spec.subject} for ${quotes.join(" and ")}. Please offer general planning advice.`;
  const frame = reading("UPDATE_ITEM", spec.subject);
  frame.customer_facts = [{ key: "contextual_scope_counts", value: spec.scopes.map((scope, i) => ({
    scope: scope.name, count: scope.count, source_text: quotes[i], subject_label: spec.subject })) }];
  frame.demands = [{ question: text, source_quote: text, subject_refs: [spec.subject], source_type: "general",
    requested_facts: [], constraints: {}, customer_correction: false, explicit_negations: [],
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  const first = h.turn(text, frame, `${spec.business}-scope`), scopeOut = await h.ask(first);
  assert(scopeOut?.persist_result === "success" && h.live.state.entities.length === 1,
    "background business scope became a phantom item: " + JSON.stringify(scopeOut));
  const goal = h.live.state.customer_constraints.contextual_goal as SourceBoundContextualGoal;
  assert(goal?.goal_id && goal.subject_label === spec.subject, "source-owned business goal missing");
  const allocation = correctionInput(h, spec, goal.goal_id), out = await h.ask(allocation);
  assert(out?.route === "contextual_scoped_update" && out.persist_result === "success", "business allocation failed: " + JSON.stringify(out));
  const target = h.live.state.entities.find(entity => entity.attributes.contextual_goal_id === goal.goal_id)!;
  assert(target && target.quantity === spec.scopes.reduce((total, scope) => total + scope.value * (scope.grouped ? scope.count : 1), 0),
    "explicit per-scope allocation total incorrect");
  const input = correctionInput(h, spec, target.entity_id, true), previous = memory(h, allocation);
  return { spec, h, input, previous, sibling, targetId: target.entity_id,
    oldQuantity: target.quantity, oldRows: structuredClone(target.attributes.scoped_customer_updates as ScopedCustomerValue[]) };
}
async function corrected(spec: CorrectionSpec) {
  const f = await correctionFixture(spec), previousRevision = f.h.live.revision, out = await f.h.ask(f.input);
  assert(out?.route === "contextual_scoped_update" && out.persist_result === "success" &&
    out.trusted_journey_progress?.update_kind === "contextual_scoped_update" && out.trusted_journey_progress.scoped_correction,
    "business correction did not commit: " + JSON.stringify(out));
  const receipt = out.trusted_journey_progress, ledger = receipt.scoped_correction!;
  assert(ledger.previous_revision === previousRevision && ledger.committed_revision === previousRevision + 1 &&
    ledger.previous_quantity === f.oldQuantity && sameCanonicalJson(ledger.previous_updates, f.oldRows),
    "correction receipt was not built from actual current rows/revision");
  const m = buildCanonicalConversationMemory({ ...memoryArgs(f.h, f.input, receipt), previous: f.previous, next_memory_revision: 3 });
  const parity = { memory: m, receipt, commerce: { ...f.h.owner, source_message_id: f.h.live.source,
    revision: f.h.live.revision, state: f.h.live.state } };
  return { ...f, out, receipt, ledger, m, parity, e: evaluation(f.h, f.input, out) };
}

for (const spec of corrections) {
  Deno.test(`P1 business correction ${spec.business}: actual old/new quantities survive durable Memory and final B2`, async () => {
    const f = await corrected(spec), changed = spec.scopes[spec.changedScope];
    const target = f.h.live.state.entities.find(entity => entity.entity_id === f.targetId)!;
    assert(target.quantity === f.oldQuantity + (spec.next - changed.value) * (changed.grouped ? changed.count : 1) &&
      target.attributes.unit === spec.unit, "correction inferred the wrong scope count or unit");
    unchanged(f.h.live.state.entities.find(entity => entity.entity_id === f.sibling.entity_id), f.sibling, "correction leaked into another subitem/unit");
    for (const row of f.oldRows.filter(row => row.scope !== changed.name && row.group_scope !== changed.name)) {
      const current = (target.attributes.scoped_customer_updates as ScopedCustomerValue[]).find(value => value.scope === row.scope);
      assert(sameCanonicalJson(current, row), "correction changed another scope's value or provenance");
    }
    assert(verifyCommittedScopedCorrectionMemory(f.parity), "canonical Memory lost source-bound old/new facts");
    const db = await memoryStorage(f.h, f.previous), stored = await refreshConversationLongMemory(db.client, memoryArgs(f.h, f.input, f.receipt));
    assert(stored.ok && db.live.writes === 1 && db.live.reads >= 3 && sameCanonicalJson(stored.memory, db.live.row.memory) &&
      verifyCommittedScopedCorrectionMemory({ ...f.parity, memory: stored.memory }), "correction required actual persisted Memory readback");
    const sent = await gate(f.h, f.input, f.e);
    assert(evaluateB2BeforeCommit(f.e).code === "B2_ALLOW_JOURNEY_PROGRESS_AFTER_ACCEPTED_UPDATE" &&
      sent.result.committed && sent.commits === 1 && sent.stateReads === 2, "actual final B2 did not bind the business correction");
    noTransaction(f.h.live.state);
  });
  for (const mode of ["missing-reading", "wrong-old-value", "wrong-unit", "forged-source"] as const)
    Deno.test(`P1 business correction ${spec.business} negative: ${mode}`, async () => {
      const f = await correctionFixture(spec);
      if (mode === "wrong-old-value") f.input = correctionInput(f.h, spec, f.targetId, true, 9);
      if (mode === "missing-reading") f.input.semantic_frame = null;
      else if (mode === "wrong-unit") {
        f.input.semantic_frame!.entities[0].unit = "tokens";
        (f.input.semantic_frame!.entities[0].attributes.scoped_customer_updates as Array<Record<string, unknown>>)[0].unit = "tokens";
      } else if (mode === "forged-source")
        (f.input.semantic_frame!.entities[0].attributes.scoped_customer_updates as Array<Record<string, unknown>>)[0].source_text = "model invented this correction";
      const before = structuredClone(f.h.live.state), writes = f.h.live.writes, revision = f.h.live.revision;
      const out = await f.h.ask(f.input);
      assert(!out?.trusted_journey_progress && out?.route !== "contextual_scoped_update" &&
        f.h.live.writes === writes && f.h.live.revision === revision, mode + " wrote or claimed a correction: " +
        JSON.stringify({ out, before, after: f.h.live.state, writes: f.h.live.writes - writes }));
      unchanged(f.h.live.state, before, "rejected correction changed scoped facts");
    });
  Deno.test(`P1 business correction ${spec.business}: same-source replay reuses durable old/new proof`, async () => {
    const f = await corrected(spec), db = await memoryStorage(f.h, f.previous);
    const stored = await refreshConversationLongMemory(db.client, memoryArgs(f.h, f.input, f.receipt)); assert(stored.ok, "initial Memory commit failed");
    const before = structuredClone(f.h.live.state), revision = f.h.live.revision, writes = f.h.live.writes, again = await f.h.ask(f.input);
    assert(again?.trusted_journey_progress?.update_kind === "contextual_scoped_update" && again.persist_result === "no_semantic_change" &&
      f.h.live.revision === revision && f.h.live.writes === writes &&
      sameCanonicalJson(again.trusted_journey_progress.scoped_correction, f.ledger), "replay minted a new correction");
    unchanged(f.h.live.state, before, "replay changed canonical scoped facts");
    const repeated = await refreshConversationLongMemory(db.client, memoryArgs(f.h, f.input, again.trusted_journey_progress));
    assert(repeated.ok && repeated.idempotent && db.live.writes === 1, "durable Memory replay wrote twice");
  });
  Deno.test(`P1 business correction ${spec.business} Memory negative: bound current facts cannot be substituted`, async () => {
    const f = await corrected(spec), parity = structuredClone(f.parity);
    if (spec.business === "restaurant") parity.memory.current_customer_facts.find(row => row.entity_id === f.targetId && row.key.endsWith(":quantity"))!.value = 99;
    if (spec.business === "saas") parity.memory.source_message_id = "other-visitor-turn";
    if (spec.business === "b2b") parity.commerce.revision--;
    assert(!verifyCommittedScopedCorrectionMemory(parity), "unbound current facts passed Memory parity");
  });
  Deno.test(`P1 business correction ${spec.business} B2 negative: tampered receipt cannot persist a reply`, async () => {
    const f = await corrected(spec), proof = f.e.trusted_journey_progress!;
    if (spec.business === "restaurant") proof.source_text = "a different customer request";
    if (spec.business === "saas") proof.company_id = "foreign-company";
    if (spec.business === "b2b") proof.committed_revision++;
    assert(evaluateB2BeforeCommit(f.e).decision !== "allow", "tampered receipt passed initial B2");
    const denied = await gate(f.h, f.input, f.e);
    assert(!denied.result.committed && denied.commits === 0, "tampered correction reached final reply callback");
  });
}

const pendingCases: PairSpec[] = [lifecycleCases[0],
  { business: "restaurant", language: "en",
    base: { name: "Vegetarian lunch boxes", quantity: 18, unit: "boxes", requirements: { label: "no nuts requested" } },
    addon: { name: "Hot drink station", quantity: 1, unit: "station", requirements: { power: "customer socket review pending" } } },
  { business: "b2b", language: "en",
    base: { name: "Steel shelving", quantity: 3, unit: "racks", requirements: { wall: "customer wall load review pending" } },
    addon: { name: "Safety anchors", quantity: 12, unit: "anchors", requirements: { drawing: "customer pattern review pending" } } },
];
function pendingFixture(spec: PairSpec) {
  const initial = pair(spec);
  const checks = spec.business === "retail" ? ["chair fabric sample review", "footrest finish review", "shared delivery access review"]
    : spec.business === "restaurant" ? ["customer allergen label review", "drink station socket review", "shared collection time review"]
    : ["shelving wall load review", "anchor pattern review", "shared site access review"];
  initial.installation.pending_checks = [checks[2]];
  initial.installation.items = initial.entities.map((entity, i) => ({ item_id: `${spec.business}-check-${i}`,
    entity_id: entity.entity_id, kind: checks[i], status: "pending", details: {},
    provenance: { source_type: "customer", source_message_id: `${spec.business}-pending-source-${i}` } }));
  const h = storage(`${spec.business}-pending`, initial, 6), frame = reading("ASK_FACT", "installation");
  frame.intent = "read current pending checks"; frame.requested_facts = ["pending_checks"];
  frame.referents = [{ ref: `${spec.business}:addon`, source: "persistent_state", confidence: .99 }];
  const input = h.turn(`For this ${spec.addon.name}, how many checks are still pending?`, frame, `${spec.business}-pending-query`);
  return { h, input, checks };
}
for (const spec of pendingCases) {
  Deno.test(`P1 business pending ${spec.business}: named/global counts and known zero are read-only`, async () => {
    const f = pendingFixture(spec), before = structuredClone(f.h.live.state), named = await f.h.ask(f.input);
    assert(named?.state_path === `installation.items[entity_id=${spec.business}:addon]` &&
      named.reply?.includes(f.checks[1]) && !named.reply.includes(f.checks[0]) && !named.reply.includes(f.checks[2]),
      "named pending count leaked parent/global checks: " + JSON.stringify(named));
    const global = await f.h.ask({ ...f.input, text: "How many checks are still pending?", source_message_id: "global-query" });
    assert(global?.state_path === "installation.pending_checks" && global.reply?.includes("3") &&
      f.checks.every(check => global.reply!.includes(check)), "global pending count borrowed the last named scope");
    const repeated = await f.h.ask(f.input); unchanged(repeated, named, "same-source pending replay changed result");
    unchanged(f.h.live.state, before, "read-only pending query mutated requirements");
    f.h.live.state.installation.items[1].status = "cancelled";
    const zero = await f.h.ask({ ...f.input, source_message_id: "known-zero-query" });
    assert(zero?.reply?.includes("no pending") && zero.state_path === named.state_path && f.h.live.writes === 0 &&
      f.h.live.revision === 6, "known zero became unknown or a write");
  });
  for (const mode of ["missing-reading", "conflicting-subject", "unknown-binding"] as const)
    Deno.test(`P1 business pending ${spec.business} negative: ${mode}`, async () => {
      const f = pendingFixture(spec);
      if (mode === "missing-reading") { f.input.text = "How many checks are still pending for this item?"; f.input.semantic_frame = null; }
      if (mode === "conflicting-subject") f.input.text = `For this ${spec.base.name}, how many checks are still pending?`;
      if (mode === "unknown-binding") f.h.live.state.installation.items = [];
      const before = structuredClone(f.h.live.state), out = await f.h.ask(f.input);
      assert(out?.reason === "read_only_current_state_aggregate_query_unresolved" && !out.state_path &&
        out.authority === "INSUFFICIENT_INFORMATION" && !f.checks.some(check => out.reply?.includes(check)) &&
        f.h.live.writes === 0 && f.h.live.revision === 6, "unbound pending query gained authority: " + JSON.stringify(out));
      if (mode !== "unknown-binding") assert(typeof out.reply === "string" && /[?？]/u.test(out.reply) &&
        /\bwhich\s+(?:product|item|installation)\b/iu.test(out.reply), "unbound or contradictory subject did not receive a targeted question");
      else assert(!/\bno pending\b|\b(?:0|zero)\s+(?:pending|checks)\b/iu.test(out.reply ?? ""),
        "missing item-to-check binding was reported as a known zero");
      unchanged(f.h.live.state, before, "rejected pending query mutated state");
    });
}

function recallInput(f: Awaited<ReturnType<typeof committedLifecycle>>, question: string): ConversationRecallInput {
  // Canonical read-only recall consumes verified persisted Commerce/Memory,
  // not an artificial new Reading supplied merely to count Reading coverage.
  return { ...f.h.owner, source_message_id: `${f.h.owner.conversation_id}-recap`, question, memory: structuredClone(f.m),
    recent_questions: [`Tell me about ${f.initial.entities[1].attributes.product_name}`],
    commerce: { ...f.h.owner, source_message_id: f.h.live.source, revision: f.h.live.revision, state: structuredClone(f.h.live.state) } };
}
for (const spec of lifecycleCases) {
  Deno.test(`P1 business recap ${spec.business}: named parent and global recap preserve distinct units/inactive add-on`, async () => {
    const f = await committedLifecycle(spec), before = structuredClone(f.h.live.state);
    const named = prepareConversationRecall(recallInput(f, `Recap ${spec.base.name}.`), spec.language);
    assert(named.decision.handled && named.reply?.includes(`${spec.business.toUpperCase()}-BASE`) &&
      !named.reply.includes(`${spec.business.toUpperCase()}-ADD`), "named recap leaked inactive add-on");
    const namedValue = named.decision.value as { entity_details: Array<{ entity_id: string }>; transaction: unknown };
    assert(namedValue.entity_details.length === 1 && namedValue.entity_details[0].entity_id === `${spec.business}:base` &&
      namedValue.transaction === null, "named recap changed scope or inferred a transaction");
    for (const question of ["Give me a recap of everything.", "而家我有咩記低？"]) {
      const all = prepareConversationRecall(recallInput(f, question), spec.language);
      assert(typeof all.reply === "string", "global recap returned no final reply");
      assert(all.decision.handled && all.reply.includes(`${spec.business.toUpperCase()}-BASE`) &&
        all.reply.includes(`${spec.business.toUpperCase()}-ADD`) &&
        (all.decision.value as { selection_provenance: string }).selection_provenance === "global",
        "global recap inherited the last entity scope");
      const details = (all.decision.value as { entity_details: CommerceEntity[] }).entity_details;
      assert(details.length === 2 && details.every(entity => {
        const source = f.h.live.state.entities.find(value => value.entity_id === entity.entity_id);
        return source && entity.quantity === source.quantity && entity.status === source.status &&
          entity.attributes.unit === source.attributes.unit;
      }), "recap merged quantities or units across the parent and add-on");
      for (const item of [spec.base, spec.addon]) assert(all.reply.includes(spec.language === "en"
        ? `${item.quantity} ${item.unit}` : `${item.quantity}${item.unit}`), "final recap lost the customer's literal quantity/unit");
      assert(spec.language === "en" ? all.reply.includes("paused") : all.reply.includes("暫緩"), "global recap reactivated the paused add-on");
    }
    unchanged(f.h.live.state, before, "recap changed quantities/status/source");
    assert(f.h.live.writes === 1 && f.h.live.revision === 9, "recap performed a business write");
  });
  Deno.test(`P1 business recap ${spec.business} negative: duplicate name cannot select one parent`, async () => {
    const f = await committedLifecycle(spec), input = recallInput(f, `Recap ${spec.base.name}.`);
    input.commerce!.state.entities.push({ ...structuredClone(input.commerce!.state.entities[0]), entity_id: "duplicate-parent" });
    const answer = prepareConversationRecall(input, spec.language);
    assert(!answer.decision.handled && answer.decision.reason === "AMBIGUOUS", "ambiguous parent borrowed an arbitrary subitem");
  });
  const mode = spec.business === "retail" ? "tenant" : spec.business === "beauty" ? "ticket" : "stale-memory";
  Deno.test(`P1 business recap ${spec.business} negative: ${mode}`, async () => {
    const f = await committedLifecycle(spec), input = structuredClone(recallInput(f, `Recap ${spec.base.name}.`));
    if (mode === "tenant") input.company_id = "foreign-company";
    if (mode === "ticket") input.conversation_id = "foreign-ticket";
    if (mode === "stale-memory") {
      assert(typeof input.memory?.commerce_state_revision === "number", "negative requires real committed Memory revision");
      input.memory.commerce_state_revision--;
    }
    const before = structuredClone(input), answer = prepareConversationRecall(input, spec.language);
    assert(!answer.decision.handled, "foreign/stale Memory supplied recap authority");
    unchanged(input, before, "rejected recap mutated input");
  });
}
