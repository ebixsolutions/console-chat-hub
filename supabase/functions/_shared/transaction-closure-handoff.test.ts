import {
  buildC2HandoffPackage,
  classifyC2HandoffReason,
  decideTransactionClosure,
  parsePersistedC2Handoff,
  renderC2HandoffSummary,
  transactionBlockers,
  validateC2CommitSnapshot,
} from "./transaction-closure-handoff.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function state() {
  return createEmptyConversationCommerceState();
}
function packageInput(overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: "11111111-1111-4111-8111-111111111111",
    company_id: "22222222-2222-4222-8222-222222222222",
    source_message_id: "33333333-3333-4333-8333-333333333333",
    handoff_reason: "Customer requested human support",
    handoff_authority: "R1",
    commerce_state_revision: 7,
    commerce_state: state(),
    current_customer_goal: "Confirm two air conditioners",
    generated_at: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

Deno.test("C2 explicit customer request reason is classified", () => {
  assert(classifyC2HandoffReason("R1") === "explicit_customer_request", "R1 classification");
});
Deno.test("C2 safety authority is classified", () => {
  assert(classifyC2HandoffReason("E2") === "professional_or_safety_confirmation", "E2 classification");
});
Deno.test("C2 low CE has no handoff authority", () => {
  assert(classifyC2HandoffReason("low_ce") === "existing_escalation_authority", "CE invented authority");
});
Deno.test("C2 angry only has no handoff authority", () => {
  assert(classifyC2HandoffReason("anger") === "existing_escalation_authority", "anger invented authority");
});
Deno.test("C2 VIP only has no handoff authority", () => {
  assert(classifyC2HandoffReason("vip") === "existing_escalation_authority", "VIP invented authority");
});
Deno.test("C2 acknowledgement cannot resolve", () => {
  const d = decideTransactionClosure({ utterance_kind: "closure_candidate", commerce_state: state() });
  assert(d.state === "WAITING_FOR_CUSTOMER" && !d.may_resolve, "ack resolved");
});
Deno.test("C2 explicit no-more may resolve empty canonical state", () => {
  const d = decideTransactionClosure({ utterance_kind: "no_more_help", commerce_state: state() });
  assert(d.state === "RESOLVED" && d.may_resolve, "clean closure rejected");
});
Deno.test("C2 unresolved question blocks resolve", () => {
  const s = state(); s.unresolved_items = ["confirm price"];
  assert(!decideTransactionClosure({ utterance_kind: "no_more_help", commerce_state: s }).may_resolve, "unresolved closed");
});
Deno.test("C2 waiting customer remains open", () => {
  const d = decideTransactionClosure({ utterance_kind: "closure_candidate", commerce_state: state() });
  assert(d.state === "WAITING_FOR_CUSTOMER", "waiting customer lost");
});
Deno.test("C2 waiting human remains pending", () => {
  const d = decideTransactionClosure({ utterance_kind: "no_more_help", commerce_state: state(), handoff_active: true });
  assert(d.state === "WAITING_FOR_HUMAN", "human state lost");
});
Deno.test("C2 deterministic handoff prevents resolve", () => {
  const d = decideTransactionClosure({ utterance_kind: "no_more_help", commerce_state: state(), handoff_required: true });
  assert(d.state === "HANDOFF_REQUIRED", "handoff bypassed");
});
Deno.test("C2 tentative entity blocks resolve", () => {
  const s = state(); s.entities.push({ entity_id:"a", category:"aircon", quantity:2, status:"tentative", attributes:{}, constraints:{}, provenance:{source_type:"customer"} });
  assert(transactionBlockers(s).includes("tentative_entity"), "tentative entity omitted");
});
Deno.test("C2 unconfirmed order cannot be resolved", () => {
  const s = state(); s.conversion.order_status = "pending_confirmation";
  assert(transactionBlockers(s).includes("order_pending"), "order false completion");
});
Deno.test("C2 unpaid cannot be resolved", () => {
  const s = state(); s.conversion.payment_status = "pending_payment";
  assert(transactionBlockers(s).includes("payment_pending"), "payment false completion");
});
Deno.test("C2 delivery discussed is not confirmed", () => {
  const s = state(); s.delivery.confirmed = false;
  const pkg = buildC2HandoffPackage(packageInput({ commerce_state:s }));
  assert(pkg.transaction_state.delivery === "not_confirmed", "delivery false completion");
});
Deno.test("C2 installation pending is not completed", () => {
  const s = state(); s.installation.items.push({ item_id:"i", kind:"site", status:"pending", details:{}, provenance:{source_type:"customer"} });
  const pkg = buildC2HandoffPackage(packageInput({ commerce_state:s }));
  assert(pkg.transaction_state.installation === "pending", "installation false completion");
});
Deno.test("C2 latest correction is current", () => {
  const s = state(); s.latest_corrections = ["quantity 3 → 2"];
  const pkg = buildC2HandoffPackage(packageInput({ commerce_state:s }));
  assert(pkg.latest_corrections[0] === "quantity 3 → 2", "correction lost");
});
Deno.test("C2 cancelled entity is excluded", () => {
  const s = state();
  s.entities.push({ entity_id:"old", category:"aircon", quantity:3, status:"cancelled", attributes:{}, constraints:{}, provenance:{source_type:"customer"} });
  assert(buildC2HandoffPackage(packageInput({ commerce_state:s })).active_entities.length === 0, "cancelled revived");
});
Deno.test("C2 active entities remain isolated", () => {
  const s = state();
  s.entities.push(
    { entity_id:"a", category:"aircon", model:"A", quantity:2, status:"confirmed", attributes:{}, constraints:{}, provenance:{source_type:"customer"} },
    { entity_id:"b", category:"aircon", model:"B", quantity:1, status:"tentative", attributes:{}, constraints:{}, provenance:{source_type:"customer"} },
  );
  const pkg = buildC2HandoffPackage(packageInput({ commerce_state:s }));
  assert(pkg.active_entities[0].model === "A" && pkg.active_entities[1].model === "B", "entity merge");
});
Deno.test("C2 current quote attaches to its entity only", () => {
  const s = state();
  s.entities.push(
    { entity_id:"a", category:"aircon", quantity:1, status:"confirmed", attributes:{}, constraints:{}, provenance:{source_type:"customer"} },
    { entity_id:"b", category:"aircon", quantity:1, status:"confirmed", attributes:{}, constraints:{}, provenance:{source_type:"customer"} },
  );
  s.quotes.push({ quote_id:"q", entity_id:"b", amount:200, currency:"HKD", quote_type:"current_verified", validity_status:"current", conditions:{}, provenance:{source_type:"system"} });
  const pkg = buildC2HandoffPackage(packageInput({ commerce_state:s }));
  assert(pkg.active_entities[0].current_quote === null && pkg.active_entities[1].current_quote?.amount === 200, "quote cross entity");
});
Deno.test("C2 historical quote is never current", () => {
  const s = state();
  s.quotes.push({ quote_id:"old", amount:999, currency:"HKD", quote_type:"customer_reported_historical", validity_status:"historical", conditions:{}, provenance:{source_type:"customer"} });
  const pkg = buildC2HandoffPackage(packageInput({ commerce_state:s }));
  assert(pkg.historical_or_superseded_facts.length === 1 && pkg.active_entities.every(x=>x.current_quote===null), "historical quote current");
});
Deno.test("C2 confirmed order requires canonical proof", () => {
  const s = state(); s.conversion.order_status = "confirmed";
  const pkg = buildC2HandoffPackage(packageInput({ commerce_state:s }));
  assert(pkg.confirmed_facts.some(x=>x.key==="order"), "confirmed order omitted");
});
Deno.test("C2 paid requires canonical proof", () => {
  const s = state(); s.conversion.payment_status = "paid";
  assert(buildC2HandoffPackage(packageInput({ commerce_state:s })).confirmed_facts.some(x=>x.key==="payment"), "paid omitted");
});
Deno.test("C2 optional missing values stay unknown", () => {
  const pkg = buildC2HandoffPackage(packageInput({ commerce_state:null }));
  assert(pkg.transaction_state.order === "unknown" && pkg.active_entities.length === 0, "invented optional facts");
});
Deno.test("C2 sensitive identity preferences are omitted", () => {
  const s = state(); s.customer_constraints = { color:"white", address:"secret", phone:"123" };
  const pkg = buildC2HandoffPackage(packageInput({ commerce_state:s }));
  assert(pkg.customer_preferences.length === 1 && pkg.customer_preferences[0].key === "color", "PII leaked");
});
Deno.test("C2 only current citations survive", () => {
  const citations = [
    {document_id:"d",chunk_id:"c",source_type:"policy",evidence_state:"current",authority_decision:"USE_CURRENT_KB",target_entity_model:[]},
    {document_id:"old",chunk_id:"old-c",source_type:"policy",evidence_state:"historical",target_entity_model:[]},
  ];
  const pkg = buildC2HandoffPackage(packageInput({ citations }));
  assert(pkg.citations.length === 1 && pkg.citations[0].document_id === "d", "stale citation survived");
});
Deno.test("C2 wrong entity citation is rejected", () => {
  const s = state(); s.entities.push({ entity_id:"product-b", category:"item", quantity:1, status:"confirmed", attributes:{}, constraints:{}, provenance:{source_type:"customer"} });
  const citations = [{document_id:"a",chunk_id:"a1",source_type:"policy",evidence_state:"current",target_entity_model:["product-a"]}];
  assert(buildC2HandoffPackage(packageInput({ commerce_state:s, citations })).citations.length === 0, "wrong entity citation");
});
Deno.test("C2 source citation lineage remains complete", () => {
  const citations = [{document_id:"d",chunk_id:"c",source_type:"policy",evidence_state:"current",authority_decision:"USE_CURRENT_KB",target_topics:["warranty"]}];
  const c = buildC2HandoffPackage(packageInput({ citations })).citations[0];
  assert(c.document_id==="d" && c.chunk_id==="c" && c.source_type==="policy", "citation lineage incomplete");
});
Deno.test("C2 markdown is a projection of structured package", () => {
  const pkg = buildC2HandoffPackage(packageInput());
  const md = renderC2HandoffSummary(pkg);
  assert(md.includes(pkg.current_customer_goal) && md.includes(pkg.handoff_reason), "projection diverged");
});
Deno.test("C2 package does not clone raw transcript", () => {
  const pkg = buildC2HandoffPackage(packageInput());
  assert(!("transcript" in pkg) && !("messages" in pkg), "raw transcript included");
});
Deno.test("C2 stale source precommit is rejected", () => {
  const r = validateC2CommitSnapshot(
    {conversation_id:"c",company_id:"t",source_message_id:"old",commerce_state_revision:1},
    {conversation_id:"c",company_id:"t",latest_source_message_id:"new",commerce_state_revision:1,handoff_authority_valid:true},
  );
  assert(!r.ok && r.reason==="stale_source_message", "stale source accepted");
});
Deno.test("C2 stale commerce revision is rejected", () => {
  const r = validateC2CommitSnapshot(
    {conversation_id:"c",company_id:"t",source_message_id:"m",commerce_state_revision:1},
    {conversation_id:"c",company_id:"t",latest_source_message_id:"m",commerce_state_revision:2,handoff_authority_valid:true},
  );
  assert(!r.ok && r.reason==="stale_commerce_revision", "stale revision accepted");
});
Deno.test("C2 wrong tenant is rejected", () => {
  const r = validateC2CommitSnapshot(
    {conversation_id:"c",company_id:"a",source_message_id:"m",commerce_state_revision:1},
    {conversation_id:"c",company_id:"b",latest_source_message_id:"m",commerce_state_revision:1,handoff_authority_valid:true},
  );
  assert(!r.ok && r.reason==="tenant_or_conversation_mismatch", "cross tenant accepted");
});
Deno.test("C2 invalid handoff authority is rejected", () => {
  const r = validateC2CommitSnapshot(
    {conversation_id:"c",company_id:"t",source_message_id:"m",commerce_state_revision:1},
    {conversation_id:"c",company_id:"t",latest_source_message_id:"m",commerce_state_revision:1,handoff_authority_valid:false},
  );
  assert(!r.ok && r.reason==="handoff_authority_invalid", "invalid authority accepted");
});
Deno.test("C2 human supersession is rejected", () => {
  const r = validateC2CommitSnapshot(
    {conversation_id:"c",company_id:"t",source_message_id:"m",commerce_state_revision:1},
    {conversation_id:"c",company_id:"t",latest_source_message_id:"m",commerce_state_revision:1,handoff_authority_valid:true,superseded_by_human_action:true},
  );
  assert(!r.ok && r.reason==="human_action_superseded", "human supersession ignored");
});
Deno.test("C2 fresh retry succeeds", () => {
  const r = validateC2CommitSnapshot(
    {conversation_id:"c",company_id:"t",source_message_id:"m2",commerce_state_revision:2},
    {conversation_id:"c",company_id:"t",latest_source_message_id:"m2",commerce_state_revision:2,handoff_authority_valid:true},
  );
  assert(r.ok, "fresh retry rejected");
});
Deno.test("C2 persisted envelope readback is validated", () => {
  const pkg = buildC2HandoffPackage(packageInput());
  const envelope = {schema_version:"c2-handoff-1.0.0",structured_package:pkg,summary_markdown:renderC2HandoffSummary(pkg)};
  assert(parsePersistedC2Handoff(JSON.stringify(envelope))?.structured_package.company_id===pkg.company_id, "readback failed");
});
Deno.test("C2 malformed readback fails closed", () => {
  assert(parsePersistedC2Handoff('{"schema_version":"wrong"}')===null, "malformed accepted");
});
Deno.test("C2 package generation never mutates canonical state", () => {
  const s = state(); const before = JSON.stringify(s);
  buildC2HandoffPackage(packageInput({ commerce_state:s }));
  assert(JSON.stringify(s)===before, "canonical state mutated");
});
