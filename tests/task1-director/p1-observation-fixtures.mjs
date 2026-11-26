/** Observer-only input proposals. Never imported by production.
 * Original visitor messages, must/must_not and 67-case denominator are read-only.
 * An absent proposal must not select the handler fixture's implicit appliance
 * answer, merchant-policy reading, or always-grounded reviewer.
 */
import {createHash} from 'node:crypto';
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const emptyKb=()=>({success:true,context_found:false,selected_documents:[],citations:[],
 llm_context:{summary_count:0,evidence_count:0}});
const subjects={
 retail:{name:'書枱',kind:'physical_product',unit:'張',quantity:3},
 restaurant:{name:'套餐',kind:'service',unit:'份',quantity:3},
 education:{name:'英語課',kind:'service',unit:'課',quantity:3},
 beauty:{name:'美容療程',kind:'service',unit:'堂',quantity:3},
 saas:{name:'licenses',kind:'subscription',unit:'licenses',quantity:3},
 'b2b-wholesale':{name:'paper cups',kind:'b2b_product',unit:'cartons',quantity:120},
};
function typedNodes(value,at=[]){
 const kind=value===null?'null':Array.isArray(value)?'array':typeof value;
 return [{path:at,kind,...(kind==='string'?{text:value}:kind==='number'?{number:value}:kind==='boolean'?{boolean:value}:{})},
  ...((kind==='object'||kind==='array')?Object.entries(value).flatMap(([key,child])=>typedNodes(child,[...at,key])):[])];
}
// Existing accepted compatibility transport, not a new provider contract.
const wire=(delta,operation)=>({context_encoding:'semantic_paths_v2',operation,confidence:.98,nodes:typedNodes(delta)});

