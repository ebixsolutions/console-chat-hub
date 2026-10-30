import {selectFactualEvidence, buildFactualCitationMetadata, canUseSingleDemandDirectAnswer, resolveSourceRecordedPartialRecovery} from "./factual-evidence-selection.ts";
import {validGroundingEvidence, buildGroundingEvidencePrompt, parseGroundingDemandResolutions, groundingEvidenceText} from "./grounding-evidence.ts";
import type {CurrentFactualRequest, CurrentFactualDemand} from "./current-factual-request.ts";
import type {KBDocumentCandidate} from "./kb-client.ts";
import {buildFactualKbPriceClaims} from "./factual-kb-price-proof.ts";
import {evaluateB2BeforeCommit} from "./pre-send-conversion-supervisor.ts";
import {createEmptyConversationCommerceState} from "./commerce-state-contract.ts";
import type {GroundingVerificationReceipt} from "./grounding-evidence.ts";
import {bindRagApiResponse, bindRagServiceDocument, ORIGINAL_RAG_ACTIVATION} from "./preview-kb-query-embedding.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {if (!value) throw new Error(message);}
function equal(a: unknown, b: unknown) {assert(JSON.stringify(a) === JSON.stringify(b), JSON.stringify({actual:a,expected:b}));}
const clear = {is_ambiguous:false,reasons:[],clarification_question:null};
function demand(id: number, question: string, source_type: CurrentFactualDemand["source_type"] = "policy", subjects: string[] = []): CurrentFactualDemand {
  return {id:"demand-"+id,question,source_quote:question,subjects,subject_source_message_ids:subjects.length?["customer-source"]:[],
    source_type,requested_facts:[source_type === "product" ? "price" : "requested details"],constraints:{},
    customer_correction:false,explicit_negations:[],ambiguity:{...clear,reasons:[]}};
}
function request(demands: CurrentFactualDemand[]): CurrentFactualRequest {
  const question=demands.map(item=>item.question).join("; ");
  return {version:"current-factual-request-1",source_message_id:"current-customer",original_question:question,
    interpretation_source:"semantic_demands",applicable:true,question,merchant_request:question,subject:null,
    subjects:demands.flatMap(item=>item.subjects),requested_facts:demands.flatMap(item=>item.requested_facts),query:question,answer_request:question,
    resolution:"explicit",subject_source_message_id:null,subject_source_message_ids:[],demands,kb_required:true,
    transaction_required:demands.some(item=>item.source_type==="transaction"),unresolved_demand_ids:[],missing_evidence:[],
    topic_changed:false,context_turns:[],needs_subject_clarification:false};
}
function document(id: string, content: string, source_type = "policy", title = "Delivery policy"): KBDocumentCandidate {
  const score=.9, chunk_id=id+"-chunk";
  return {document_id:id,title,source_type,document_score:score,
    chunks:[{document_id:id,doc_id:id,chunk_id,title,content,score,chunk_type:"full_content",source_type,status:"published"}],citations:[],
    llm_context:{selected_document_id:id,orientation_summary:null,full_content_evidence:[{document_id:id,chunk_id,content,score,source_type}]},
    meta:{document_score:score,highest_chunk_score:score,second_highest_chunk_score:0,returned_summary_count:0,returned_full_content_count:1,dropped_without_document_id:0,dropped_without_content:0},
    authority:{tenant_id:"34",publication_state:"published",currentness:"current",entity_ids:[],regions:[],language:null,version:null,version_rank:null,updated_at:null,source_priority:null,claims:[]}};
}
const options={expectedTenantId:"34",minScore:.45,requirePublished:true,requiresCurrentKb:true};
function select(demands: CurrentFactualDemand[], docs: KBDocumentCandidate[]) {
  const result=selectFactualEvidence(docs,request(demands),options);assert(result.ok,JSON.stringify(result));return result;
}

