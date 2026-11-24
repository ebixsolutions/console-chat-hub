/**
 * Additive generic coverage for the original named journey failures.
 * Native runtime/B2 and deterministic persistence harness only. These callbacks
 * do not retire originals, grant a CI exemption, or establish Hosted/model
 * quality. The companion coverage ledger records remaining equivalence gaps.
 */
import { createEmptyConversationCommerceState, type ConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { runCommerceStateRuntime, type CommerceRuntimeInput, type CommerceRuntimeOutcome, type CommerceStateDbClient } from "../../supabase/functions/_shared/commerce-state-runtime.ts";
import { normalizeCommerceSemanticFrame, type CommerceSemanticFrame } from "../../supabase/functions/_shared/commerce-semantic-frame.ts";
import { type SourceBoundContextualGoal, type SourceBoundScopeFact, type ScopedCustomerValue } from "../../supabase/functions/_shared/contextual-customer-update.ts";
import { evaluateB2BeforeCommit, executeB2PersistenceGate } from "../../supabase/functions/_shared/pre-send-conversion-supervisor.ts";
import { buildCanonicalConversationMemory, refreshConversationLongMemory, verifyCommittedScopedCorrectionMemory, type CanonicalConversationMemory } from "../../supabase/functions/_shared/conversation-long-memory.ts";
import { classifyHandoffIntent } from "../../supabase/functions/_shared/handoff-intent.ts";
import { classifyNaturalCustomerIntent, requiresCurrentMerchantEvidence, arbitrateAnaphoricProductFollowUp } from "../../supabase/functions/_shared/natural-customer-response.ts";
import { resolveCanonicalCommerceResolution } from "../../supabase/functions/_shared/conversation-resolution-contract.ts";
import { deriveTypedCustomerCalculation, isHistoricalOrConditionalCustomerCalculationRequest } from "../../supabase/functions/_shared/conversation-service-runtime.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const owner = { company_id: "generic-journey-company", conversation_id: "generic-journey-ticket" };
const capabilities = { requires_delivery: false, supports_pickup: false, requires_installation: false,
  requires_booking: false, requires_quote: false, requires_site_check: false,
  digital_fulfilment: false, recurring_billing: false, rental_return: false, customization: false };
function reading(): CommerceSemanticFrame {
  return { version: "commerce-semantic-1.0.0", language: "en", operation: "UPDATE_ITEM",
    intent: "customer_guidance", topic: "Training sessions", entities: [], referents: [], customer_facts: [],
    requested_facts: [], customer_correction: false, additive: false, explicit_negations: [],
    transaction_state: "none", payment_state: "none", booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: .99 };
}
function normalized(frame: CommerceSemanticFrame): CommerceSemanticFrame {
  const actual = normalizeCommerceSemanticFrame(frame); assert(actual, "invalid new generic Reading fixture"); return actual;
}
function scope(source = "scope-source", subject = "Training sessions", count = 2, correction = false): CommerceRuntimeInput {
  const text = `${subject} for ${count} teams and 1 lobby. Please offer general planning advice.`;
  const frame = reading(); frame.topic = subject; frame.customer_correction = correction;
  frame.customer_facts = [{ key: "contextual_scope_counts", value: [
    { scope: "teams", count, source_text: `${count} teams`, subject_label: subject },
    { scope: "lobby", count: 1, source_text: "1 lobby", subject_label: subject },
  ] }];
  frame.demands = [{ question: text, source_quote: text, subject_refs: [subject], source_type: "general",
    requested_facts: [], constraints: {}, customer_correction: correction, explicit_negations: [],
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  return { ...owner, source_message_id: source, text, language: "en", semantic_frame: normalized(frame) };
}
function allocate(goal: SourceBoundContextualGoal, source = "allocation-source", unit = "slots", ref = goal.goal_id): CommerceRuntimeInput {
  const frame = reading(); frame.intent = "scoped allocation"; frame.topic = goal.subject_label;
  frame.entities = [{ entity_ref: ref, name: goal.subject_label, kind: "service", category_hint: null,
    model: null, sku: null, quantity: null, unit, attributes: { scoped_customer_updates: [
      { scope: "lobby", source_text: `lobby 1 ${unit}`, unit, value: 1, attribute: "quantity", action: "set" },
      { scope: "teams", source_text: `teams 1 ${unit} each`, unit, value: 1, per_scope_quantity: 1,
        scope_count: null, attribute: "quantity", action: "set" },
    ] }, constraints: {}, capabilities, confidence: .99 }];
  frame.referents = [{ ref, source: "persistent_state", confidence: .99 }];
  return { ...owner, source_message_id: source, text: `lobby 1 ${unit}, teams 1 ${unit} each`, language: "en",
    semantic_frame: normalized(frame) };
}
function context(source: string, key: string, amount: number, unit: string): CommerceRuntimeInput {
  const frame = reading(); frame.intent = "customer_context_update";
  frame.customer_facts = [{ key, value: { amount, unit } }];
  return { ...owner, source_message_id: source, text: `${key.replaceAll("_", " ")} ${amount} ${unit}.`,
    language: "en", semantic_frame: normalized(frame) };
}
function storage() {
  const initial = createEmptyConversationCommerceState();
  // The conversation already has a known UI locale. This isolates denied
  // business mutations from the legitimate first-write locale bookkeeping.
  initial.language = "en";
  const live = { state: initial, revision: 1, writes: 0, source: "known-locale-source",
    history: [] as { id: string; role: string; content: string }[], seen: new Set<string>(),
    reject: false, lastInput: null as CommerceRuntimeInput | null };
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: live.revision ? { ...owner, source_message_id: live.source, revision: live.revision,
        state: structuredClone(live.state) } : null, error: null,
    }) }) }) }),
    rpc: async (_name, args) => {
      live.writes++;
      assert(args.p_company_id === owner.company_id && args.p_conversation_id === owner.conversation_id,
        "wrong owner reached the writer");
      if (live.reject) return { data: null, error: { message: "synthetic unavailable persistence" } };
      if (args.p_expected_revision !== live.revision) return { data: { result: "revision_conflict" }, error: null };
      const id = String(args.p_source_message_id);
      if (live.seen.has(id)) return { data: { result: "source_message_already_applied", applied_revision: live.revision }, error: null };
      live.state = structuredClone(args.p_state as ConversationCommerceState); live.revision++; live.source = id;
      live.seen.add(id); return { data: { result: "success", applied_revision: live.revision }, error: null };
    },
  };
  const ask = async (input: CommerceRuntimeInput) => {
    const out = await runCommerceStateRuntime(db, { ...input, history: live.history.slice().reverse() });
    live.history.push({ id: input.source_message_id, role: "visitor", content: input.text });
    live.lastInput = input; return out;
  };
  return { db, live, ask };
}
function goal(state: ConversationCommerceState): SourceBoundContextualGoal {
  const result = state.customer_constraints.contextual_goal as SourceBoundContextualGoal;
  assert(result?.goal_id, "canonical goal missing"); return result;
}
function noTransaction(state: ConversationCommerceState): void {
  assert(state.conversion.order_status === "none" && state.conversion.payment_status === "none" &&
    state.conversion.quotation_status === "none" && state.quotes.length === 0, "customer requirements promoted a transaction");
}
function unusedJourneyMemory(s: ReturnType<typeof storage>) {
  return buildCanonicalConversationMemory({ ...owner, source_message_id: s.live.source,
    // Same actual generate-reply caller argument: current semantic customer
    // facts enter Memory explicitly; they are never re-parsed from old text.
    customer_fact_delta: (s.live.lastInput?.semantic_frame?.customer_facts ?? []).map(fact => ({
      ...fact, authority: "customer" as const, source_message_id: s.live.lastInput!.source_message_id,
    })),
    commerce_state_revision: s.live.revision, commerce_state: s.live.state,
    newest_first: s.live.history.slice().reverse(), visitor_turn_count: s.live.history.length,
    source_created_at: "2026-11-24T00:00:00Z", next_memory_revision: s.live.history.length });
}
function b2(s: ReturnType<typeof storage>, input: CommerceRuntimeInput, out: CommerceRuntimeOutcome) {
  return { proposed_response: out.reply ?? "", persistence_kind: "ai_reply" as const,
    snapshot: { ...owner, source_message_id: input.source_message_id, source_message_content: input.text,
      commerce_state_source_message_id: input.source_message_id, commerce_state_revision: s.live.revision, state: s.live.state },
    metadata: { response_route: out.route, commerce_reason: out.reason, commerce_authority: out.authority,
      commerce_state_revision: out.revision, commerce_state_persist_result: out.persist_result,
      commerce_state_persistence_classification: "COMMITTED", contextual_decision: out.contextual_decision },
    trusted_journey_progress: out.trusted_journey_progress };
}


