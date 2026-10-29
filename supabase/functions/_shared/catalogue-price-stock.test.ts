import {parseKbProductRecord,kbProductRecordPrice,kbProductRecordStock,catalogueFactRequest,matchCatalogueRecord} from './kb-product-record.ts';
import {parseAggregationResponse} from './kb-aggregation-response.ts';
import {selectCanonicalGrounding,deriveCurrentGroundingTarget} from './canonical-grounding.ts';
import {resolveCanonicalKbDirectAnswer,catalogueVariantClarification} from './canonical-kb-direct-answer.ts';
import {buildCitationMetadata} from './citation-lineage.ts';
import {bindRagApiResponse,bindRagServiceDocument,ORIGINAL_RAG_ACTIVATION} from './preview-kb-query-embedding.ts';
import {evaluateB2BeforeCommit} from './pre-send-conversion-supervisor.ts';
import {createEmptyConversationCommerceState} from './commerce-state-contract.ts';
import type {KBDocumentCandidate} from './kb-client.ts';
const assert=(v:unknown,msg:string)=>{if(!v)throw Error(msg)};
// Verbatim field transcription of the user-provided 2026-10-29 Row 4 screenshot.
// This is NOT a captured RAG response nor proof of current price/live inventory.
const ROW4='spu_code: P002\nspu_name: 轻量化户外冲锋衣\nsku_code: P002–NV–XL\nspec_color: 藏青色\nspec_size: XL\nprice: 2100.0 CNY\nstock: 5\ndescription: 專業防水透氣面料，適合登山、徒步及日常通勤。';
const full='轻量化户外冲锋衣';
async function document(body=ROW4,id='source-row-4',overrides:Record<string,unknown>={},bind=true):Promise<KBDocumentCandidate>{
 const wire={success:true,context_found:true,selected_documents:[{document_id:id,title:'Row 4',source_type:'Product',document_score:0.03,
  authority:{tenant_id:'34',publication_state:'published',currentness:'unknown',...overrides},
  evidence:[{document_id:id,chunk_id:id+'-chunk',chunk_type:'full_content',content:body,score:0.03}]}],citations:[]};
 const p=parseAggregationResponse(wire);if(!p.ok)throw Error('WIRE_DECODER_REJECTED');
 const doc={...p.documents[0],chunks:p.documents[0].chunks.map(c=>({...c,doc_id:c.document_id,status:'unknown'}))} as KBDocumentCandidate;
 if(bind){const {response}=await bindRagApiResponse(Response.json(wire),ORIGINAL_RAG_ACTIVATION);bindRagServiceDocument(response,doc);for(const c of doc.chunks)bindRagServiceDocument(response,c);}
 return doc;
}
function answer(q:string,docs:KBDocumentCandidate[],language:'zh-TW'|'zh-CN'|'en'='zh-TW'){
 const selection=selectCanonicalGrounding(docs,{requestText:q,currentTurnText:q,minScore:0.45,expectedTenantId:'34',requirePublished:true,requiresCurrentKb:true});
 return {selection,result:resolveCanonicalKbDirectAnswer({request:q,selection,language}),question:catalogueVariantClarification(selection,language)};
}
function b2(x:ReturnType<typeof answer>){
 assert(x.selection.ok&&x.result,'answer absent');if(!x.selection.ok||!x.result)throw Error('missing');
 const citation=buildCitationMetadata(x.result.evidence_chunks,x.selection.document!.document_id,{authorityDecision:x.selection.authority_decision,currentTarget:deriveCurrentGroundingTarget(full+' 幾錢？')});
 assert(citation,'lineage missing');
 return evaluateB2BeforeCommit({proposed_response:x.result.reply,persistence_kind:'ai_reply',snapshot:{conversation_id:'example',company_id:'3d6e17b5-ec79-4f75-aa7f-eaa824ff8493',source_message_id:'example',commerce_state_revision:0,commerce_state_source_message_id:null,state:createEmptyConversationCommerceState()},metadata:{...citation,reference_authority:x.selection.authority_decision,response_route:'canonical_kb_direct_answer',answer_kind:x.result.kind,recorded_kb_facts:x.result.recorded_facts}});
}
Deno.test('Catalogue Row4: SPU, SKU, dimensions, CNY and stock remain one atomic record',()=>{
 const r=parseKbProductRecord(ROW4);assert(r.names[0]===full&&r.sku_codes[0]==='P002-NV-XL'&&r.variants.size==='XL','identity/variant missing');
 const p=kbProductRecordPrice(r),stock=kbProductRecordStock(r);assert(p.amount===2100&&p.currency==='CNY'&&stock.quantity===5,'source facts missing');
 for(const input of [ROW4,ROW4.replace(/\s+/gu,' '),JSON.stringify(Object.fromEntries(r.fields.map(f=>[f.key,f.value])))]){
  const parsed=parseKbProductRecord(input);assert(parsed.names[0]===full&&kbProductRecordPrice(parsed).currency==='CNY'&&kbProductRecordStock(parsed).quantity===5,'format lost source facts');
 }
});
Deno.test('Catalogue exact product: actual decoder -> bound Full Content -> CNY/stock reply -> unchanged B2',async()=>{
 const x=answer(`${full} 几钱？`,[await document()]);
 assert(x.result?.reply.includes('CNY 2,100')&&x.result.reply.includes('數量：5')&&x.result.reply.includes('P002-NV-XL')&&x.result.reply.includes('XL')&&x.result.reply.includes('藏青色'),JSON.stringify(x));
 assert(!x.result?.price_fact&&!x.result?.reply.includes('HK$'),'snapshot promoted to HKD/current quote');
 assert(x.result?.recorded_facts?.some(f=>f.field==='stock_quantity'&&f.value===5&&f.currentness==='unverified'),'stock source proof missing');
 assert(b2(x).decision==='allow','unchanged B2 denied qualified facts');
});
Deno.test('Catalogue short name: answer only for the candidate record without reconfirming known context',async()=>{
 const x=answer('轻量冲锋衣 几钱？',[await document()]);
 assert(x.result?.reply.includes('CNY 2,100')&&x.result.reply.includes(full)&&x.result.identity_confirmation_required,'short-name conditional answer absent');
 assert(x.result?.unresolved_fact_fields?.includes('product_identity')&&x.result.reply.includes('名稱相近')&&x.result.reply.includes('商品對應仍未確認'),'identity silently confirmed');
 assert(!x.result?.reply.includes('你指嘅係')&&x.result?.catalogue_options?.length===1,'repeated identity question or missing requery target');
 assert(b2(x).decision==='allow','B2 denied candidate facts');
});
Deno.test('Catalogue stock-only lookup does not require a price request',async()=>{
 const x=answer(`${full} 庫存幾多？`,[await document()]);
 assert(x.result?.reply.includes('數量：5')&&!x.result.reply.includes('2,100'),'stock-only lost/price unsolicited');
 assert(x.result?.reply.includes('即時可售')&&!x.result.price_fact,'stock became live guarantee');
 assert(b2(x).decision==='allow','stock snapshot denied');
});
Deno.test('Catalogue source candidate without SKU offers a usable fresh query and preserves uncertainty',async()=>{
 const noSku=ROW4.replace('sku_code: P002–NV–XL\n','');
 for(const language of ['en','zh-CN','zh-TW'] as const){
  const x=answer('轻量冲锋衣 價格及庫存？',[await document(noSku)],language);
  assert(x.result?.reply.includes('CNY 2,100')&&x.result.identity_confirmation_required&&x.result.unresolved_fact_fields?.includes('product_identity'),'no-SKU candidate lost known facts or uncertainty');
  assert(!x.result?.catalogue_options&&!x.result?.reply.includes('SKU'),'no-SKU candidate offered an unavailable selection route');
  assert(/full source product name|来源完整商品名称|來源完整商品名稱/u.test(x.result!.reply),'no actionable full-name lookup guidance');
  assert(b2(x).decision==='allow','no-SKU source candidate rejected by B2');
 }
});
Deno.test('Catalogue stock zero is a known integer, not missing',async()=>{
 const x=answer('P002-NV-XL price and stock?',[await document(ROW4.replace('stock: 5','stock: 0'))],'en');
 assert(x.result?.reply.includes('Recorded stock quantity: 0')&&x.result.reply.includes('CNY 2,100'),JSON.stringify(x));
 assert(!x.result?.reply.includes('is unknown')&&b2(x).decision==='allow','zero mishandled');
});
Deno.test('Catalogue exact SKU normalization does not conflate sizes or colours',async()=>{
 const xl=await document(),m=await document(ROW4.replaceAll('XL','M').replace('2100.0','1900.0').replace('stock: 5','stock: 0'),'m');
 const x=answer('P002–NV–XL 價格及庫存？',[m,xl]);
 assert(x.result?.reply.includes('2,100')&&!x.result.reply.includes('1,900')&&x.result.reply.includes('數量：5'),'wrong variant chosen');
 const y=answer('P002-NV-M price and stock?',[xl,m],'en');
 assert(y.result?.reply.includes('1,900')&&y.result.reply.includes('quantity: 0')&&!y.result.reply.includes('2,100'),'M facts crossed');
});
Deno.test('Catalogue variant ambiguity: no arbitrary rank-first price, precise SKU question',async()=>{
 const docs=[await document(),await document(ROW4.replaceAll('XL','M').replace('2100.0','1900.0'),'m')];
 const x=answer(`${full} 几钱？`,docs);assert(!x.result&&x.question?.reply.includes('P002-NV-M')&&x.question.reply.includes('P002-NV-XL'),'variant ambiguity missing');
 assert(!x.question?.reply.includes('2,100'),'rank-first price leaked');
 const y=answer(`${full} XL 几钱？`,docs);assert(y.result?.reply.includes('P002-NV-XL'),JSON.stringify(y));
});
Deno.test('Catalogue competing shortened product names require disambiguation',async()=>{
 const x=answer('轻量冲锋衣 几钱？',[await document(),await document(ROW4.replaceAll('P002','P003').replace(full,'轻量防水冲锋衣'),'other-spu')]);
 assert(!x.result&&x.question?.reply.includes('P003'),'short name selected first competing product');
});
Deno.test('Catalogue same SKU contradictory price or stock stays fail-closed',async()=>{
 for(const alternate of [ROW4.replace('2100.0','2200.0'),ROW4.replace('stock: 5','stock: 99')]){
  const x=answer('P002-NV-XL price and stock?',[await document(),await document(alternate,'conflicting')]);
  assert(!x.result,'conflicting same-SKU facts accepted');
 }
});
Deno.test('Catalogue known price plus absent/invalid/conflicting stock answers only known facts',async()=>{
 for(const value of ['', 'stock: -1','stock: 1.5','stock: unknown','stock: true','stock: 5\ninventory: 7']){
  const x=answer(`${full} 價格及庫存？`,[await document(ROW4.replace('stock: 5',value))]);
  assert(x.result?.reply.includes('CNY 2,100')&&x.result.unresolved_fact_fields?.includes('stock'),'known price swallowed by unknown stock');
  assert(!x.result?.recorded_facts?.some(f=>f.field==='stock_quantity'),'unknown stock fabricated');
 }
});
Deno.test('Catalogue currencies preserve explicit ISO and marker, no conversion',()=>{
 for(const [raw,code] of [['2100.0 CNY','CNY'],['RMB 2,100','CNY'],['HK$2,100','HKD'],['USD 2,100.00','USD'],['NT$2100','TWD'],['EUR 2,100','EUR'],['2100 JPY','JPY'],['SGD 2100','SGD'],['2100 GBP','GBP'],['2100 AUD','AUD']]){
  const p=kbProductRecordPrice(parseKbProductRecord(`name: Example Shirt\nprice: ${raw}`));assert(p.amount===2100&&p.currency===code,JSON.stringify({raw,p}));
 }
 for(const fields of ['price: HK$2100 CNY','price: 2100 USD\ncurrency: HKD','price: $2100','price: ¥2100','price: 21,00 CNY','price: 2100 CNY\nprice_2: 2200 CNY']){
  assert(kbProductRecordPrice(parseKbProductRecord('name: Example Shirt\n'+fields)).amount===null,'ambiguous currency/amount accepted');
 }
 const missing=kbProductRecordPrice(parseKbProductRecord('name: Example Shirt\nprice: 2100'));assert(missing.amount===2100&&missing.currency===null,'missing currency became default');
});
Deno.test('Catalogue stock aliases and duplicate protections do not use generic order quantity',()=>{
 for(const key of ['stock','stock_quantity','inventory_qty','available_quantity','庫存','库存数量'])assert(kbProductRecordStock(parseKbProductRecord(`name: Example Shirt\n${key}: 0`)).quantity===0,key);
 for(const raw of ['quantity: 5','reserved_stock: 5','description: stock: 5','stock: 5\nstock_2: 7'])assert(kbProductRecordStock(parseKbProductRecord(`name: Example Shirt\n${raw}`)).quantity===null,raw);
});
Deno.test('Catalogue source prose cannot mint product/price/stock columns after flattening',()=>{
 const r=parseKbProductRecord('description: Use example spu_name: Example Shirt price: 5 CNY stock: 99');
 assert(!r.names.length&&kbProductRecordStock(r).quantity===null,'prose became source fields');
 const indented=parseKbProductRecord('description: useful prose\n   spu_name: Example Shirt\n  price: 5 CNY\n  stock: 0');
 assert(indented.names[0]==='example shirt'&&kbProductRecordStock(indented).quantity===0,'indented real boundaries lost');
});
Deno.test('Catalogue tenant/publication/currentness and response binding remain enforced',async()=>{
 assert(!answer(`${full} 几钱？`,[await document(ROW4,'unbound',{},false)]).result,'unbound data accepted');
 for(const authority of [{tenant_id:'other'},{publication_state:'draft'},{currentness:'historical'},{currentness:'superseded'},{currentness:'cancelled'}]){
  let rejected=false;try{rejected=!answer(`${full} 几钱？`,[await document(ROW4,'bad',authority)]).result;}catch(e){rejected=e instanceof Error&&e.message==='KB_TOOL_FAILURE';}
  assert(rejected,JSON.stringify(authority));
 }
});
Deno.test('Catalogue foreign document/chunk lineage is rejected before matching',async()=>{
 const doc=await document();doc.chunks[0].document_id='other-document';
 const x=answer(`${full} 几钱？`,[doc]);assert(!x.selection.ok&&!x.result,'foreign chunk accepted');
});
Deno.test('Catalogue independent product families and English requests use same mapping',async()=>{
 for(const name of ['Cloud Linen Shirt','保溫隨行杯','辦公室升降桌']){
  const body=ROW4.replace(full,name).replace('2100.0 CNY','188 SGD');
  const q=name==='Cloud Linen Shirt'?`How much is the ${name}?`:`${name} 幾錢？`;
  const x=answer(q,[await document(body)],'en');assert(x.result?.reply.includes('SGD 188')&&x.result.reply.includes('quantity: 5'),'product-specific hard coding');
 }
});
Deno.test('Catalogue identity corrections never silently retain a different explicit SKU',async()=>{
 assert(!answer('P099-NV-XL price and stock?',[await document()]).result,'wrong SKU accepted');
 assert(!catalogueFactRequest('取消 P002-NV-XL，不要查價格'),'cancel triggers fact lookup');
 assert(!matchCatalogueRecord(catalogueFactRequest('P002-NV-M price?')!,parseKbProductRecord(ROW4)),'wrong size accepted');
});
Deno.test('Catalogue B2 still blocks forged current CNY price despite snapshot fields',async()=>{
 const x=answer(`${full} 几钱？`,[await document()]);if(!x.result)throw Error('no answer');
 x.result.reply='目前售價為 CNY 2,100，已確認為現價。';assert(b2(x).decision==='block','unverified current CNY price passed B2');
});