function priceCase() {
  const product=document("product","商品型號: AC-100\n銷售價: HK$4,680","Product","AC-100");
  product.authority!.entity_ids=["AC-100"];product.authority!.regions=["hong_kong"];
  const req=request([demand(1,"AC-100 price?","product",["AC-100"]),demand(2,"Delivery terms?")]);
  const bundle=selectFactualEvidence([product,document("policy","Standard delivery takes three working days.")],req,options);
  assert(bundle.ok);
  const receipt:GroundingVerificationReceipt={used_evidence_ids:["E1","E2"],question_resolution:"supported",
    demand_resolutions:[{demand_id:"demand-1",status:"supported",evidence_ids:["E1"]},{demand_id:"demand-2",status:"supported",evidence_ids:["E2"]}]};
  const claims=buildFactualKbPriceClaims(bundle,req,receipt,"company","current-customer","34");
  const metadata:Record<string,unknown>={...buildFactualCitationMetadata(bundle,receipt.used_evidence_ids,receipt.demand_resolutions),grounding_verification:receipt};
  const snapshot={conversation_id:"conversation",company_id:"company",source_message_id:"current-customer",
    commerce_state_revision:0,commerce_state_source_message_id:null,state:createEmptyConversationCommerceState()};
  return {product,req,bundle,receipt,claims,metadata,snapshot};
}
Deno.test("multi-source current selling-price proof is private and preserves policy citations",()=>{
  const c=priceCase();equal(c.claims.length,1);
  const result=evaluateB2BeforeCommit({persistence_kind:"ai_reply",snapshot:c.snapshot,metadata:c.metadata,
    trusted_kb_price_claims:c.claims,proposed_response:"AC-100 現時售價為 HK$4,680。一般三個工作天送貨。"});
  equal(result.decision,"allow");
  equal((c.metadata.citations as unknown[]).length,2);
  assert(!JSON.stringify(c.metadata).includes("bound-kb-selling-price-v1"));
  const noPrivate=evaluateB2BeforeCommit({persistence_kind:"ai_reply",snapshot:c.snapshot,metadata:c.metadata,
    proposed_response:"AC-100 現時售價為 HK$4,680。"});
  equal(noPrivate.decision,"block");
});
for(const clause of ["AC-100 現時送貨收費 HK$4,680","AC-100 現時安裝收費 HK$4,680","AC-100 現時正式報價 HK$4,680",
  "AC-100 現時套裝售價為 HK$4,680","AC-100 現時折後售價為 HK$4,680","AC-200 現時售價為 HK$4,680",
  "AC-100 兩部現時售價合共 HK$4,680","AC-100 現時每月供款售價為 HK$4,680",
  "AC-100 現時售價為 HK$4,680。AC-100 現時送貨收費 HK$4,680","AC-100 現時售價為 HK$4,680。已安排送貨。"]){
  Deno.test("selling-price proof cannot authorize another field/model/transaction: "+clause,()=>{
    const c=priceCase();const result=evaluateB2BeforeCommit({persistence_kind:"ai_reply",snapshot:c.snapshot,metadata:c.metadata,
      trusted_kb_price_claims:c.claims,proposed_response:clause});equal(result.decision,"block");
  });
}
Deno.test("price minting rejects unused, unknown-currentness and conflicting source fields",()=>{
  const c=priceCase();
  const unused={...c.receipt,used_evidence_ids:["E2"],demand_resolutions:[{demand_id:"demand-1",status:"unavailable" as const,evidence_ids:[]},c.receipt.demand_resolutions[1]]};
  equal(buildFactualKbPriceClaims(c.bundle,c.req,unused,"company","current-customer","34"),[]);
  equal(buildFactualKbPriceClaims(c.bundle,c.req,c.receipt,"company","wrong-source","34"),[]);
  equal(buildFactualKbPriceClaims(c.bundle,c.req,c.receipt,"company","current-customer","wrong-tenant"),[]);
  c.bundle.sources[0].selection.authority_decision.provenance.currentness="unknown";
  equal(buildFactualKbPriceClaims(c.bundle,c.req,c.receipt,"company","current-customer","34"),[]);
  const conflict=priceCase();
  const second={...conflict.product.chunks[0],chunk_id:"conflicting-price",content:"商品型號: AC-100\n銷售價: HK$5,000"};
  conflict.product.chunks.push(second);conflict.product.llm_context.full_content_evidence.push({document_id:second.document_id,chunk_id:second.chunk_id,
    content:second.content,source_type:second.source_type,score:second.score});
  const selected=selectFactualEvidence([conflict.product],conflict.req,options);assert(selected.ok);
  equal(buildFactualKbPriceClaims(selected,conflict.req,conflict.receipt,"company","current-customer","34"),[]);
});