import { readVerifiedScopedQuantityCorrection, type B2TrustedScopedJourneyProgress, type ScopedQuantityCorrectionCommit } from "../../supabase/functions/_shared/b2-journey-progress-contract.ts";
import { sameCanonicalJson } from "../../supabase/functions/_shared/canonical-json.ts";

function memoryArgs(s: ReturnType<typeof storage>, receipt: B2TrustedScopedJourneyProgress | null = null) {
  return {...owner,source_message_id:s.live.lastInput!.source_message_id,
    commerce_state_revision:s.live.revision,commerce_state:s.live.state,
    customer_fact_delta:(s.live.lastInput?.semantic_frame?.customer_facts??[]).map(fact=>({...fact,
      authority:"customer" as const,source_message_id:s.live.lastInput!.source_message_id})),
    committed_scoped_correction:receipt,newest_first:s.live.history.slice().reverse(),
    visitor_turn_count:s.live.history.length,source_created_at:"2026-11-24T00:00:00Z"};
}
function proof(out: CommerceRuntimeOutcome): B2TrustedScopedJourneyProgress {
  assert(out.trusted_journey_progress?.update_kind==="contextual_scoped_update" &&
    out.trusted_journey_progress.scoped_correction,"actual runtime correction receipt absent");
  return out.trusted_journey_progress;
}
function parity(s: ReturnType<typeof storage>, receipt: B2TrustedScopedJourneyProgress, m: CanonicalConversationMemory | null) {
  return {memory:m,receipt,commerce:{...owner,source_message_id:s.live.source,revision:s.live.revision,state:s.live.state}};
}
async function fixture(grouped=false) {
  const s=storage();let previous:CanonicalConversationMemory|undefined;
  const ask=async(input:CommerceRuntimeInput)=>{
    const out=await s.ask(input);
    previous=buildCanonicalConversationMemory({...memoryArgs(s),previous,next_memory_revision:s.live.history.length});
    return out;
  };
  await ask(scope("training-scopes"));const originalGoal=structuredClone(goal(s.live.state));
  await ask(allocate(originalGoal,"training-allocation"));
  const target=s.live.state.entities[0];
  await ask(scope("catering-scopes","Festival catering",4));
  await ask(allocate(goal(s.live.state),"catering-allocation","portions"));
  const sibling=structuredClone(s.live.state.entities.find(entity=>entity.entity_id!==target.entity_id)!);
  const input=allocate(originalGoal,"quantity-correction","slots",target.entity_id);
  const quote=grouped?"teams from 1 slots each to 2 slots each":"lobby from 1 slots to 2 slots";
  input.text="Correct Training sessions: "+quote;
  input.semantic_frame!.customer_correction=true;input.semantic_frame!.intent="customer_correction";
  input.semantic_frame!.entities[0].attributes.scoped_customer_updates=[{
    scope:grouped?"teams":"lobby",attribute:"quantity",action:"set",previous_value:1,value:2,unit:"slots",source_text:quote,
  }];
  return {s,input,previous:previous!,targetId:target.entity_id,sibling,oldRows:structuredClone(target.attributes.scoped_customer_updates)};
}
async function corrected(grouped=false) {
  const f=await fixture(grouped), before=structuredClone(f.s.live.state), previousRevision=f.s.live.revision;
  const out=await f.s.ask(f.input);assert(out?.route==="contextual_scoped_update"&&out.persist_result==="success",JSON.stringify(out));
  const receipt=proof(out), ledger=receipt.scoped_correction!;
  assert(ledger.previous_revision===previousRevision&&ledger.committed_revision===previousRevision+1&&
    sameCanonicalJson(ledger.previous_updates,f.oldRows),"receipt did not come from actual prior rows/revision");
  const m=buildCanonicalConversationMemory({...memoryArgs(f.s,receipt),previous:f.previous,next_memory_revision:5});
  return {...f,before,out,receipt,ledger,m};
}
function evaluation(f: Awaited<ReturnType<typeof corrected>>, out=f.out) {
  const e=b2(f.s,f.input,out);
  e.metadata.commerce_state_persistence_classification=out.persist_result==="success"?"COMMITTED":"NO_SEMANTIC_CHANGE";
  return e;
}

