import { createEmptyConversationCommerceState, type ConversationCommerceState } from "./commerce-state-contract.ts";
import { runCommerceStateRuntime, type CommerceStateDbClient } from "./commerce-state-runtime-base.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function state(): ConversationCommerceState {
  const s = createEmptyConversationCommerceState();
  for (const [id, name] of [["training-a", "Training kit"], ["display-b", "Display stand"]]) {
    s.entities.push({ entity_id: id, category: id, quantity: 1, status: "researching",
      attributes: { product_name: name }, constraints: {},
      provenance: { source_type: "customer", source_message_id: "source-" + id } });
    s.installation.items.push({ item_id: "check-" + id, kind: id + " check", entity_id: id,
      status: "pending", details: {}, provenance: { source_type: "customer", source_message_id: "check-source-" + id } });
  }
  s.installation.pending_checks = ["global site check"];
  return s;
}
function reading(ref = "training-a"): CommerceSemanticFrame {
  return { version: "commerce-semantic-1.0.0", language: "en", operation: "ASK_FACT", intent: "read current pending checks",
    topic: "installation", entities: [], referents: [{ ref, source: "persistent_state", confidence: 0.98 }],
    requested_facts: ["pending_checks"], customer_correction: false, additive: false, explicit_negations: [],
    transaction_state: "none", payment_state: "none", booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: 0.98 };
}
async function read(s: ConversationCommerceState, frame: CommerceSemanticFrame | null, text: string,
  options: {revision?:number;company_id?:string;conversation_id?:string} = {}) {
  const before = JSON.stringify(s); let writes = 0;
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
      company_id: options.company_id ?? "company", conversation_id: options.conversation_id ?? "ticket",
      revision: options.revision ?? 8, state: s }, error: null }) }) }) }),
    rpc: async () => { writes++; return { data: { result: "success", applied_revision: 9 }, error: null }; },
  };
  try {
  const result = await runCommerceStateRuntime(db, { company_id: "company", conversation_id: "ticket",
    source_message_id: "current-source", text, language: "en", semantic_frame: frame });
  assert(result?.revision === (Number.isFinite(options.revision ?? 8) && (options.revision ?? 8)>0 ? options.revision ?? 8 : 0) &&
    result.persist_result === "read_only", JSON.stringify(result));
  return result;
  } finally {
  assert(writes === 0 && JSON.stringify(s) === before, "Pending read changed state or provenance");
  }
}
Deno.test("Task3C deictic pending lookup preserves the exact customer-named subject", async () => {
  const result = await read(state(), null, "For this Training kit, how many checks are still pending?");
  assert(result?.state_path === "installation.items[entity_id=training-a]", JSON.stringify(result));
  assert(result.reply?.includes("1") && !result.reply.includes("display-b"), JSON.stringify(result));
});
Deno.test("Task3C scoped pending lookup can consume one verified persisted semantic reference", async () => {
  const result = await read(state(), reading(), "How many checks are still pending for this item?");
  assert(result?.state_path === "installation.items[entity_id=training-a]", JSON.stringify(result));
  assert(result.reply?.includes("training-a") && !result.reply.includes("display-b"), JSON.stringify(result));
});
Deno.test("Task3C global pending lookup is not narrowed by an incidental semantic reference", async () => {
  const result = await read(state(), reading(), "How many checks are still pending?");
  assert(result?.state_path === "installation.pending_checks", JSON.stringify(result));
  assert(result.reply?.includes("3") && result.reply.includes("training-a") && result.reply.includes("display-b"), JSON.stringify(result));
});
Deno.test("Task3C scoped pending lookup rejects conflicting, missing and inactive semantic references", async () => {
  for (const kind of ["missing", "conflicting", "duplicate", "inactive", "unowned", "weak"] as const) {
    const s = state(), frame = reading(kind === "missing" ? "absent" : "training-a");
    let text = "How many checks are still pending for this item?";
    if (kind === "conflicting") text = "For this Display stand, how many checks are still pending?";
    if (kind === "duplicate") frame.referents.push({ ref: "display-b", source: "persistent_state", confidence: 0.98 });
    // Explicit malformed-storage probe; production status vocabulary is unchanged.
    if (kind === "inactive") (s.entities[0] as {status:string}).status = "superseded";
    if (kind === "unowned") s.entities[0].provenance.source_type = "system";
    if (kind === "weak") frame.confidence = 0.7;
    const result = await read(s, frame, text);
    assert(result?.reason === "read_only_current_state_aggregate_query_unresolved", kind + ": " + JSON.stringify(result));
  }
});
Deno.test("Task3C scoped zero and absent entity bindings remain distinct from global pending state", async () => {
  const zero = state(); zero.installation.items[0].status = "cancelled";
  const result = await read(zero, reading(), "How many checks are still pending for this item?");
  assert(result?.state_path === "installation.items[entity_id=training-a]" && result.reply?.includes("no pending"), JSON.stringify(result));
  const unknown = state(); unknown.installation.items = [];
  const absent = await read(unknown, reading(), "How many checks are still pending for this item?");
  assert(absent?.reason === "read_only_current_state_aggregate_query_unresolved", JSON.stringify(absent));
});

