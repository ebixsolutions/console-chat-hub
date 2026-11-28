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

Deno.test("Task3C a quoted unknown subject cannot inherit another item's pending checks", async () => {
  const frame=reading(),text="For this portable gantry, how many checks are still pending?";
  frame.demands=[{question:text,source_quote:text,subject_refs:["portable gantry"],source_type:"general",
    requested_facts:["pending_checks"],constraints:{},customer_correction:false,explicit_negations:[],
    ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}];
  const result=await read(state(),frame,text);
  assert(result?.reason==="read_only_current_state_aggregate_query_unresolved" && !result.state_path,
    "an exact current quote became an unproved canonical alias: "+JSON.stringify(result));
});

Deno.test("Task3C pending selectors reject a competing known prior-turn canonical identity", async () => {
  const frame=reading();
  frame.referents.push({ref:"display-b",source:"prior_turn",confidence:0.99});
  const result=await read(state(),frame,"How many checks are still pending for this item?");
  assert(result?.reason==="read_only_current_state_aggregate_query_unresolved" && !result.state_path,
    "competing prior-turn identity was ignored: "+JSON.stringify(result));
});

Deno.test("Task3C literal pending reads cannot bypass supplied correction negation or write intent", async () => {
  for(const kind of ["correction","negation","additive","write operation","ambiguous"] as const){
    const frame=reading();frame.referents=[];
    if(kind==="correction")frame.customer_correction=true;
    if(kind==="negation")frame.explicit_negations=["training-a"];
    if(kind==="additive")frame.additive=true;
    if(kind==="write operation")frame.operation="REMOVE_ITEM";
    if(kind==="ambiguous")frame.ambiguity={is_ambiguous:true,reasons:["unresolved customer scope"],clarification_question:null};
    const result=await read(state(),frame,"For this Training kit, what checks are still pending confirmation?");
    assert(result?.reason==="read_only_current_state_aggregate_query_unresolved" && !result.state_path,
      kind+" was ignored: "+JSON.stringify(result));
  }
});

Deno.test("Task3C every pending read requires a positive safe integer canonical revision", async () => {
  for(const revision of [-1,1.5,Number.MAX_SAFE_INTEGER+1]){
    for(const text of ["For this Training kit, how many checks are still pending?","How many checks are still pending?"]){
      const result=await read(state(),null,text,{revision});
      assert(result?.authority==="INSUFFICIENT_INFORMATION" && !result.state_path,
        "invalid revision supplied authoritative checks: "+JSON.stringify({revision,result}));
    }
  }
});

Deno.test("Task3C weak semantic proposals cannot erase contradictory pending-read evidence", async () => {
  const text="For this Training kit, how many checks are still pending?";
  for(const kind of ["conflicting subject","fabricated quote"] as const){
    const frame=reading();frame.confidence=0.8;
    frame.demands=[{question:text,source_quote:kind==="fabricated quote"?"The visitor never said this.":text,
      subject_refs:[kind==="conflicting subject"?"display-b":"training-a"],source_type:"general",
      requested_facts:["pending_checks"],constraints:{},customer_correction:false,explicit_negations:[],
      ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}];
    const result=await read(state(),frame,text);
    assert(result?.authority==="INSUFFICIENT_INFORMATION" && !result.state_path,
      kind+": "+JSON.stringify(result));
  }
});

Deno.test("Task3C literal and deictic pending reads require an active customer-owned target", async () => {
  for(const kind of ["superseded","unknown status","unowned","missing source"] as const){
    const s=state();s.entities=s.entities.slice(0,1);
    if(kind==="superseded") (s.entities[0] as {status:string}).status="superseded";
    if(kind==="unknown status") (s.entities[0] as {status:string}).status="future-status";
    if(kind==="unowned")s.entities[0].provenance.source_type="system";
    if(kind==="missing source")s.entities[0].provenance.source_message_id=null;
    const texts=["For this Training kit, how many checks are still pending?","How many checks are still pending for this item?"];
    if(kind==="superseded"||kind==="unknown status")texts.push("How many Training kit checks are still pending?");
    for(const text of texts){
      const result=await read(s,null,text);
      assert(result?.authority==="INSUFFICIENT_INFORMATION" && !result.state_path,
        kind+": "+JSON.stringify(result));
    }
  }
});