async function memoryStore(previous: CanonicalConversationMemory) {
  const hash=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(value))))).map(value=>value.toString(16).padStart(2,"0")).join("");
  const initialHash=await hash(previous);
  const live={row:{...owner,revision:previous.memory_revision,source_message_id:previous.source_message_id,
    commerce_state_revision:previous.commerce_state_revision,memory:structuredClone(previous),markdown_projection:"prior",memory_hash:initialHash},
    event:{...owner,source_message_id:previous.source_message_id,applied_revision:previous.memory_revision,
      commerce_state_revision:previous.commerce_state_revision,memory_hash:initialHash},
    writes:0,reads:0,mode:"normal",conflicted:false};
  const client={from:(table:string)=>{
    const filters:Record<string,unknown>={};
    const query={select:(_columns:string)=>query,eq:(key:string,value:unknown)=>{filters[key]=value;return query;},
      maybeSingle:async()=>{live.reads++;const row=table==="conversation_memory_state_event"?live.event:live.row;
        return {data:Object.entries(filters).every(([key,value])=>(row as Record<string,unknown>)[key]===value)?structuredClone(row):null,error:null};}};
    return query;
  },rpc:async(fn:string,args:Record<string,unknown>)=>{
    live.writes++;assert(fn==="c3_commit_conversation_memory_tx"&&args.p_company_id===owner.company_id&&
      args.p_conversation_id===owner.conversation_id,"unexpected Memory writer scope");
    if(live.mode==="transport")return {data:null,error:{message:"synthetic memory transport"}};
    if(live.mode.startsWith("retry-")&&!live.conflicted){live.conflicted=true;live.row.revision++;
      live.row.memory.memory_revision++;return {data:{result:"revision_conflict"},error:null};}
    if(live.mode==="success-without-row"||live.mode==="retry-success-without-row")
      return {data:{result:"success",current_revision:live.row.revision+1},error:null};
    if(args.p_expected_memory_revision!==live.row.revision)return {data:{result:"revision_conflict"},error:null};
    const m=structuredClone(args.p_memory as CanonicalConversationMemory),digest=await hash(m),revision=live.row.revision+1;
    live.row={...owner,revision,source_message_id:String(args.p_source_message_id),
      commerce_state_revision:Number(args.p_expected_commerce_revision),memory:m,
      markdown_projection:String(args.p_markdown_projection),memory_hash:digest};
    live.event={...owner,source_message_id:live.row.source_message_id,applied_revision:revision,
      commerce_state_revision:live.row.commerce_state_revision,memory_hash:digest};
    if(live.mode==="wrong-row-tenant")live.row.company_id="foreign-company";
    if(live.mode==="wrong-event-source")live.event.source_message_id="foreign-source";
    if(live.mode==="wrong-revision")live.row.commerce_state_revision!--;
    if(live.mode==="wrong-hash")live.event.memory_hash="mismatch";
    if(live.mode==="drop-current")live.row.memory.current_customer_facts=[];
    if(live.mode==="drop-history")live.row.memory.cancelled_or_superseded=[];
    return {data:{result:"success",current_revision:revision},error:null};
  }};
  return {client,live};
}
function b2Client(f: Awaited<ReturnType<typeof corrected>>, drift=false) {
  let states=0;
  return {from:(table:string)=>{
    const query={select:(_columns:string)=>query,eq:(_key:string,_value:unknown)=>query,maybeSingle:async()=>{
      if(table==="conversations")return {data:{id:owner.conversation_id,company_id:owner.company_id},error:null};
      if(table==="messages")return {data:{id:f.input.source_message_id,conversation_id:owner.conversation_id,
        role:"visitor",content:f.input.text},error:null};
      states++;return {data:{...owner,revision:f.s.live.revision+(drift&&states>1?1:0),
        source_message_id:f.s.live.source,state:structuredClone(f.s.live.state)},error:null};
    }};return query;
  }};
}