import {resolveCatalogueVariantFollowup} from './kb-product-record.ts';
Deno.test('Catalogue immediate variant choice yields a fresh lookup request, never old prices/stock',async()=>{
 const docs=[await document(),await document(ROW4.replaceAll('XL','M'),'m')];
 const x=answer(`${full} 價格及庫存？`,docs);if(!x.question)throw Error('no variant question');
 const scope={conversation_id:'conversation',company_id:'company',source_message_id:'new-customer-message'};
 const history=[{id:'new-customer-message',role:'visitor',content:'XL'}, {id:'question',role:'assistant',conversation_id:'conversation',company_id:'company',
  metadata:{control_commit:'ai',b2_expected_company_id:'company',answer_kind:'catalogue_variant_clarification',catalogue_options:x.question.options,catalogue_requested_facts:x.question.requested_facts}}];
 const follow=resolveCatalogueVariantFollowup('XL',history,scope);
 assert(follow?.request==='P002-NV-XL price and stock?','fresh scope not reconstructed');
 assert(!follow?.request.includes('2100')&&!follow?.request.includes('stock: 5'),'old evidence leaked as authority');
 // Fresh result can change stock; original answer must not be reused.
 const y=answer(follow!.request,[await document(ROW4.replace('stock: 5','stock: 0'))]);
 assert(y.result?.recorded_facts?.some(f=>f.field==='stock_quantity'&&f.value===0),'new retrieval stock not used');
 assert(!resolveCatalogueVariantFollowup('取消 XL',history,scope),'cancel became selection');
 assert(!resolveCatalogueVariantFollowup('XL',[{...history[1],company_id:'other'}],scope),'cross-tenant context selected');
 assert(!resolveCatalogueVariantFollowup('XL',[{id:'topic-switch',role:'visitor',content:'另外問退款'},history[1]],scope),'unrelated topic skipped');
 assert(!resolveCatalogueVariantFollowup('XL',[{...history[1],metadata:{...history[1].metadata,control_commit:'human'}}],scope),'unverified assistant metadata selected');
});
Deno.test('Catalogue candidate exact SKU repeats requested facets through fresh evidence only',async()=>{
 const x=answer('轻量冲锋衣 價格及庫存？',[await document()]);
 if(!x.result?.identity_confirmation_required||!x.result.catalogue_options)throw Error('no source candidate');
 const scope={conversation_id:'conversation',company_id:'company',source_message_id:'sku-followup'};
 const anchor={id:'candidate-answer',role:'assistant',conversation_id:scope.conversation_id,company_id:scope.company_id,
  metadata:{control_commit:'ai',b2_expected_company_id:scope.company_id,answer_kind:x.result.kind,
   identity_confirmation_required:true,unresolved_fact_fields:x.result.unresolved_fact_fields,
   catalogue_options:x.result.catalogue_options,catalogue_requested_facts:x.result.catalogue_requested_facts}};
 const history=[{id:scope.source_message_id,role:'visitor',content:'P002–NV–XL'},anchor];
 const next=resolveCatalogueVariantFollowup('P002–NV–XL',history,scope);
 assert(next?.request==='P002-NV-XL price and stock?'&&next.source_assistant_message_id===anchor.id,'candidate SKU lost requested facets');
 assert(!JSON.stringify(x.result.catalogue_options).includes('2100')&&!JSON.stringify(x.result.catalogue_options).includes('stock_quantity'),'retrieval target carried old commerce facts');
 const fresh=answer(next!.request,[await document(ROW4.replace('2100.0','2200.0').replace('stock: 5','stock: 0'))]);
 assert(fresh.result?.reply.includes('CNY 2,200')&&!fresh.result.reply.includes('2,100')&&fresh.result.recorded_facts?.some(f=>f.field==='stock_quantity'&&f.value===0),'fresh result reused old price/stock');
 assert(fresh.result?.identity_confirmation_required===false&&!fresh.result.unresolved_fact_fields?.includes('product_identity')&&!fresh.result.price_fact,'exact SKU did not resolve only product identity');
 for(const text of ['XL','藏青色','係','yes','P002-NV-M','取消 P002-NV-XL','真人 P002-NV-XL','轻量冲锋衣 幾錢？']){
  assert(!resolveCatalogueVariantFollowup(text,history,scope),'candidate product identity silently accepted: '+text);
 }
 for(const invalid of [
  {...anchor,company_id:'other-company'},
  {...anchor,conversation_id:'other-conversation'},
  {...anchor,metadata:{...anchor.metadata,b2_expected_company_id:'other-company'}},
  {...anchor,metadata:{...anchor.metadata,control_commit:'human'}},
  {...anchor,metadata:{...anchor.metadata,identity_confirmation_required:false}},
  {...anchor,metadata:{...anchor.metadata,catalogue_requested_facts:{}}},
  {...anchor,metadata:{...anchor.metadata,catalogue_options:[{...(x.result.catalogue_options[0] as Record<string,unknown>),document_id:'foreign-document'}]}},
  {...anchor,metadata:{...anchor.metadata,catalogue_options:[...x.result.catalogue_options,...x.result.catalogue_options]}},
 ])assert(!resolveCatalogueVariantFollowup('P002-NV-XL',[invalid],scope),'untrusted or ambiguous candidate context selected');
 assert(!resolveCatalogueVariantFollowup('P002-NV-XL',[{id:'different-topic',role:'visitor',content:'問退貨'},anchor],scope),'intervening visitor topic ignored');
 assert(!resolveCatalogueVariantFollowup('P002-NV-XL',[{id:'different-answer',role:'assistant',content:'退貨說明'},anchor],scope),'older candidate skipped to');
});
Deno.test('Catalogue ordinary model price plus explicit stock shares the same snapshot path',async()=>{
 const body='商品型號: CW-SUL90BA\nprice: HKD 6,980\nstock: 5';
 const x=answer('CW-SUL90BA price and stock?',[await document(body)]);
 assert(x.result?.reply.includes('HK$6,980')&&x.result.reply.includes('數量：5'),'model stock read missing');
 assert(!x.result?.price_fact&&b2(x).decision==='allow','snapshot converted to current proof');
});

