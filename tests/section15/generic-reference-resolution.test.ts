import { arbitrateAnaphoricProductFollowUp as resolve, classifyNaturalCustomerIntent, type ProductReferenceContext } from '../../supabase/functions/_shared/natural-customer-response.ts';
const scope={company_id:'tenant-one',conversation_id:'ticket-one'};
const entity=(model:string,category:string,status='researching')=>({entity_id:`entity:${model}`,model,category,status,attributes:{}});
const history=(content:string)=>({role:'visitor',content,...scope});
const context=(entities:NonNullable<ProductReferenceContext["state"]>["entities"],topic:string|null=null):ProductReferenceContext=>({...scope,state:{entities,current_topic:topic},category_aliases:[
  {key:'equipment',aliases:['設備','equipment']},{key:'booking',aliases:['預約','booking']},{key:'subscription',aliases:['訂閱','subscription']},
]});
function assert(value:unknown,message='assertion failed'):asserts value {if(!value)throw Error(message);}
for(const [category,label] of [['equipment','設備'],['booking','預約'],['subscription','訂閱']]) {
  for(const question of [`講返之前嗰個${label}，價錢幾多？`,`返回之前那項${label}，價格多少？`,`back to that ${category}, how much is it?`]) {
    Deno.test(`generic authoritative category return: ${category}: ${question}`,()=>{
      const result=resolve(question,[history('Other entity ALT-902'),history('Original entity REF-801')],scope,context([entity('REF-801',category),entity('ALT-902','other')]));
      assert(result.kind==='resolved'&&result.intent.product==='REF-801'&&result.resolved_topic===category,JSON.stringify(result));
      assert(!/price=|confirmed|HK\$/iu.test(result.grounded_question));
    });
  }
}
Deno.test('multiple active entities in the same authoritative topic are ambiguous',()=>{
  const r=resolve('嗰個預約價錢幾多？',[],scope,context([entity('BOOK-101','booking'),entity('BOOK-102','booking')]));
  assert(r.kind==='clarification'&&r.intent.candidates.length===2);
});
for(const status of ['cancelled','deferred','superseded']) Deno.test(`canonical ${status} entity outranks older customer mention`,()=>{
  const c=context([entity('OLD-101','booking',status)]);
  const r=resolve('講返之前嗰個預約，價錢幾多？',[history('OLD-101')],scope,c);
  assert(r.kind==='clarification',JSON.stringify(r));
});
Deno.test('correction uses current replacement, never superseded entity',()=>{
  const c=context([entity('OLD-101','booking','superseded'),entity('NEW-202','booking')]);
  const r=resolve('嗰個預約價錢幾多？',[history('OLD-101')],scope,c);
  assert(r.kind==='resolved'&&r.intent.product==='NEW-202');
});
Deno.test('scoped semantic identity may select one of multiple products',()=>{
  const c=context([entity('ONE-101','equipment'),entity('TWO-202','equipment')]);
  c.semantic={confidence:0.98,topic:'equipment',ambiguity:{is_ambiguous:false},referents:[{ref:'entity:ONE-101',source:'persistent_state',confidence:0.98}]};
  const r=resolve('佢有咩功能？',[],scope,c);
  assert(r.kind==='resolved'&&r.intent.product==='ONE-101');
});
for(const ref of ['INVENTED-909','entity:OLD-101']) Deno.test(`unknown/inactive semantic identity cannot reach KB: ${ref}`,()=>{
  const c=context([entity('OLD-101','equipment','cancelled'),entity('NEW-202','equipment')]);
  c.semantic={confidence:0.98,topic:'equipment',ambiguity:{is_ambiguous:false},referents:[{ref,source:'persistent_state',confidence:0.98}]};
  assert(resolve('佢有咩功能？',[],scope,c).kind==='clarification');
});
Deno.test('unknown explicit topic switch does not inherit the only old entity',()=>{
  const c=context([entity('OLD-101','equipment')],'equipment');
  c.semantic={confidence:0.99,topic:'unseen_service',ambiguity:{is_ambiguous:false},referents:[]};
  assert(resolve('switch to that service, how much is it?',[history('OLD-101')],scope,c).kind==='clarification');
});
for(const key of ['company_id','conversation_id'] as const) Deno.test(`foreign canonical context ${key} denied`,()=>{
  const c=context([entity('ONE-101','equipment')]);c[key]='foreign';
  assert(resolve('佢有咩功能？',[],scope,c).kind==='clarification');
});
for(const key of ['company_id','conversation_id'] as const) Deno.test(`foreign customer history ${key} cannot supply a referent`,()=>{
  const row=history('ONE-101');row[key]='foreign';
  assert(resolve('佢有咩功能？',[row],scope).kind==='clarification');
});
Deno.test('missing scope tags are not accepted as scoped history',()=>{
  assert(resolve('佢有咩功能？',[{role:'visitor',content:'ONE-101'}],scope).kind==='clarification');
});
Deno.test('no global appliance profile or horsepower-derived category',()=>{
  const r=resolve('講返之前嗰部冷氣，幾多匹？',[history('ONE-101'),history('TWO-202')],scope);
  assert(r.kind==='clarification');
});
Deno.test('negated cancellation does not remove the explicit customer identity',()=>{
  const r=resolve('it, how much is it?',[history("do not cancel ONE-101"),history('ONE-101')],scope);
  assert(r.kind==='resolved'&&r.intent.product==='ONE-101');
});
Deno.test('canonical label can represent a service without invented SKU',()=>{
  const e={...entity('','booking'),entity_id:'booking:consultation',model:null,attributes:{name:'Initial consultation'}};
  const c:ProductReferenceContext={...scope,state:{current_topic:'booking',entities:[e]}};
  const r=resolve('it, how much is it?',[],scope,c);
  assert(r.kind==='resolved'&&r.intent.product==='Initial consultation');
});
Deno.test('structured requirements are retained by existing semantic/state paths, not a demo intent flag',()=>{
  const intent=classifyNaturalCustomerIntent('想問設備，兩間房同客廳點揀？');
  assert(intent.kind==='product_guidance');assert(Object.keys(intent).length===2);
});
for (const control of ['If necessary, cancel ONE-101','ONE-101 cancellation policy?','「取消 ONE-101」係引用','假設取消 ONE-101']) Deno.test(`non-action lifecycle text retains identity: ${control}`,()=>{
  const r=resolve('it, how much is it?',[history(control),history('ONE-101')],scope);
  assert(r.kind==='resolved'&&r.intent.product==='ONE-101');
});
Deno.test('explicit history replacement retires the older identifier',()=>{
  const r=resolve('it, how much is it?',[history('replace ONE-101 with TWO-202'),history('ONE-101')],scope);
  assert(r.kind==='resolved'&&r.intent.product==='TWO-202');
});
Deno.test('one valid semantic ref cannot mask an unknown second ref',()=>{
  const c=context([entity('ONE-101','equipment')]);
  c.semantic={confidence:0.99,topic:'equipment',ambiguity:{is_ambiguous:false},referents:[{ref:'ONE-101',source:'prior_turn',confidence:0.99},{ref:'UNKNOWN-404',source:'prior_turn',confidence:0.99}]};
  assert(resolve('it, how much is it?',[],scope,c).kind==='clarification');
});
Deno.test('missing customer-visible identity cannot route an internal entity key to KB',()=>{
  const c=context([{...entity('','equipment'),entity_id:'internal-uuid',model:null}]);
  assert(resolve('it, how much is it?',[],scope,c).kind==='clarification');
});
Deno.test('current supplied clarification identity outranks stale semantic suggestion',()=>{
  const c=context([entity('OLD-101','equipment')]);
  c.semantic={confidence:0.99,topic:'equipment',ambiguity:{is_ambiguous:false},referents:[{ref:'UNKNOWN-404',source:'prior_turn',confidence:0.99}]};
  const rows=[{role:'assistant',content:'Which current product or model do you mean?',...scope},history('it, how much is it?')];
  const r=resolve('NEW-202',rows,scope,c);
  assert(r.kind==='resolved'&&r.intent.product==='NEW-202'&&r.grounded_question.includes('how much'));
});