for(const grouped of [false,true]) Deno.test(`P1 correction full chain ${grouped?"group":"single-scope"}: committed old/new Memory reaches bounded B2 once`,async()=>{
  const f=await corrected(grouped),entity=f.s.live.state.entities.find(value=>value.entity_id===f.targetId)!;
  assert(entity.quantity===(grouped?5:4)&&JSON.stringify(f.s.live.state.entities.find(value=>value.entity_id===f.sibling.entity_id))===JSON.stringify(f.sibling),
    "correction changed the sibling or wrong aggregate");
  const current=entity.attributes.scoped_customer_updates as ScopedCustomerValue[];
  const untouched=(f.oldRows as ScopedCustomerValue[]).filter(row=>grouped?row.scope==="lobby":row.group_scope==="teams");
  for(const row of untouched)assert(sameCanonicalJson(current.find(value=>value.scope===row.scope),row),"unrelated scope provenance changed");
  assert(verifyCommittedScopedCorrectionMemory(parity(f.s,f.receipt,f.m)),"built current/superseded Memory parity failed");
  const db=await memoryStore(f.previous),persisted=await refreshConversationLongMemory(db.client,memoryArgs(f.s,f.receipt));
  assert(persisted.ok&&db.live.writes===1&&db.live.reads>=3&&
    sameCanonicalJson(persisted.memory,db.live.row.memory)&&verifyCommittedScopedCorrectionMemory(parity(f.s,f.receipt,persisted.memory)),
    "actual Memory readback was not required: "+JSON.stringify(persisted));
  const e=evaluation(f),decision=evaluateB2BeforeCommit(e);
  assert(decision.decision==="allow"&&decision.code==="B2_ALLOW_JOURNEY_PROGRESS_AFTER_ACCEPTED_UPDATE",JSON.stringify(decision));
  let commits=0;const sent=await executeB2PersistenceGate({...e,client:b2Client(f),...owner,
    source_message_id:f.input.source_message_id,expected_commerce_state_revision:f.s.live.revision,
    commit:async()=>{commits++;return "native-reply";}});
  assert(sent.committed&&commits===1,"real B2 persistence sequence did not authorize exactly one callback");
  noTransaction(f.s.live.state);
});