export function loadObservationCases(fs,root){
 const path='tests/task1-director/fixtures/task3c-replay/observations-60-plus-7.json';
 const raw=fs.readFileSync(root+'/'+path,'utf8'),spec=JSON.parse(raw),all=[];
 if(spec.case_count!==60||spec.probe_count!==7||spec.source_tier!=='OFFLINE_SCRIPTED_NOT_REAL_MODEL_NOT_REAL_KB_NOT_HOSTED')
  throw Error('observation_manifest_contract_drift');
 for(const entry of spec.original_25_source){
  const pack=JSON.parse(fs.readFileSync(root+'/'+entry.path,'utf8'));
  if(pack.tasks.length!==5||pack.profile.industry!==entry.domain)throw Error('seed_drift:'+entry.domain);
  for(const row of pack.tasks)all.push({id:row.seed_task_id,turns:row.turns,kind:'synthetic',
   domain:entry.domain,seedPath:entry.path,profile:pack.profile,must:row.expected});
 }
 for(const row of spec.b2b)all.push({id:row.id,turns:row.turns,kind:'synthetic_b2b',domain:'b2b-wholesale',must:row.expected});
 for(const row of spec.sourced){
  const turns=[...row.turns.matchAll(/[①②③④⑤⑥⑦⑧⑨]\s*(?:「([^」]+)」|"([^"]+)")/gu)].map(match=>match[1]??match[2]);
  all.push({...row,turns:turns.length?turns:[row.turns],kind:'sourced_synthetic_kb',
   original_turns:row.turns});
 }
 if(all.length!==60||new Set(all.map(row=>row.id)).size!==60||spec.probes.length!==7||new Set(spec.probes.map(row=>row.id)).size!==7)
  throw Error('observation_case_count_mismatch');
 const rows=[...all,...spec.probes.map(probe=>({...probe,kind:'probe'}))];
 return {rows,manifest_sha256:digest(raw),case_ids_sha256:digest(rows.map(row=>row.id))};
}

// R2 correction/cancel/defer family. Independently transcribed from the six
// original Visitor journeys, never from must/expected. The inactive clause is
// carried as source evidence, not as an invented second entity or committed
// status. Only the unchanged handler can accept or reject the proposal.
const correctionReadings=Object.freeze({
 "SYNTHETIC-retail-correction": {
  "change": "更正，只保留兩張書枱，第三張暫時取消。",
  "count": "兩張",
  "value": 2,
  "inactive": "第三張暫時取消",
  "question": "現在保留幾張書枱？哪一張取消了？"
 },
 "SYNTHETIC-restaurant-correction": {
  "change": "更正，只保留兩份套餐，第三份取消。",
  "count": "兩份",
  "value": 2,
  "inactive": "第三份取消",
  "question": "現在保留幾份套餐？取消了哪一份？"
 },
 "SYNTHETIC-education-correction": {
  "change": "更正，只保留兩課，第三課延後再談。",
  "count": "兩課",
  "value": 2,
  "inactive": "第三課延後再談",
  "question": "我現在保留幾課？哪課只是未來討論？"
 },
 "SYNTHETIC-beauty-correction": {
  "change": "更正，只保留兩堂療程，第三堂暫緩。",
  "count": "兩堂",
  "value": 2,
  "inactive": "第三堂暫緩",
  "question": "目前保留幾堂？哪一堂暫緩？"
 },
 "SYNTHETIC-saas-correction": {
  "change": "Correction: keep two licenses; postpone the third.",
  "count": "two licenses",
  "value": 2,
  "inactive": "postpone the third",
  "question": "How many licenses are currently retained, and what was postponed?"
 },
 "SYNTHETIC-b2b-wholesale-correction": {
  "change": "Correction: keep 60 cartons under review and postpone the other 60 cartons.",
  "count": "60 cartons under review",
  "value": 60,
  "inactive": "postpone the other 60 cartons",
  "question": "How many cartons remain under review, and how many are postponed?"
 }
});
export const hasCorrectionReading=row=>Object.hasOwn(correctionReadings,row.id);
function correctionReading(row,turn,subject,language,wrong=false){
 const fixed=correctionReadings[row.id],text=row.turns[turn];
 if(!fixed||turn!==1&&turn!==2)return null;
 if(!subject||row.turns[1]!==fixed.change||row.turns[2]!==fixed.question||
    !row.turns[0].includes(subject.name)||!row.turns[0].includes(subject.unit)||
    !fixed.change.includes(fixed.count)||!fixed.change.includes(fixed.inactive))
  throw Error('observer_correction_reading_source_drift:'+row.id);
 const prior={ref:subject.name,source:'prior_turn',confidence:.98};
 const proof={status:wrong?'WRONG_READING_NEGATIVE':'SCRIPTED_PROPOSAL',
  source_quote:text,prior_subject_quote:row.turns[0],
  coverage:wrong?(turn===1?'INTENTIONAL_WRONG_QUANTITY':'INTENTIONAL_WRONG_REFERENT'):
   turn===1?'SOURCE_EXPLICIT_RETAINED_COUNT_AND_INACTIVE_CLAUSE':'CURRENT_AND_INACTIVE_READ_ONLY_REQUEST'};
 if(turn===1)return {...proof,retained_count_quote:fixed.count,inactive_clause_quote:fixed.inactive,
  semantic:wire({language,intent:'customer_correction',customer_correction:true,
   requested_facts:[],referents:[prior],
   entities:[{name:subject.name,kind:subject.kind,unit:subject.unit,quantity:wrong?99999:fixed.value,confidence:.98}]},
   'SET_QUANTITY')};
 // Ask for both current quantity and the inactive member/status without
 // providing either expected value or any answer/merchant evidence.
 const selected=wrong?{...prior,ref:'__P1_WRONG_SUBJECT__'}:prior;
 // Bind the complete original compound question in the same accepted general
 // demand shape as the real provider contract. No expected values are supplied.
 return {...proof,semantic:wire({language,intent:'customer_fact_recall',
  requested_facts:['quantity','entity_status'],referents:[selected],
  demands:[{question:text,source_quote:text,subject_refs:[selected.ref],source_type:'general',
   requested_facts:['quantity','entity_status'],constraints:{},customer_correction:false,
   explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}]},
  'ASK_FACT')};
}

// R2 original mixed-known/unknown source proposals, not production rules.
const mixedReadings=Object.freeze({
  "SYNTHETIC-retail-mixed-known-unknown": [
    "我只記得以前有人說每張港幣700元，這是舊資料。",
    "我之前提過幾張書枱？另外目前每張官方售價是多少？",
    700,
    "HKD",
    "書枱",
    "我之前提過幾張書枱？",
    "另外目前每張官方售價是多少？"
  ],
  "SYNTHETIC-restaurant-mixed-known-unknown": [
    "我記得去年套餐好像港幣180元，但現在未核實。",
    "我之前提過幾份套餐？今天每份官方售價是多少？",
    180,
    "HKD",
    "套餐",
    "我之前提過幾份套餐？",
    "今天每份官方售價是多少？"
  ],
  "SYNTHETIC-education-mixed-known-unknown": [
    "我記得以前每課港幣200元，但不知道現在是否仍適用。",
    "我之前提過幾課英語課？現在每課學費是多少？",
    200,
    "HKD",
    "英語課",
    "我之前提過幾課英語課？",
    "現在每課學費是多少？"
  ],
  "SYNTHETIC-beauty-mixed-known-unknown": [
    "朋友以前說每堂港幣500元，但這只是舊口頭資料。",
    "我之前提過幾堂療程？現在每堂售價是多少？",
    500,
    "HKD",
    "美容療程",
    "我之前提過幾堂療程？",
    "現在每堂售價是多少？"
  ],
  "SYNTHETIC-saas-mixed-known-unknown": [
    "I recall an old verbal price of USD 12 per license, but it was not verified.",
    "How many licenses did I mention earlier, and what is their current official price?",
    12,
    "USD",
    "licenses",
    "How many licenses did I mention earlier",
    "what is their current official price?"
  ],
  "SYNTHETIC-b2b-wholesale-mixed-known-unknown": [
    "Someone mentioned USD 4.20 per carton last year; that was an unverified historical figure.",
    "How many cartons did I mention, and what is the current official wholesale price?",
    4.2,
    "USD",
    "paper cups",
    "How many cartons did I mention",
    "what is the current official wholesale price?"
  ]
});
function mixedReading(row,turn,language){
 const item=mixedReadings[row.id]; if(!item||turn!==1&&turn!==2)return null;
 const [historical,question,amount,unit,name,quantityClause,priceClause]=item;
 if(row.turns[1]!==historical||row.turns[2]!==question||!row.turns[0].includes(name)||!question.includes(quantityClause)||!question.includes(priceClause))throw Error('observer_mixed_source_drift:'+row.id);
 const referents=[{ref:name,source:'prior_turn',confidence:.98}];
 const demand=(q,type,field)=>({question:q,source_quote:q,subject_refs:[name],source_type:type,requested_facts:[field],constraints:{},customer_correction:false,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}});
 return turn===1?{semantic:wire({language,intent:'customer_context_update',customer_facts:[{key:'historical_price',value:{amount,unit}},{key:'historical_price_report',value:historical}],referents,requested_facts:[]},'UPDATE_ITEM'),status:'SCRIPTED_PROPOSAL',source_quote:historical,coverage:'ATTRIBUTED_HISTORICAL_PRICE_NOT_CURRENT'}:
 {semantic:wire({language,intent:'mixed_customer_and_merchant_facts',referents,requested_facts:['quantity','price'],demands:[demand(quantityClause,'general','quantity'),demand(priceClause,'product','price')]},'ASK_FACT'),status:'SCRIPTED_PROPOSAL',source_quote:question,coverage:'INDEPENDENT_CUSTOMER_QUANTITY_AND_CURRENT_MERCHANT_PRICE'};
}