// Agreed T48 successor: distinguish incidental referent ambiguity from
// material scope/domain/source/operation conflict. Original callbacks unchanged.
Deno.test("Task3C global pending aggregate ignores incidental entity ambiguity but not contradictory Reading", async () => {
  const text = "How many checks are still pending?";
  for (const kind of ["valid", "incidental-frame", "incidental-demand", "wrong-operation",
    "correction", "additive", "frame-negation", "fabricated-quote", "empty-quote",
    "demand-correction", "demand-negation", "frame-domain", "demand-domain"] as const) {
    const frame = reading();
    frame.demands = [{ question: text, source_quote: text, subject_refs: [],
      source_type: "general", requested_facts: ["pending_checks"], constraints: {},
      customer_correction: false, explicit_negations: [],
      ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
    if (kind === "incidental-frame" || kind === "incidental-demand") {
      const ambiguity = { is_ambiguous: true, reasons: ["several equipment referents"],
        clarification_question: "Which item?" };
      frame.confidence = 0.55;
      if (kind === "incidental-frame") frame.ambiguity = ambiguity;
      else frame.demands[0].ambiguity = ambiguity;
    }
    if (kind === "wrong-operation") frame.operation = "REMOVE_ITEM";
    if (kind === "correction") frame.customer_correction = true;
    if (kind === "additive") frame.additive = true;
    if (kind === "frame-negation") frame.explicit_negations = ["pending checks"];
    if (kind === "fabricated-quote") frame.demands[0].source_quote = "Unrelated model-only text.";
    if (kind === "empty-quote") frame.demands[0].source_quote = "";
    if (kind === "demand-correction") frame.demands[0].customer_correction = true;
    if (kind === "demand-negation") frame.demands[0].explicit_negations = ["pending checks"];
    if (kind === "frame-domain" || kind === "demand-domain") {
      const ambiguity = { is_ambiguous: true, reasons: ["multiple interpretations"],
        clarification_question: "Which meaning?" };
      if (kind === "frame-domain") frame.ambiguity = ambiguity;
      else frame.demands[0].ambiguity = ambiguity;
    }
    const positive = ["valid", "incidental-frame", "incidental-demand"].includes(kind);
    if (!positive) frame.confidence = 0.8;
    const result = await read(state(), frame, text);
    if (positive) {
      assert(result?.authority === "CONVERSATION_STATE" &&
        result.state_path === "installation.pending_checks" &&
        result.reply?.includes("3") && !/[?？]/u.test(result.reply), kind + ": " + JSON.stringify(result));
    } else {
      assert(result?.reason === "read_only_current_state_aggregate_query_unresolved" &&
        result.authority === "INSUFFICIENT_INFORMATION" && !result.state_path &&
        !/training-a|display-b|currently 3/.test(result.reply ?? ""), kind + ": " + JSON.stringify(result));
    }
  }
});

Deno.test("Task3C pending aggregate must clarify a demanded subject that cannot bind current state", async () => {
  for (const kind of ["unknown-literal", "unquoted-canonical", "ambiguous-named"] as const) {
    const s = state(), frame = reading();
    const text = kind === "unknown-literal" ? "How many portable gantry checks are still pending?" :
      kind === "ambiguous-named" ? "How many Training kit checks are still pending?" :
      "How many checks are still pending?";
    frame.demands = [{ question: text, source_quote: text,
      subject_refs: [kind === "unknown-literal" ? "portable gantry" : "training-a"],
      source_type: "general", requested_facts: ["pending_checks"], constraints: {},
      customer_correction: false, explicit_negations: [],
      ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
    if (kind === "ambiguous-named") {
      frame.ambiguity = { is_ambiguous: true, reasons: ["several equipment referents"],
        clarification_question: "Which item?" };
    }
    const result = await read(s, frame, text);
    assert(result?.authority === "INSUFFICIENT_INFORMATION" &&
      result.reason === "read_only_current_state_aggregate_query_unresolved" && !result.state_path,
      kind + ": " + JSON.stringify(result));
  }
});