Deno.test("P1 correction exact-source replay: original ledger and durable Memory remain idempotent",async()=>{
  const f=await corrected(),db=await memoryStore(f.previous);
  const stored=await refreshConversationLongMemory(db.client,memoryArgs(f.s,f.receipt));assert(stored.ok,"initial memory setup failed");
  const state=JSON.stringify(f.s.live.state),revision=f.s.live.revision,writes=f.s.live.writes;
  const out=await f.s.ask(f.input);assert(out?.route==="contextual_scoped_update"&&out.persist_result==="no_semantic_change"&&
    f.s.live.writes===writes&&f.s.live.revision===revision&&JSON.stringify(f.s.live.state)===state,"source replay mutated canonical state");
  const receipt=proof(out);assert(sameCanonicalJson(receipt.scoped_correction,f.ledger),"replay minted a new correction ledger");
  const repeated=await refreshConversationLongMemory(db.client,memoryArgs(f.s,receipt));
  assert(repeated.ok&&repeated.idempotent&&db.live.writes===1&&
    verifyCommittedScopedCorrectionMemory(parity(f.s,receipt,repeated.memory)),"Memory replay lost durable parity");
  const e=evaluation(f,out),decision=evaluateB2BeforeCommit(e);assert(decision.decision==="allow",JSON.stringify(decision));
  let commits=0;
  const recovered=await executeB2PersistenceGate({...e,client:b2Client(f),...owner,
    source_message_id:f.input.source_message_id,expected_commerce_state_revision:f.s.live.revision,
    commit:async()=>{commits++;return "reply-recovered-after-committed-memory";}});
  assert(recovered.committed&&commits===1,"exact replay could not recover one final reply through the actual B2 gate");
});