function proposedReading(row,turn,wrong=false){
 const text=row.turns[turn],language=row.domain==='saas'||row.domain==='b2b-wholesale'?'en':'zh-TW';
 if(row.kind==='probe')return {semantic:{operation:row.reading.operation,intent:row.reading.intent,confidence:.98,
  entities:[{name:row.reading.name,kind:row.reading.kind,quantity:row.reading.quantity,confidence:.98}],
  customer_facts:row.reading.facts??[],requested_facts:[]},status:'ORIGINAL_SCRIPTED_PROBE',
  source_quote:text,coverage:'ORIGINAL_PROBE_READING_UNCHANGED'};
 const humanTurn={'RT-05':1,'ED-05':2,'SA-05':2}[row.id];
 if(humanTurn===turn)return {semantic:wire({language:'zh-TW',intent:'request_human_now',requested_facts:[]},'NO_STATE_CHANGE'),
  status:'SCRIPTED_PROPOSAL',source_quote:text,coverage:'CURRENT_EXPLICIT_HUMAN_REQUEST'};
 const subject=subjects[row.domain];
 if(hasCorrectionReading(row)&&turn>0)return correctionReading(row,turn,subject,language,wrong);
 if(wrong)throw Error('observer_wrong_reading_outside_named_family:'+row.id);
 const mixed=mixedReading(row,turn,language);if(mixed)return mixed;
 if(subject&&turn===0&&['-recall','-correction','-mixed-known-unknown'].some(suffix=>row.id.endsWith(suffix))){
  // These fixed proposals are separate from the original visitor corpus. Each
  // entity name/unit is checked against the exact current source before use.
  if(!text.includes(subject.name)||!text.includes(subject.unit))throw Error('observer_reading_source_drift:'+row.id);
  return {semantic:wire({language,intent:'customer_context_update',requested_facts:[],
   entities:[{...subject,confidence:.98}]},'ADD_ITEM'),status:'SCRIPTED_PROPOSAL',source_quote:text,
   coverage:'EXPLICIT_INITIAL_CUSTOMER_QUANTITY'};
 }
 if(subject&&row.id.endsWith('-recall')&&turn===1)return {
  semantic:wire({language,intent:'customer_fact_recall',requested_facts:['quantity'],
   referents:[{ref:subject.name,source:'prior_turn',confidence:.98}]},'ASK_FACT'),
  status:'SCRIPTED_PROPOSAL',source_quote:text,coverage:'READ_ONLY_QUANTITY_SELECTION',
  prior_subject_quote:row.turns[0]};
 if(subject&&row.id.endsWith('-merchant-topic'))return {
  semantic:wire({language,intent:'merchant_policy',requested_facts:[text],
   demands:[{question:text,source_quote:text,subject_refs:[],source_type:'policy',requested_facts:[text],
    constraints:{},customer_correction:false,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}]},'ASK_FACT'),
  status:'SCRIPTED_PROPOSAL',source_quote:text,coverage:'CURRENT_MERCHANT_QUESTION'};
 return {status:'NOT_SUPPLIED',source_quote:text,coverage:'NONE',
  reason:'No complete independently authored reading for this exact turn; no generic ASK_FACT substitute.'};
}