for (const question of ["訂購後一般多久可以送貨？","幾時先會送到我屋企？","What happens after placing an order?"]) {
  Deno.test("policy applicability is semantic, never whole-question equality: "+question,()=>{
    const result=select([demand(1,question)],[document("delivery","All standard orders arrive three to five working days after payment.")]);
    equal(result.grounding.items.map(item=>item.document_id),["delivery"]);
    equal(result.grounding.items[0].scope,"policy_candidate");
    assert(!result.grounding.demands[0].missing_reasons.length);
  });
}
Deno.test("membership FAQ without an exact question match reaches applicability verification",()=>{
  const result=select([demand(1,"點樣成為你哋會員？")],[document("membership","建立帳戶即可免費加入會籍。","FAQ","會籍申請")]);
  assert(result.grounding.items[0].content.includes("免費"));
});
Deno.test("product follow-up can retain merchant-wide policy without manufacturing product coverage",()=>{
  const result=select([demand(1,"幾時可送貨？","policy",["CW-SUL70BA"])],[document("delivery","All standard orders follow the normal dispatch schedule.")]);
  assert(result.grounding.items.length===1);
  equal(result.sources[0].target.entity_ids,[]);
  assert(buildGroundingEvidencePrompt(result.grounding).includes("not proof" ) || buildGroundingEvidencePrompt(result.grounding).includes("not establish applicability"));
});
Deno.test("three independent product/policy demands retain three documents and one request contract",()=>{
  const product=document("product","Model: CW-SUL70BA\nPrice: HKD 4200","product","CW-SUL70BA");
  product.authority!.entity_ids=["CW-SUL70BA"];
  const result=select([demand(1,"CW-SUL70BA price?","product",["CW-SUL70BA"]),demand(2,"Any discount?"),demand(3,"When can it arrive?")],
    [product,document("discount","Member discounts depend on the active campaign."),document("delivery","Standard delivery takes three working days.")]);
  equal([...new Set(result.grounding.items.map(item=>item.document_id))].sort(),["delivery","discount","product"]);
  assert(!canUseSingleDemandDirectAnswer(request([demand(1,"price","product",["CW-SUL70BA"]),demand(2,"delivery")])));
});
Deno.test("same-title complementary policy documents are not collapsed into one winner",()=>{
  const result=select([demand(1,"Describe delivery timing and remote-area conditions")],[document("lead-time","Standard delivery takes three working days."),document("remote","Remote areas require an agreed delivery appointment.")]);
  equal(result.grounding.items.map(item=>item.document_id),["lead-time","remote"]);
});
Deno.test("same-document different SKU selections preserve each exact chunk and subject lineage",()=>{
  const a=document("catalogue","sku_code: AC-100\nspu_name: Instrument A\nprice: 100 CNY\nstock: 2","product","Catalogue");
  const b=document("catalogue","sku_code: AC-200\nspu_name: Instrument B\nprice: 200 CNY\nstock: 3","product","Catalogue");
  a.chunks[0].chunk_id="row-a";a.llm_context.full_content_evidence[0].chunk_id="row-a";
  b.chunks[0].chunk_id="row-b";b.llm_context.full_content_evidence[0].chunk_id="row-b";
  a.chunks.push(b.chunks[0]);a.llm_context.full_content_evidence.push(b.llm_context.full_content_evidence[0]);
  const result=select([demand(1,"AC-100 price?","product",["AC-100"]),demand(2,"AC-200 price?","product",["AC-200"])],[a]);
  equal(result.grounding.items.map(item=>[item.chunk_id,item.demand_ids]),[["row-a",["demand-1"]],["row-b",["demand-2"]]]);
  const metadata=buildFactualCitationMetadata(result,["E2"]) as {citations:Array<{chunk_id:string;target_entity_model:string[]}>};
  equal(metadata.citations.map(item=>[item.chunk_id,item.target_entity_model]),[["row-b",["AC-200"]]]);
});
Deno.test("unresolved second subject cannot inherit first subject evidence or a single-product answer",()=>{
  const d=demand(1,"Compare AC-100 and AC-200 prices","product",["AC-100","AC-200"]);
  const result=select([d],[document("one","AC-100 is listed at HKD 100.","product","AC-100")]);
  assert(!canUseSingleDemandDirectAnswer(request([d])));
  assert(result.grounding.demands[0].missing_reasons.includes("subject_evidence_missing"));
});
Deno.test("private transaction and ambiguous demand remain unavailable while clear policy is retrieved",()=>{
  const order=demand(1,"Has order Q123 shipped?","transaction",["Q123"]);
  const ambiguous=demand(2,"How much is that?","product");ambiguous.ambiguity.is_ambiguous=true;
  const result=select([order,ambiguous,demand(3,"What are the delivery terms?")],[document("policy","All standard orders follow the published schedule.")]);
  equal(result.grounding.items[0].demand_ids,["demand-3"]);
  equal(result.grounding.demands.slice(0,2).map(item=>item.evidence_ids),[[],[]]);
  assert(!parseGroundingDemandResolutions([{demand_id:"demand-1",status:"supported",evidence_ids:[]},
    {demand_id:"demand-2",status:"unavailable",evidence_ids:[]},{demand_id:"demand-3",status:"supported",evidence_ids:["E1"]}],result.grounding,["E1"]));
});
for(const fault of ["foreign_tenant","draft","historical","unknown","different_region","different_product"]) {
  Deno.test("demand-aware policy selection preserves authority boundary: "+fault,()=>{
    const doc=document("policy","Delivery terms for standard orders.");
    if(fault==="foreign_tenant")doc.authority!.tenant_id="999";
    if(fault==="draft")doc.authority!.publication_state="draft";
    if(fault==="historical")doc.authority!.currentness="historical";
    if(fault==="unknown")doc.authority!.currentness="unknown";
    if(fault==="different_region")doc.authority!.regions=["macau"];
    if(fault==="different_product")doc.authority!.entity_ids=["OTHER-999"];
    const result=select([demand(1,"CW-SUL70BA delivery in Hong Kong","policy",["CW-SUL70BA"])],[doc]);
    equal(result.grounding.items,[]);
  });
}
Deno.test("cross-document declared conflicts remain visible for applicability verification",()=>{
  const a=document("a","Returns within seven days."),b=document("b","Returns within thirty days.");
  a.authority!.claims=[{key:"return_days",value:"7"}];b.authority!.claims=[{key:"return_days",value:"30"}];
  const result=select([demand(1,"Explain returns and exclusions")],[a,b,document("other","Opened software is excluded.")]);
  equal(result.grounding.items.map(item=>item.document_id),["a","b","other"]);
  assert(groundingEvidenceText(result.grounding.items).includes("thirty days"));
});
Deno.test("version rank alone does not establish a cross-document policy supersession relationship",()=>{
  const a=document("old","Returns within seven days."),b=document("new","Returns within fourteen days.");
  a.authority!.claims=[{key:"return_days",value:"7"}];b.authority!.claims=[{key:"return_days",value:"14"}];
  a.authority!.version_rank=1;b.authority!.version_rank=2;
  const result=select([demand(1,"Explain returns")],[a,b]);equal(result.grounding.items.map(item=>item.document_id),["old","new"]);
});
Deno.test("conditional stock and pre-order delivery periods are retained together",()=>{
  const a=document("stock","In-stock orders ship in three days."),b=document("preorder","Pre-orders ship in fourteen days.");
  a.authority!.claims=[{key:"delivery_days",value:"3"}];b.authority!.claims=[{key:"delivery_days",value:"14"}];
  const result=select([demand(1,"Explain delivery periods and their conditions")],[a,b]);
  equal(result.grounding.items.map(item=>item.document_id),["stock","preorder"]);
  equal(result.grounding.demands[0].missing_reasons,[]);
});
Deno.test("whole evidence retains exceptions beyond the old 1200-character cutoff",()=>{
  const content="Terms. ".repeat(200)+"EXCEPTION: remote deliveries need a separate appointment.";
  const result=select([demand(1,"Explain delivery conditions")],[document("long",content)]);
  equal(result.grounding.items[0].content,content);assert(groundingEvidenceText(result.grounding.items).includes("EXCEPTION"));
});
Deno.test("over-budget source is an explicit gap, never truncated evidence or a fully resolved demand",()=>{
  const result=select([demand(1,"Explain all conditions")],[document("oversized","Detailed condition. ".repeat(400)),document("small","Basic conditions apply.")]);
  equal(result.grounding.items.map(item=>item.document_id),["small"]);assert(result.grounding.selection_limited);
  assert(!parseGroundingDemandResolutions([{demand_id:"demand-1",status:"supported",evidence_ids:["E1"]}],result.grounding,["E1"]));
});
Deno.test("persisted citations contain only the exact used document/chunk",()=>{
  const result=select([demand(1,"Explain conditions")],[document("one","A first condition."),document("two","A second condition.")]);
  const metadata=buildFactualCitationMetadata(result,["E2"]) as {citations:Array<{document_id:string;chunk_id:string}>;citation_lineage:Record<string,unknown>};
  equal(metadata.citations.map(item=>[item.document_id,item.chunk_id]),[["two","two-chunk"]]);
  equal(metadata.citation_lineage.selected_document_id,"two");
  const multi=buildFactualCitationMetadata(result,["E1","E2"]) as {citation_lineage:Record<string,unknown>};
  equal(multi.citation_lineage.selected_document_id,null);equal(multi.citation_lineage.selected_document_ids,["one","two"]);
  assert(buildFactualCitationMetadata(result,["E99"])===null);
});
Deno.test("mismatched evidence content cannot borrow a valid chunk identity",()=>{
  const doc=document("one","Seven days.");doc.llm_context.full_content_evidence[0].content="Thirty days.";
  const result=selectFactualEvidence([doc],request([demand(1,"Return period?")]),options);assert(!result.ok);
});
Deno.test("coverage validation is bounded, bidirectional and null-safe",()=>{
  const result=select([demand(1,"Explain terms")],[document("one","Exact terms.")]);
  for(const mutate of [(v:any)=>v.demands=[null],(v:any)=>v.demands[0].evidence_ids=Array(10000).fill("E1"),
    (v:any)=>{v.demands[0].blocked=true;v.demands[0].evidence_ids=[];}]){
    const value=structuredClone(result.grounding);mutate(value);assert(validGroundingEvidence(value)===false);
  }
  assert(!parseGroundingDemandResolutions([],result.grounding,[]));
  assert(!parseGroundingDemandResolutions([{demand_id:"demand-1",status:"supported",evidence_ids:["E99"]}],result.grounding,["E99"]));
});