for(const mode of ["old-value","forged-quote","new-value","unit","unknown-scope","duplicate-change","extra-quantity",
  "missing-reading","wrong-reference","extra-reference","transaction","question","negation","blank-old-source",
  "blank-old-quote","future-old-revision","duplicate-old-row","mixed-group-goal","partial-old-group"] as const)
  Deno.test(`P1 correction source negative ${mode}: no unverified old value reaches the writer`,async()=>{
    const f=await fixture(mode==="mixed-group-goal"||mode==="partial-old-group"),frame=f.input.semantic_frame!;
    const row=(frame.entities[0].attributes.scoped_customer_updates as Record<string,unknown>[])[0];
    const entity=f.s.live.state.entities.find(value=>value.entity_id===f.targetId)!;
    const old=entity.attributes.scoped_customer_updates as ScopedCustomerValue[];
    if(mode==="old-value"){row.previous_value=9;row.source_text="lobby from 9 slots to 2 slots";f.input.text="Correct Training sessions: "+row.source_text;}
    if(mode==="forged-quote")row.source_text="lobby from 1 slots to 9 slots";
    if(mode==="new-value")row.value=8;
    if(mode==="unit"){row.unit="licences";frame.entities[0].unit="licences";}
    if(mode==="unknown-scope")row.scope="unmentioned-area";
    if(mode==="duplicate-change")(frame.entities[0].attributes.scoped_customer_updates as unknown[]).push(structuredClone(row));
    if(mode==="extra-quantity")f.input.text+=" and another 7 slots";
    if(mode==="missing-reading")f.input.semantic_frame=null;
    if(mode==="wrong-reference"){frame.entities[0].entity_ref=f.sibling.entity_id;frame.referents[0].ref=f.sibling.entity_id;}
    if(mode==="extra-reference")frame.referents.push({ref:f.sibling.entity_id,source:"persistent_state",confidence:.99});
    if(mode==="transaction")frame.transaction_state="order_confirmed";
    if(mode==="question")f.input.text+="?";
    if(mode==="negation")f.input.text="Please do not "+f.input.text;
    if(mode==="blank-old-source")old[0].source_message_id=" ";
    if(mode==="blank-old-quote")old[0].source_text=" ";
    if(mode==="future-old-revision")old[0].source_revision=f.s.live.revision+1;
    if(mode==="duplicate-old-row")old.push(structuredClone(old[0]));
    if(mode==="mixed-group-goal")old[1].group_goal_id="foreign-goal";
    if(mode==="partial-old-group")old.splice(2,1);
    const before=JSON.stringify(f.s.live.state),revision=f.s.live.revision,writes=f.s.live.writes;
    const out=await f.s.ask(f.input);
    assert(out?.route!=="contextual_scoped_update"&&!out?.trusted_journey_progress&&f.s.live.writes===writes&&
      f.s.live.revision===revision&&JSON.stringify(f.s.live.state)===before,mode+":"+JSON.stringify(out));
  });

for(const mode of ["transport","revision-conflict","wrong-old-value-after-retry"] as const)
  Deno.test(`P1 correction CAS negative ${mode}: uncommitted proposal cannot produce a receipt`,async()=>{
    const f=await fixture();let failed=false;
    if(mode==="transport")f.s.live.reject=true;
    else f.s.db.rpc=async()=>{
      if(mode==="wrong-old-value-after-retry"&&!failed){failed=true;
        const entity=f.s.live.state.entities.find(value=>value.entity_id===f.targetId)!;
        (entity.attributes.scoped_customer_updates as ScopedCustomerValue[])[0].value=3;entity.quantity=5;f.s.live.revision++;}
      return {data:{result:"revision_conflict"},error:null};
    };
    const writes=f.s.live.writes,out=await f.s.ask(f.input);
    assert(!out?.trusted_journey_progress&&!f.s.live.state.entities.some(entity=>entity.attributes.scoped_quantity_correction)&&
      (mode!=="transport"||f.s.live.writes===writes+1),JSON.stringify(out));
    assert(out?.persist_result!=="success","failed CAS claimed a correction commit");
  });

