/** Request-local identity projection. The provider sees opaque references;
 * canonical customer/source identities and outbound PII redaction stay intact.
 * A reference selects a previously verified object, never supplies a fact. */
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { readSourceBoundContextualGoal } from "./contextual-customer-update.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  !!value && typeof value === "object" && !Array.isArray(value);
const prefix = "contextual-ref-";

export interface ContextualReferenceProjection {
  summary: string | null;
  /** Only normalized typed references can be decoded. Customer words, quoted
   * source, attributes and requested facts are not traversed or rewritten. */
  restore(frame: CommerceSemanticFrame): CommerceSemanticFrame | null;
}

export async function projectContextualSemanticReferences(input: {
  summary: string | null;
  company_id: string;
  conversation_id: string;
  source_message_id: string;
}): Promise<ContextualReferenceProjection> {
  const bindings = new Map<string, string>();
  const restore = (frame: CommerceSemanticFrame): CommerceSemanticFrame | null => {
    const referenced = new Set<string>();
    for (const item of frame.referents) {
      if (!item.ref.startsWith(prefix)) continue;
      if (item.source !== "persistent_state" || item.confidence < .9 || !bindings.has(item.ref)) return null;
      referenced.add(item.ref);
    }
    for (const item of frame.entities) {
      if (item.entity_ref.startsWith(prefix) &&
        (!bindings.has(item.entity_ref) || !referenced.has(item.entity_ref))) return null;
    }
    if (!referenced.size) return frame;
    return {...frame,
      entities: frame.entities.map(item => ({...item,
        entity_ref: bindings.get(item.entity_ref) ?? item.entity_ref})),
      referents: frame.referents.map(item => ({...item,
        ref: bindings.get(item.ref) ?? item.ref})),
    };
  };
  const unchanged = () => ({summary: input.summary, restore});
  if (!input.summary || [input.company_id,input.conversation_id,input.source_message_id]
    .some(value => typeof value !== "string" || !value || value.length > 200)) return unchanged();
  let parsed: unknown;
  try { parsed = JSON.parse(input.summary); } catch { return unchanged(); }
  if (!record(parsed) || !Number.isInteger(parsed.revision) || Number(parsed.revision) < 1 ||
    !record(parsed.state) || !record(parsed.state.customer_constraints) ||
    !Array.isArray(parsed.state.entities)) return unchanged();
  const state = createEmptyConversationCommerceState();
  state.current_topic = typeof parsed.state.current_topic === "string" ? parsed.state.current_topic : null;
  state.customer_constraints = parsed.state.customer_constraints;
  const goal = readSourceBoundContextualGoal(state, {company_id:input.company_id,
    conversation_id:input.conversation_id,source_message_id:input.source_message_id,
    state_revision:Number(parsed.revision)});
  if (!goal) return unchanged();
  const goalIdentity = goal.goal_id, revision = Number(parsed.revision);
  const materializedId = "contextual-item:" + goalIdentity;
  const materialized = parsed.state.entities.filter(item => record(item) &&
    (item.entity_id === materializedId || record(item.attributes) &&
      item.attributes.contextual_goal_id === goalIdentity));
  if (materialized.length > 1) return unchanged();
  const item = materialized[0];
  if (item && (!record(item) || item.entity_id !== materializedId ||
    !["researching","tentative","confirmed"].includes(String(item.status)) ||
    item.category !== goal.subject_label ||
    !record(item.attributes) || item.attributes.contextual_goal_id !== goalIdentity ||
    item.attributes.product_name !== goal.subject_label ||
    item.attributes.subject_source_message_id !== goal.source_message_id ||
    item.attributes.subject_source_revision !== goal.recorded_revision ||
    !record(item.provenance) || item.provenance.source_type !== "customer" ||
    typeof item.provenance.source_message_id !== "string" || !item.provenance.source_message_id)) return unchanged();
  const alias = async (kind: "goal" | "item", identity: string) => {
    const bytes = new TextEncoder().encode(JSON.stringify([
      "contextual-reference-1",input.company_id,input.conversation_id,input.source_message_id,
      revision,kind,identity,
    ]));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    // Alphabetic encoding remains opaque to the unchanged PHONE/UUID filters.
    // It is not an encoding of the UUID: the digest binds the entire request.
    const token = prefix + kind + "-" + [...digest].map(value =>
      String.fromCharCode(97+(value>>4),97+(value&15))).join("");
    bindings.set(token,identity);
    return token;
  };
  const goalAlias = await alias("goal",goalIdentity);
  // JSON was parsed above; edits affect this private projection only.
  (parsed.state.customer_constraints.contextual_goal as RecordValue).goal_id = goalAlias;
  const facts = parsed.state.customer_constraints.contextual_scope_facts;
  if (Array.isArray(facts)) for (const fact of facts) {
    if (record(fact) && fact.goal_id === goalIdentity) fact.goal_id = goalAlias;
  }
  if (record(item) && record(item.attributes)) {
    item.entity_id = await alias("item",materializedId);
    item.attributes.contextual_goal_id = goalAlias;
    if (Array.isArray(item.attributes.scoped_customer_updates)) for (const row of item.attributes.scoped_customer_updates) {
      if (!record(row)) continue;
      if (row.group_goal_id === goalIdentity) row.group_goal_id = goalAlias;
      if (record(row.scope_count_source) && row.scope_count_source.goal_id === goalIdentity)
        row.scope_count_source.goal_id = goalAlias;
    }
  }
  // Only rewrite the known server-owned identity slot, not customer text.
  const pair=parsed.state.customer_constraints.paired_site_observation;
  if(record(pair)&&pair.version==="paired-site-1"&&pair.owner_kind==="persistent_state"){
    const projected=typeof pair.subject_ref==="string"?[...bindings].find(([,identity])=>identity===pair.subject_ref)?.[0]:undefined;
    if(projected)pair.subject_ref=projected;
  }
  parsed.contextual_reference_contract = {
    meaning:"Opaque object references valid only for this request; they do not supply customer facts.",
    slots:["entities[].entity_ref","referents[].ref"],referent_source:"persistent_state",
    instruction:"Copy the exact reference when selecting that existing object. Do not quote it as customer text.",
  };
  const summary = JSON.stringify(parsed);
  // The semantic transport only accepts complete bounded summaries. Do not
  // silently clip a reference table or an original customer fact to fit it.
  if (summary.length > 12_000) { bindings.clear(); return unchanged(); }
  return {summary,restore};
}