Deno.test('Catalogue source quantities and currencies pass unchanged B2 in each supported reply language',async()=>{
 for(const language of ['en','zh-CN','zh-TW'] as const){
  for(const raw of ['2100.0 CNY','HK$2,100','USD 2,100','NT$2,100','2100.125 KWD']){
   const x=answer('P002-NV-XL price and stock?',[await document(ROW4.replace('2100.0 CNY',raw).replace('stock: 5','stock: 0'))],language);
   assert(x.result?.recorded_facts?.some(f=>f.field==='stock_quantity'&&f.value===0),'zero missing');
   assert(b2(x).decision==='allow','language/currency record rejected '+language+' '+raw);
   assert(!x.result?.price_fact,'record fabricated current quote');
  }
 }
});
Deno.test('Catalogue variant question passes real B2 without authorizing any SKU price',async()=>{
 const x=answer(`${full} price and stock?`,[await document(),await document(ROW4.replaceAll('XL','M'),'row-m')]);
 if(!x.question)throw Error('question absent');
 const result=evaluateB2BeforeCommit({proposed_response:x.question.reply,persistence_kind:'ai_reply',
  snapshot:{conversation_id:'example',company_id:'3d6e17b5-ec79-4f75-aa7f-eaa824ff8493',source_message_id:'example',commerce_state_revision:0,commerce_state_source_message_id:null,state:createEmptyConversationCommerceState()},
  metadata:{response_route:'canonical_kb_direct_answer',answer_kind:'catalogue_variant_clarification',service_action:'targeted_clarification',unresolved_fact_fields:['variant'],catalogue_options:x.question.options,catalogue_requested_facts:x.question.requested_facts,factual_grounding_required:true,grounding_state:'source_variants_require_choice',rag_api_status:'success'}});
 assert(result.decision==='allow','B2 rejected bound variant question '+result.code);
});