for(const mode of ["missing-memory","missing-receipt","tenant","ticket","missing-ticket","source","revision",
  "old-value","current-value","old-row-source","missing-history","missing-current","duplicate-history","active-rows"] as const)
  Deno.test(`P1 correction Memory negative ${mode}: parity rejects corrupted persisted facts`,async()=>{
    const f=await corrected(),p=structuredClone(parity(f.s,f.receipt,f.m));
    if(mode==="missing-memory")p.memory=null;
    if(mode==="missing-receipt")p.receipt=null as unknown as B2TrustedScopedJourneyProgress;
    if(mode==="tenant")p.memory!.company_id="foreign-company";
    if(mode==="ticket")p.commerce.conversation_id="foreign-ticket";
    if(mode==="missing-ticket")p.commerce.conversation_id="";
    if(mode==="source")p.memory!.source_message_id="other-source";
    if(mode==="revision")p.memory!.commerce_state_revision!--;
    if(mode==="old-value")p.memory!.cancelled_or_superseded.find(fact=>fact.key.endsWith(":quantity"))!.value=9;
    if(mode==="current-value")p.memory!.current_customer_facts.find(fact=>fact.entity_id===f.targetId&&fact.key.endsWith(":quantity"))!.value=3;
    if(mode==="old-row-source")((p.memory!.cancelled_or_superseded.find(fact=>fact.key.endsWith(":scoped_customer_updates"))!.value) as ScopedCustomerValue[])[0].source_message_id="forged";
    if(mode==="missing-history")p.memory!.cancelled_or_superseded=[];
    if(mode==="missing-current")p.memory!.current_customer_facts=[];
    if(mode==="duplicate-history")p.memory!.cancelled_or_superseded.push(structuredClone(
      p.memory!.cancelled_or_superseded.find(fact=>fact.entity_id===f.targetId&&fact.key.endsWith(":quantity"))!));
    if(mode==="active-rows")p.memory!.active_entities.find(entity=>entity.entity_id===f.targetId)!.current_requirements.scoped_customer_updates=[];
    assert(!verifyCommittedScopedCorrectionMemory(p),"corrupt Memory accepted:"+mode);
  });

for(const mode of ["transport","success-without-row","retry-success-without-row","wrong-row-tenant","wrong-event-source",
  "wrong-revision","wrong-hash","drop-current","drop-history"] as const)
  Deno.test(`P1 correction Memory persistence negative ${mode}: success requires actual durable readback`,async()=>{
    const f=await corrected(),db=await memoryStore(f.previous);db.live.mode=mode;
    const out=await refreshConversationLongMemory(db.client,memoryArgs(f.s,f.receipt));
    assert(!out.ok,"candidate-only Memory promoted durable success:"+mode);
  });

for(const mode of ["missing-proof","missing-scoped-payload","stripped-metadata","tenant","ticket","source","revision",
  "entity","old-total","new-total","old-row","new-row","unit","quote","metadata-mismatch","current-rows",
  "changed-source","missing-accepted-scope","extra-accepted-scope","order","payment",
  "remove-ledger-and-strip-proof","corrupt-all-markers-and-strip-proof"] as const)
  Deno.test(`P1 correction B2 negative ${mode}: no corrupted correction can authorize a reply`,async()=>{
    const f=await corrected(),e=structuredClone(evaluation(f));
    const receipt=e.trusted_journey_progress as B2TrustedScopedJourneyProgress,ledger=receipt.scoped_correction!;
    if(mode==="missing-proof")e.trusted_journey_progress=undefined;
    if(mode==="missing-scoped-payload")delete receipt.scoped_correction;
    if(mode==="stripped-metadata"){e.trusted_journey_progress=undefined;e.metadata={} as typeof e.metadata;}
    if(mode==="tenant")ledger.company_id="foreign-company";
    if(mode==="ticket")ledger.conversation_id="foreign-ticket";
    if(mode==="source")receipt.source_message_id="foreign-source";
    if(mode==="revision")receipt.committed_revision--;
    if(mode==="entity")receipt.entity_id=f.sibling.entity_id;
    if(mode==="old-total")ledger.previous_quantity=9;
    if(mode==="new-total")ledger.current_quantity=9;
    if(mode==="old-row")ledger.previous_updates[0].value=9;
    if(mode==="new-row")receipt.committed_updates[0].value=9;
    if(mode==="unit")ledger.unit="licences";
    if(mode==="quote")ledger.changes[0].source_text="invented correction";
    if(mode==="metadata-mismatch")delete (e.metadata.contextual_decision as {scoped_correction?:unknown}).scoped_correction;
    if(mode==="current-rows")(e.snapshot.state.entities.find(value=>value.entity_id===f.targetId)!.attributes.scoped_customer_updates as ScopedCustomerValue[])[1].value=8;
    if(mode==="changed-source")e.snapshot.source_message_content+=" and another request";
    if(mode==="missing-accepted-scope")receipt.accepted_updates=[];
    if(mode==="extra-accepted-scope")receipt.accepted_updates.push(structuredClone(receipt.committed_updates[1]));
    if(mode==="order")e.proposed_response+=" Order confirmed.";
    if(mode==="payment")e.proposed_response+=" Payment received.";
    if(mode==="remove-ledger-and-strip-proof"||mode==="corrupt-all-markers-and-strip-proof"){
      const entity=e.snapshot.state.entities.find(value=>value.entity_id===f.targetId)!;
      if(mode==="remove-ledger-and-strip-proof")delete entity.attributes.scoped_quantity_correction;
      else {const claimed=entity.attributes.scoped_quantity_correction as unknown as ScopedQuantityCorrectionCommit;
        claimed.source_message_id="older-source";claimed.committed_revision=1;claimed.source_text="older unrelated text";}
      e.trusted_journey_progress=undefined;e.metadata={} as typeof e.metadata;
    }
    const result=evaluateB2BeforeCommit(e);assert(result.decision!=="allow",mode+":"+JSON.stringify(result));
  });