// Local source-field recovery fixtures: all identities and amounts are synthetic.
// Authentication is the existing response/document/chunk binding, not a forged
// authority enum; the recovered amount remains recorded-only after rejection.
const recoveryOptions={language:"zh-TW" as const,companyId:"company",sourceMessageId:"current-customer",expectedTenantId:"34"};
async function bindPublishedProduct(doc: KBDocumentCandidate) {
  const {response,grounded}=await bindRagApiResponse(Response.json({success:true,context_found:true,
    selected_documents:[{document_id:doc.document_id,title:doc.title,source_type:doc.source_type,
      document_score:doc.document_score,authority:doc.authority,
      evidence:doc.chunks.map(({status:_status,...chunk})=>chunk)}],citations:[]}),ORIGINAL_RAG_ACTIVATION);
  assert(grounded,"isolated authenticated product response was invalid");
  bindRagServiceDocument(response,doc);
  for(const chunk of doc.chunks)bindRagServiceDocument(response,chunk);
  return doc;
}
async function recoveryCase(fields="銷售價: HK$1,290",currentness:"unknown"|"current"="unknown",bind=true) {
  const product=document("recovery-product","商品型號: AX-QZ81\n"+fields+"\n庫存: 7","product","AX-QZ81");
  product.authority!.entity_ids=["AX-QZ81"];product.authority!.regions=["hong_kong"];product.authority!.currentness=currentness;
  if(bind)await bindPublishedProduct(product);
  const price=demand(1,"AX-QZ81 price?","product",["AX-QZ81"]);
  const stock=demand(2,"Is AX-QZ81 in stock now?","product",["AX-QZ81"]);stock.requested_facts=["availability"];
  const req=request([price,stock]);
  const bundle=selectFactualEvidence([product],req,options);assert(bundle.ok);
  return {product,req,bundle};
}
for(const currentness of ["unknown","current"] as const)Deno.test("V2 source-field recovery: "+currentness+" price stays recorded-only with live stock pending and unchanged B2",async()=>{
  const c=await recoveryCase(undefined,currentness);
  for(const language of ["en","zh-TW","zh-CN"] as const){
    const result=resolveSourceRecordedPartialRecovery(c.bundle,c.req,{...recoveryOptions,language});assert(result);
    equal(result.demand_outcomes.map(item=>[item.demand_id,item.status,item.evidence_ids]),
      [["demand-1","partial",["E1"]],["demand-2","unavailable",[]]]);
    equal(result.unresolved_demand_ids,["demand-1","demand-2"]);
    equal(result.recorded_facts.map(item=>[item.field,item.value]),[["price_amount",1290],["price_currency","HKD"]]);
    assert(result.recorded_facts.every(item=>item.demand_id==="demand-1"&&item.document_id==="recovery-product"&&
      item.chunk_id==="recovery-product-chunk"&&item.source_field==="銷售價"&&item.source_message_id==="current-customer"&&
      item.tenant_id==="34"&&item.company_id==="company"&&item.currentness==="unverified"&&item.source_currentness===currentness));
    assert(result.reply.includes("HK$1,290")&&!result.reply.includes(c.req.demands[1].source_quote));
    assert(!/[?？]/u.test(result.reply),"pending facts are declarative and cannot re-ask a known model");
    assert(!result.reply.includes("7"),"recorded stock must not become a live stock answer");
    const metadata={...result.citation_metadata,response_route:"canonical_kb_partial_recovery",recorded_kb_facts:result.recorded_facts,
      authoritative_kb_facts:[],partial_recovery:{contract:"canonical-source-field-recovery-1",question_resolution:"partial",demand_outcomes:result.demand_outcomes},
      unresolved_fact_fields:result.unresolved_demand_ids,factual_grounding_required:true};
    const state=createEmptyConversationCommerceState();
    const verdict=evaluateB2BeforeCommit({persistence_kind:"ai_reply",proposed_response:result.reply,metadata,
      snapshot:{conversation_id:"conversation",company_id:"company",source_message_id:"current-customer",commerce_state_revision:0,
        commerce_state_source_message_id:null,state}});
    equal(verdict.decision,"allow");equal(state.quotes,[]);
    assert(!("kb_fact_proof" in metadata)&&!("answer_kind" in metadata),"recovery must not borrow direct/current quote authority");
  }
});
Deno.test("V2 source-field recovery: same-document catalogue rows keep exact per-demand price, currency and lineage",async()=>{
  const a=document("recovery-catalogue","sku_code: AX-QZ81\nspu_name: Harbor field pack\nprice: 125.0 CNY\nstock: 0","product","Catalogue");
  const b=document("recovery-catalogue","sku_code: BR-998\nspu_name: Ridge travel pack\nprice: 349.0 CNY\nstock: 5","product","Catalogue");
  a.authority!.currentness="unknown";
  a.chunks[0].chunk_id="row-a";a.llm_context.full_content_evidence[0].chunk_id="row-a";
  b.chunks[0].chunk_id="row-b";b.llm_context.full_content_evidence[0].chunk_id="row-b";
  a.chunks.push(b.chunks[0]);a.llm_context.full_content_evidence.push(b.llm_context.full_content_evidence[0]);
  await bindPublishedProduct(a);
  const req=request([demand(1,"AX-QZ81 price?","product",["AX-QZ81"]),demand(2,"BR-998 price?","product",["BR-998"]),
    demand(3,"What are the delivery terms?"),demand(4,"Has my order shipped?","transaction")]);
  req.missing_evidence=[{demand_id:"demand-4",reason:"live_transaction_unavailable"}];
  const bundle=selectFactualEvidence([a,document("recovery-policy","Dispatch timing depends on the destination.")],req,options);assert(bundle.ok);
  const result=resolveSourceRecordedPartialRecovery(bundle,req,{...recoveryOptions,language:"en"});assert(result);
  equal(result.recorded_facts.filter(item=>item.field==="price_amount").map(item=>[item.demand_id,item.model,item.value,item.chunk_id]),
    [["demand-1","AX-QZ81",125,"row-a"],["demand-2","BR-998",349,"row-b"]]);
  equal(result.recorded_facts.filter(item=>item.field==="price_currency").map(item=>item.value),["CNY","CNY"]);
  equal(result.demand_outcomes.map(item=>item.status),["partial","partial","unavailable","unavailable"]);
  equal((result.citation_metadata.citations as Array<{document_id:string;chunk_id:string}>).map(item=>[item.document_id,item.chunk_id]),
    [["recovery-catalogue","row-a"],["recovery-catalogue","row-b"]]);
  assert(!JSON.stringify(result.citation_metadata).includes("recovery-policy"),"a pending policy borrowed answered-price citations");
  assert(!result.reply.includes(req.demands[2].source_quote)&&!result.reply.includes(req.demands[3].source_quote));
  assert(!/[?？]/u.test(result.reply),"cross-demand pending facts must not echo visitor questions");
  equal(result.unresolved_demand_ids,req.demands.map(item=>item.id));
});
Deno.test("V2 source-field recovery: unknown currency is explicit and never inferred from tenant or source region",async()=>{
  const c=await recoveryCase("銷售價: 1290");
  const result=resolveSourceRecordedPartialRecovery(c.bundle,c.req,recoveryOptions);assert(result);
  equal(result.recorded_facts.map(item=>[item.field,item.value]),[["price_amount",1290]]);
  assert(result.reply.includes("1,290")&&result.reply.includes("未註明幣別"));
  assert(!/HK\$|HKD|CNY/.test(result.reply));
});
Deno.test("V2 source-field recovery: unmet demand conditions, scope and source bindings cannot be stripped",async()=>{
  for(const fault of ["constraints","negation","correction","ambiguity","subject_source","missing_evidence","source_id","tenant_id","cross_demand_chunk"]){
    const c=await recoveryCase();const option={...recoveryOptions};
    if(fault==="constraints")c.req.demands[0].constraints={quantity:2};
    if(fault==="negation")c.req.demands[0].explicit_negations=["not a bundle"];
    if(fault==="correction")c.req.demands[0].customer_correction=true;
    if(fault==="ambiguity")c.req.demands[0].ambiguity.is_ambiguous=true;
    if(fault==="subject_source")c.req.demands[0].subject_source_message_ids=[];
    if(fault==="missing_evidence")c.req.missing_evidence=[{demand_id:"demand-1",reason:"source_quote_unbound"}];
    if(fault==="source_id")option.sourceMessageId="different-customer";
    if(fault==="tenant_id")option.expectedTenantId="99";
    if(fault==="cross_demand_chunk"){
      c.bundle.sources[0].demand_ids=["demand-2"];
      c.bundle.grounding.items[0].demand_ids=["demand-2"];
      c.bundle.grounding.items[0].demand_scopes={"demand-2":"subject_evidence"};
      c.bundle.grounding.demands[0].evidence_ids=[];
    }
    equal(resolveSourceRecordedPartialRecovery(c.bundle,c.req,option),null);
  }
});
Deno.test("V2 source-field recovery: absent, malformed and conflicting selling prices are not recovered",async()=>{
  for(const fields of ["成本: HK$1290\n描述: List of 1290 packages","銷售價: HK$1,29","銷售價: HK$1290\n售價: HK$1390","銷售價: 未提供"]){
    const c=await recoveryCase(fields);equal(resolveSourceRecordedPartialRecovery(c.bundle,c.req,recoveryOptions),null);
  }
  const unbound=await recoveryCase(undefined,"unknown",false);
  equal(resolveSourceRecordedPartialRecovery(unbound.bundle,unbound.req,recoveryOptions),null);
});
Deno.test("V2 source-field recovery: catalogue short-name identity candidates do not become confirmed subjects",async()=>{
  const product=document("recovery-short-name","spu_code: HF1\nspu_name: 輕量化戶外衝鋒衣\nsku_code: HF1-NV-XL\nprice: 125 CNY\nstock: 2","product","Row 4");
  product.authority!.currentness="unknown";await bindPublishedProduct(product);
  const req=request([demand(1,"輕量衝鋒衣幾錢？","product",["輕量衝鋒衣"]),demand(2,"有冇現貨？","product",["輕量衝鋒衣"])]);
  req.demands[1].requested_facts=["availability"];
  const bundle=selectFactualEvidence([product],req,options);assert(bundle.ok);
  equal(resolveSourceRecordedPartialRecovery(bundle,req,recoveryOptions),null);
});