function caseKb(row,fs,root){
 if(row.seedPath){
  const path=row.seedPath.replace(/tasks\.json$/u,'knowledge.txt'),raw=fs.readFileSync(root+'/'+path,'utf8');
  const start=raw.indexOf('{');
  if(start<0)throw Error('observer_seed_kb_missing:'+row.id);
  const response=JSON.parse(raw.slice(start));
  if(!response.selected_documents?.length)throw Error('observer_seed_kb_documents_missing:'+row.id);
  const rebinding=[];
  for(const document of response.selected_documents){
   if(document.authority?.tenant_id!==row.profile.kb_tenant_id)throw Error('observer_seed_kb_tenant_drift:'+row.id);
   rebinding.push({document_id:document.document_id,from_tenant:document.authority.tenant_id,to_tenant:'34'});
   // Synthetic transport identity only. Do not change document/chunk IDs,
   // published/currentness fields, source text, or production authorization.
   document.authority.tenant_id='34';
  }
  return {response,proof:{status:'ORIGINAL_SYNTHETIC_SEED',source_path:path,source_sha256:digest(raw),
   response_sha256:digest(response),transport_rebinding:rebinding,
   document_ids:response.selected_documents.map(document=>document.document_id),
   chunk_ids:response.selected_documents.flatMap(document=>document.evidence.map(chunk=>chunk.chunk_id))}};
 }
 return {response:emptyKb(),proof:{status:row.kind==='probe'?'EMPTY_NO_MERCHANT_EVIDENCE':'KB_FIXTURE_MISSING',
  reason:row.kind==='probe'?'Original probe contains no merchant document.':
   'Referenced case-specific synthetic KB content is not supplied in this repository; no rule is inferred from the oracle.',
  response_sha256:digest(emptyKb()),document_ids:[],chunk_ids:[]}};
}

export function buildTurnInput(row,turn,mode,fs,root){
 const proposed=mode==='scripted'||mode==='wrong_reading'?proposedReading(row,turn,mode==='wrong_reading'):{
  status:'MISSING_READING_NEGATIVE',coverage:'EMPTY_PROVIDER_READING',source_quote:row.turns[turn]};
 const kb=caseKb(row,fs,root);
 const reading={...proposed,semantic_sha256:proposed.semantic?digest(proposed.semantic):null};
 delete reading.semantic;
 return {options:{originalPreview:true,fullChain:true,captureEvidence:true,handoffSetsHumanControl:true,
  // Passing originalRagResponse selects the EXISTING isolated preview permit.
  originalRagResponse:kb.response,
  ...(proposed.semantic?{semantic:proposed.semantic}:{semanticRaw:''}),
  answer:'',verifierGrounded:false,verifierIds:[],verifierResolution:'unsupported'},
  proof:{reading,kb:kb.proof,generation:{status:'NOT_SUPPLIED',
   reason:'No model draft/reviewer fixture is supplied; empty draft and rejecting reviewer suppress hidden default answers.'}}};
}