Deno.test("P1 correction B2 revalidation negative revision drift: final reply callback stays uncalled",async()=>{
  const f=await corrected(),e=evaluation(f);let commits=0;
  const result=await executeB2PersistenceGate({...e,client:b2Client(f,true),...owner,
    source_message_id:f.input.source_message_id,expected_commerce_state_revision:f.s.live.revision,
    commit:async()=>{commits++;return "must-not-commit";}});
  assert(!result.committed&&commits===0,"revision drift passed actual final B2 revalidation");
});

Deno.test("P1 correction historical-ledger compatibility: unrelated later source requires no new correction proof",async()=>{
  const f=await corrected(),e=structuredClone(evaluation(f));
  e.snapshot.source_message_id="later-unrelated-source";
  e.snapshot.source_message_content="Thank you for the explanation.";
  e.proposed_response="You're welcome.";e.trusted_journey_progress=undefined;e.metadata={} as typeof e.metadata;
  const out=evaluateB2BeforeCommit(e);assert(out.decision==="allow",JSON.stringify(out));
});

Deno.test("P1 correction source bound above 500 characters retains full durable Memory parity",async()=>{
  const s=storage();await s.ask(scope("long-scope-goal"));
  const first=buildCanonicalConversationMemory({...memoryArgs(s),next_memory_revision:1});
  const g=goal(s.live.state),names=["Cedar","Birch","Willow","Maple","Elm","Oak"].map(name=>
    `${name} community learning and discussion preparation support space`);
  const input=allocate(g,"long-initial-allocation");
  input.semantic_frame!.entities[0].attributes.scoped_customer_updates=names.map(name=>({scope:name,
    attribute:"quantity",action:"set",value:1,unit:"slots",source_text:`${name} 1 slots`}));
  input.text=names.map(name=>`${name} 1 slots`).join("; ");
  const allocated=await s.ask(input);assert(allocated?.route==="contextual_scoped_update","long setup failed");
  const previous=buildCanonicalConversationMemory({...memoryArgs(s),previous:first,next_memory_revision:2});
  const correction=allocate(g,"long-correction","slots",s.live.state.entities[0].entity_id);
  correction.semantic_frame!.customer_correction=true;
  correction.semantic_frame!.entities[0].attributes.scoped_customer_updates=names.map(name=>({scope:name,
    attribute:"quantity",action:"set",previous_value:1,value:2,unit:"slots",source_text:`${name} from 1 slots to 2 slots`}));
  correction.text="Correct Training sessions: "+names.map(name=>`${name} from 1 slots to 2 slots`).join("; ");
  assert(correction.text.length>500&&correction.text.length<=1200,"long-source fixture does not cross actual former bound");
  const out=await s.ask(correction);assert(out?.route==="contextual_scoped_update"&&out.persist_result==="success",JSON.stringify(out));
  const receipt=proof(out),db=await memoryStore(previous),persisted=await refreshConversationLongMemory(db.client,memoryArgs(s,receipt));
  assert(persisted.ok&&persisted.memory.latest_corrections.includes(correction.text)&&
    verifyCommittedScopedCorrectionMemory(parity(s,receipt,persisted.memory)),"long source lost exact persisted parity");
  const result=evaluateB2BeforeCommit(b2(s,correction,out));assert(result.decision==="allow",JSON.stringify(result));
});
