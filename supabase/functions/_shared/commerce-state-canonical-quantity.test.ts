import { createEmptyConversationCommerceState, type ConversationCommerceState } from "./commerce-state-contract.ts";
import { runCommerceStateRuntime, type CommerceStateDbClient } from "./commerce-state-runtime-base.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function reading(topic: string): CommerceSemanticFrame {
  return { version: "commerce-semantic-1.0.0", language: "en", operation: "ASK_FACT",
    intent: "read the current customer quantity", topic, entities: [], referents: [],
    requested_facts: ["current_quantity"], customer_correction: false, additive: false,
    explicit_negations: [], transaction_state: "none", payment_state: "none",
    booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: 0.95 };
}
function snapshot(category = "training-kit"): ConversationCommerceState {
  const state = createEmptyConversationCommerceState();
  state.entities.push({ entity_id: category + ":saved", category, quantity: 2, status: "researching",
    attributes: {}, constraints: {}, provenance: { source_type: "customer", source_message_id: "source-1" } });
  return state;
}
async function query(state: ConversationCommerceState, frame: CommerceSemanticFrame | null,
  text = "How many do I currently have?", options: {revision?:number;company_id?:string;conversation_id?:string} = {}) {
  const before = JSON.stringify(state); let writes = 0;
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
      company_id: options.company_id ?? "company-a", conversation_id: options.conversation_id ?? "ticket-a",
      revision: options.revision ?? 9, state }, error: null }) }) }) }),
    rpc: async () => { writes++; return { data: { result: "success", applied_revision: 10 }, error: null }; },
  };
  try { return await runCommerceStateRuntime(db, { company_id: "company-a", conversation_id: "ticket-a",
    source_message_id: "source-now", text, language: "en", semantic_frame: frame,
    history: [{ role: "visitor", content: "There used to be 99 items in a previous request." }] }); }
  finally {
  assert(writes === 0 && JSON.stringify(state) === before, "Quantity read wrote state or changed provenance");
  }
}
Deno.test("Task3C canonical quantity reads exact customer-owned categories across industries", async () => {
  for (const category of ["training-kit", "catering-box", "software-seats"]) {
    const state = snapshot(category);
    state.entities.push({ ...structuredClone(state.entities[0]), entity_id: "inactive-copy", status: "cancelled", quantity: 8 });
    const result = await query(state, reading(category));
    assert(result?.state_path === "entities.0.quantity" && result.reply?.includes("2"), JSON.stringify(result));
    assert(result.revision === 9 && result.persist_result === "read_only", JSON.stringify(result));
  }
});
Deno.test("Task3C row 27 current quantity uses its supplied reading without a product alias table", async () => {
  const state = snapshot("air_conditioner");
  state.entities.push({ ...structuredClone(state.entities[0]), category: "refrigerator", entity_id: "other", quantity: 1 });
  const frame = reading("air_conditioner");
  frame.referents = [{ ref: "一部598mm", source: "prior_turn", confidence: 0.94 }];
  const result = await query(state, frame, "我而家有幾多部冷氣？");
  assert(result?.state_path === "entities.0.quantity" && result.reply?.includes("2"), JSON.stringify(result));
  assert(typeof result.reply === "string" && !result.reply.includes("refrigerator"), JSON.stringify(result));
});
Deno.test("Task3C canonical quantity never supplies default or unconfirmed counts", async () => {
  for (const variant of ["system_default", "unconfirmed_zero"] as const) {
    const state = snapshot();
    state.entities.push({ ...structuredClone(state.entities[0]), entity_id: "other", category: "other", quantity: 7 });
    if (variant === "system_default") state.entities[0].attributes.quantity_basis = "system_default";
    else state.entities[0].quantity = 0;
    const result = await query(state, reading("training-kit"));
    assert(result?.state_path !== "entities.0.quantity", variant + ": " + JSON.stringify(result));
  }
  const zero = snapshot(); zero.entities[0].quantity = 0; zero.entities[0].attributes.quantity_basis = "customer_explicit";
  const result = await query(zero, reading("training-kit"));
  assert(result?.state_path === "entities.0.quantity", JSON.stringify(result));
});
Deno.test("Task3C canonical quantity refuses absent, weak, ambiguous and competing interpretations", async () => {
  const variants: Array<{ label: string; state: ConversationCommerceState; frame: CommerceSemanticFrame | null }> = [];
  variants.push({ label: "no reading", state: snapshot(), frame: null });
  for (const kind of ["weak", "ambiguous", "mixed facts", "wrong topic", "conflicting reference"] as const) {
    const frame = reading("training-kit");
    if (kind === "weak") frame.confidence = 0.7;
    if (kind === "ambiguous") frame.ambiguity.is_ambiguous = true;
    if (kind === "mixed facts") frame.requested_facts.push("price");
    if (kind === "wrong topic") frame.topic = "another-category";
    if (kind === "conflicting reference") frame.referents = [{ ref: "missing-item", source: "persistent_state", confidence: 0.99 }];
    variants.push({ label: kind, state: snapshot(), frame });
  }
  const duplicate = snapshot(); duplicate.entities.push({ ...structuredClone(duplicate.entities[0]), entity_id: "second" });
  variants.push({ label: "duplicate category", state: duplicate, frame: reading("training-kit") });
  for (const variant of variants) {
    variant.state.entities.push({ ...structuredClone(variant.state.entities[0]), entity_id: "other", category: "other", quantity: 7 });
    const result = await query(variant.state, variant.frame);
    assert(!result?.state_path, variant.label + ": " + JSON.stringify(result));
  }
});
Deno.test("Task3C canonical quantity excludes inactive, unsourced and non-customer records", async () => {
  for (const kind of ["cancelled", "deferred", "superseded", "system", "missing source"] as const) {
    const state = snapshot();
    if (kind === "system") state.entities[0].provenance.source_type = "system";
    else if (kind === "missing source") state.entities[0].provenance.source_message_id = null;
    // Explicit malformed-storage probe; do not extend the canonical status enum.
    else (state.entities[0] as {status:string}).status = kind;
    const result = await query(state, reading("training-kit"));
    assert(!result?.state_path, kind + ": " + JSON.stringify(result));
  }
});
Deno.test("Task3C canonical quantity rejects a source-named competing customer subject", async () => {
  const state = snapshot();
  state.entities.push({ ...structuredClone(state.entities[0]), entity_id: "second", category: "display-rental",
    attributes: { product_name: "Portable stand" }, quantity: 7 });
  const result = await query(state, reading("training-kit"), "How many Portable stand do I currently have?");
  assert(result?.state_path !== "entities.0.quantity", JSON.stringify(result));
});