Deno.test("Task3C scoped pending selector validates optional demand quotes and subject consistency", async () => {
  const text="How many checks are still pending for this item?";
  for (const kind of ["valid", "fabricated quote", "conflicting subject", "unquoted subject", "frame negation", "demand negation"] as const) {
    const frame=reading();
    frame.demands=[{question:text,source_quote:text,subject_refs:["training-a"],source_type:"general",
      requested_facts:["pending_checks"],constraints:{},customer_correction:false,explicit_negations:[],
      ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}];
    if(kind==="fabricated quote")frame.demands[0].source_quote="Unrelated model-only text.";
    if(kind==="conflicting subject")frame.demands[0].subject_refs=["display-b"];
    if(kind==="unquoted subject")frame.demands[0].subject_refs=["unmentioned item"];
    if(kind==="frame negation")frame.explicit_negations=["training-a"];
    if(kind==="demand negation")frame.demands[0].explicit_negations=["training-a"];
    const result=await read(state(),frame,text);
    if(kind==="valid")assert(result?.state_path==="installation.items[entity_id=training-a]",JSON.stringify(result));
    else assert(result?.reason==="read_only_current_state_aggregate_query_unresolved" && !result.state_path,
      kind+": "+JSON.stringify(result));
  }
  const named=reading();named.referents=[];
  const namedText="For this Training kit, how many checks are still pending?";
  named.demands=[{question:namedText,source_quote:namedText,subject_refs:["display-b"],source_type:"general",
    requested_facts:["pending_checks"],constraints:{},customer_correction:false,explicit_negations:[],
    ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}];
  const result=await read(state(),named,namedText);
  assert(!result?.state_path,"contradictory supplied demand fell through literal singleton selection");
});

Deno.test("Task3C pending global scope ignores incidental references and new selectors require valid revisions", async () => {
  for (const ref of ["training-a","missing-item"]) {
    const result=await read(state(),reading(ref),"How many checks are still pending?");
    assert(result?.state_path==="installation.pending_checks" && result.reply?.includes("3"),JSON.stringify(result));
  }
  for (const revision of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
    const result=await read(state(),reading(),"How many checks are still pending for this item?",{revision});
    assert(!result?.state_path && result?.authority==="INSUFFICIENT_INFORMATION",JSON.stringify(result));
  }
});

Deno.test("Task3C pending selector rejects foreign owner metadata without writes or provenance changes", async () => {
  for (const options of [{company_id:"other-company"},{conversation_id:"other-ticket"}]) {
    let error="";try { await read(state(),reading(),"How many checks are still pending for this item?",options); }
    catch(caught){error=String(caught);}
    assert(error.includes("commerce_state_scope_mismatch"),"foreign snapshot read: "+error);
  }
});