Deno.test("Task 3 Hosted V2 regression: recorded partial price survives B2 with a known customer model",async()=>{
  const c=await recoveryCase();
  const partial=resolveSourceRecordedPartialRecovery(c.bundle,c.req,recoveryOptions);
  assert(partial);
  const state=createEmptyConversationCommerceState();
  state.current_intent="select_product";
  state.current_topic="air_conditioner";
  state.entities.push({entity_id:"customer-known-product",category:"air_conditioner",brand:"Generic",
    model:"AX-QZ81",quantity:1,status:"tentative",attributes:{room_sizes:[95],customer_goal:{missing:["price","availability"]}},
    constraints:{},provenance:{source_type:"customer",source_message_id:"prior-customer"}});
  state.customer_constraints={preferred_room_area_sq_ft:95,budget_currency:"HKD"};
  const snapshot={conversation_id:"conversation",company_id:"company",source_message_id:"current-customer",
    commerce_state_revision:3,commerce_state_source_message_id:"prior-customer",state};
  const metadata={...partial.citation_metadata,response_route:"canonical_kb_partial_recovery",
    recorded_kb_facts:partial.recorded_facts,authoritative_kb_facts:[],
    partial_recovery:{contract:"canonical-source-field-recovery-1",question_resolution:"partial",
      demand_outcomes:partial.demand_outcomes},unresolved_fact_fields:partial.unresolved_demand_ids,
    factual_grounding_required:true};
  const oldEcho=partial.reply+"\\n\\nUnverified question: AX-QZ81 price?";
  const legacy=evaluateB2BeforeCommit({persistence_kind:"ai_reply",proposed_response:oldEcho,metadata,snapshot});
  equal([legacy.decision,legacy.code],["block","KNOWN_CONTEXT_RECONFIRMATION"]);
  const fixed=evaluateB2BeforeCommit({persistence_kind:"ai_reply",proposed_response:partial.reply,metadata,snapshot});
  equal(fixed.decision,"allow");
  assert(!/[?？]/u.test(partial.reply));
  assert(!partial.reply.includes(c.req.demands[0].source_quote));
  assert(!partial.reply.includes(c.req.demands[1].source_quote));
  equal(partial.unresolved_demand_ids,["demand-1","demand-2"]);
  equal(partial.recorded_facts.filter(f=>f.field==="price_amount").map(f=>f.value),[1290]);
  equal(state.quotes,[]);
  equal(state.entities[0].model,"AX-QZ81");
});