Deno.test("Task3C canonical quantity preserves the existing sourced singleton read without a reading", async () => {
  const result = await query(snapshot(), null);
  assert(result?.state_path === "entities.0.quantity" && result.reply?.includes("2"), JSON.stringify(result));
});

Deno.test("Task3C optional quantity demands must quote the source and agree with the selected subject", async () => {
  const state = snapshot();
  state.entities.push({ ...structuredClone(state.entities[0]), entity_id: "rental:saved", category: "display-rental", quantity: 7 });
  for (const variant of ["different canonical subject", "fabricated quote", "unquoted subject"] as const) {
    const frame = reading("training-kit");
    frame.demands = [{ question: "How many do I currently have?", source_quote: "How many do I currently have?",
      subject_refs: [], source_type: "general", requested_facts: ["current_quantity"], constraints: {},
      customer_correction: false, explicit_negations: [],
      ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
    if (variant === "different canonical subject") frame.demands[0].subject_refs = ["rental:saved"];
    if (variant === "fabricated quote") frame.demands[0].source_quote = "I requested a different amount.";
    if (variant === "unquoted subject") frame.demands[0].subject_refs = ["unmentioned topic"];
    const result = await query(state, frame);
    assert(!result?.state_path, variant + ": " + JSON.stringify(result));
  }
});

Deno.test("Task3C rejected qualified quantity reading cannot recover through singleton inference", async () => {
  for (const category of ["training-kit", "air_conditioner"]) {
    for (const kind of ["fabricated quote", "unquoted subject", "wrong topic", "proposed quantity"] as const) {
      const frame = reading(category), s = snapshot(category);
      frame.demands = [{question:"How many do I currently have?",source_quote:"How many do I currently have?",
        subject_refs:[],source_type:"general",requested_facts:["current_quantity"],constraints:{},
        customer_correction:false,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}];
      if (kind === "fabricated quote") frame.demands[0].source_quote = "Unrelated model-only text.";
      if (kind === "unquoted subject") frame.demands[0].subject_refs = ["unmentioned item"];
      if (kind === "wrong topic") frame.topic = "different-category";
      if (kind === "proposed quantity") frame.entities = [{entity_ref:s.entities[0].entity_id,name:category,
        kind:"service",category_hint:category,sku:null,model:null,quantity:1,unit:null,attributes:{},constraints:{},
        capabilities:{requires_delivery:false,supports_pickup:false,requires_installation:false,requires_booking:false,
          requires_quote:false,requires_site_check:false,digital_fulfilment:false,recurring_billing:false,rental_return:false,
          customization:false},confidence:.99}];
      const result = await query(s,frame);
      assert(result?.state_path === null && result.authority === "INSUFFICIENT_INFORMATION",kind+": "+JSON.stringify(result));
    }
  }
});

Deno.test("Task3C new canonical quantity selector requires a positive integer snapshot revision", async () => {
  for (const revision of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
    const result = await query(snapshot(),reading("training-kit"),undefined,{revision});
    assert(result?.state_path === null && result.authority === "INSUFFICIENT_INFORMATION",JSON.stringify(result));
  }
  const sparse=reading("training-kit");sparse.topic=null;
  const result = await query(snapshot(),sparse);
  assert(result?.state_path === "entities.0.quantity" && result.reply?.includes("2"),"sparse compatible read changed");
});

Deno.test("Task3C canonical quantity still rejects a foreign tenant or ticket before reading a value", async () => {
  for (const options of [{company_id:"other-company"},{conversation_id:"other-ticket"}]) {
    let error="";try { await query(snapshot(),reading("training-kit"),undefined,options); }
    catch (caught) { error=String(caught); }
    assert(error.includes("commerce_state_scope_mismatch"),"foreign snapshot read: "+error);
  }
});

Deno.test("Task3C no-reading singleton requires a current sourced customer quantity", async () => {
  for(const kind of ["cancelled","deferred","superseded","system","missing source","blank source","system default","unconfirmed zero"] as const){
    const s=snapshot(),entity=s.entities[0];
    if(kind==="system")entity.provenance.source_type="system";
    else if(kind==="missing source")entity.provenance.source_message_id=null;
    else if(kind==="blank source")entity.provenance.source_message_id=" ";
    else if(kind==="system default")entity.attributes.quantity_basis="system_default";
    else if(kind==="unconfirmed zero")entity.quantity=0;
    else (entity as {status:string}).status=kind; // Includes one explicitly malformed status.
    const result=await query(s,null);
    assert(!result?.state_path,kind+": "+JSON.stringify(result));
  }
});

Deno.test("Task3C no-reading compatibility retains explicit zero and a sole valid customer record", async () => {
  const zero=snapshot();zero.entities[0].quantity=0;zero.entities[0].attributes.quantity_basis="customer_explicit";
  const none=await query(zero,null);assert(none?.state_path==="entities.0.quantity"&&none.reply?.includes("0"),JSON.stringify(none));
  const s=snapshot();s.entities.push({...structuredClone(s.entities[0]),entity_id:"system-container",quantity:99,
    provenance:{source_type:"system",source_message_id:"not-customer"}});
  const result=await query(s,null);
  assert(result?.state_path==="entities.0.quantity"&&result.reply?.includes("2")&&!result.reply?.includes("99"),JSON.stringify(result));
});
