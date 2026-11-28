import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { b2KnownContextRepair, collectKnownCommerceFacts, evaluateB2BeforeCommit } from "./pre-send-conversion-supervisor.ts";

const owner = { company_id: "company-a", conversation_id: "ticket-a", source_message_id: "source-now" };
const requests = ["Which installation type is required?", "請提供安裝項目。", "请提供安装项目。"];
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function generic(category: string, kind: string) {
  const state = createEmptyConversationCommerceState();
  state.entities = [{ entity_id: category + ":one", category, quantity: 1, status: "researching",
    attributes: { kind, product_name: category + " selection" }, constraints: {},
    provenance: { source_type: "customer", source_message_id: owner.source_message_id } }];
  return state;
}
function snapshot(state: ReturnType<typeof createEmptyConversationCommerceState>) {
  return { ...owner, source_message_content: "Please check the remaining setup options.",
    commerce_state_revision: 4, commerce_state_source_message_id: owner.source_message_id, state };
}
Deno.test("Task3C B2 generic entity kind is not an installation field across domains and languages", () => {
  for (const [category, kind] of [["training", "discussion workshop"], ["catering", "celebration cake"],
    ["software", "team subscription"]]) for (const proposed_response of requests) {
    const state = generic(category, kind), before = JSON.stringify(state);
    const result = evaluateB2BeforeCommit({ proposed_response, persistence_kind: "ai_reply", snapshot: snapshot(state) });
    check(result.decision === "allow", category + ": " + proposed_response + ": " + JSON.stringify(result));
    check(JSON.stringify(state) === before, "B2 changed canonical state");
    const facts = collectKnownCommerceFacts(state).filter(fact => fact.path.endsWith(".kind"));
    check(facts.length === 1 && facts[0].field_aliases.includes("kind") &&
      !facts[0].field_aliases.some(label => /installation|安裝|安装/.test(label)), "Generic kind inherited installation labels");
  }
});
Deno.test("Task3C B2 retains actual installation item kind re-ask protection and exact repair binding", () => {
  for (const proposed_response of requests) {
    const state = generic("training", "discussion workshop");
    state.installation.items = [{ item_id: "setup-one", entity_id: state.entities[0].entity_id,
      kind: "provided setup choice", status: "pending", details: {},
      provenance: { source_type: "customer", source_message_id: owner.source_message_id } }];
    const snap = snapshot(state), before = JSON.stringify(snap);
    const result = evaluateB2BeforeCommit({ proposed_response, persistence_kind: "ai_reply", snapshot: snap });
    check(result.code === "KNOWN_CONTEXT_RECONFIRMATION" && result.decision === "block", JSON.stringify(result));
    check(result.context_request?.target?.field === "installation.items.0.kind", JSON.stringify(result));
    check(b2KnownContextRepair(result, snap)?.field === "installation.items.0.kind", "Correct source-owned field could not supply bounded repair");
    for (const changed of [{ company_id: "other-company" }, { conversation_id: "other-ticket" },
      { source_message_id: "other-source" }, { commerce_state_revision: 5 }, { commerce_state_source_message_id: "old-source" }]) {
      check(b2KnownContextRepair(result, { ...snap, ...changed }) === null, "Forged or stale repair binding accepted");
    }
    check(JSON.stringify(snap) === before, "B2 or repair changed canonical source");
  }
});
Deno.test("Task3C B2 ordinary kind facts retain their literal field protection", () => {
  for (const category of ["training", "catering", "software"]) {
    const state = generic(category, "visitor choice");
    const result = evaluateB2BeforeCommit({ proposed_response: "What kind is required?", persistence_kind: "ai_reply", snapshot: snapshot(state) });
    check(result.code === "KNOWN_CONTEXT_RECONFIRMATION" && result.context_request?.target?.field === "entities.0.attributes.kind",
      "Literal known kind lost its own field guard: " + JSON.stringify(result));
  }
});
Deno.test("Task3C B2 nested or caller-named kind cannot masquerade as the canonical installation item", () => {
  const state = generic("training", "discussion workshop");
  state.entities[0].attributes["installation.items.0.kind"] = "synthetic field name";
  state.customer_constraints.kind = "group learning";
  state.installation.site_conditions.kind = "visitor venue class";
  const result = evaluateB2BeforeCommit({ proposed_response: requests[0], persistence_kind: "ai_reply", snapshot: snapshot(state) });
  check(result.decision === "allow", JSON.stringify(result));
  const owned = collectKnownCommerceFacts(state).filter(fact => fact.field_aliases.includes("installation type"));
  check(owned.length === 0, JSON.stringify(owned));
});
