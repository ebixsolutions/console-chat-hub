import { readExactMemoryReplyLifecycle } from "../../supabase/functions/_shared/memory-reply-lifecycle-readback.ts";
const assert = (value: unknown) => { if (!value) throw new Error("assertion failed"); };
async function hash(value: string) {
 return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,"0")).join("");
}
const expected={conversation_id:"conversation",company_id:"tenant",source_message_id:"customer",reply_message_id:"reply",parent_revision:1,parent_hash:"a".repeat(64),commerce_state_revision:3,memory:{memory_revision:2},markdown_projection:"projection",reply_content:"grounded answer"};
async function rows() {
 const scoped={conversation_id:expected.conversation_id,company_id:expected.company_id,source_message_id:expected.source_message_id,commerce_state_revision:3};
 return {
  conversation_memory_state:{...scoped,revision:2,memory:expected.memory,markdown_projection:expected.markdown_projection,memory_hash:"b".repeat(64)},
  conversation_memory_state_event:{...scoped,applied_revision:1,memory_hash:expected.parent_hash},
  c3_memory_reply_lifecycle_receipt:{...scoped,reply_message_id:"reply",parent_revision:1,parent_hash:expected.parent_hash,applied_revision:2,memory_hash:"b".repeat(64),markdown_hash:await hash(expected.markdown_projection),reply_content_hash:await hash(expected.reply_content)},
  messages:{id:"reply",conversation_id:"conversation",role:"assistant",content:expected.reply_content,is_recalled:false,metadata:{source_message_id:"customer",b2_source_message_id:"customer",b2_expected_company_id:"tenant",b2_commit_source:"commit_ai_reply_tx",b2_expected_revision:3,control_commit:"ai",b2_gate_contract:"executeB2PersistenceGate:allow_after_revalidation"}},
 };
}
function client(data:any, fault?: (table:string,n:number)=>any) {
 const counts:Record<string,number>={};
 return {from(table:string){const builder:any={select(){return builder;},eq(){return builder;},async maybeSingle(){const n=counts[table]=(counts[table]??0)+1;return fault?.(table,n)??{data:data[table]??null,error:null};}};return builder;}};
}
Deno.test("exact immutable parent + independent reply receipt proves committed",async()=>assert((await readExactMemoryReplyLifecycle(client(await rows()),expected)).status==="committed"));
Deno.test("lost read acknowledgement recovers only exact durable rows",async()=>assert((await readExactMemoryReplyLifecycle(client(await rows(),(_table,n)=>n===1?{data:null,error:{message:"transport"}}:undefined),expected)).status==="committed"));
for(const [name,table,field,value] of [
 ["tenant drift","conversation_memory_state","company_id","other"],
 ["source drift","conversation_memory_state","source_message_id","other"],
 ["revision drift","conversation_memory_state","revision",3],
 ["parent receipt rewritten","conversation_memory_state_event","memory_hash","b".repeat(64)],
 ["receipt parent drift","c3_memory_reply_lifecycle_receipt","parent_revision",2],
 ["receipt state hash drift","c3_memory_reply_lifecycle_receipt","memory_hash","c".repeat(64)],
 ["markdown drift","conversation_memory_state","markdown_projection","changed"],
 ["reply content drift","messages","content","changed"],
 ["receipt reply hash drift","c3_memory_reply_lifecycle_receipt","reply_content_hash","d".repeat(64)],
 ["receipt markdown hash drift","c3_memory_reply_lifecycle_receipt","markdown_hash","d".repeat(64)],
 ["recalled reply","messages","is_recalled",true],
 ["commerce drift","conversation_memory_state_event","commerce_state_revision",4],
 ] as const) Deno.test("negative: "+name,async()=>{const data:any=await rows();data[table][field]=value;assert((await readExactMemoryReplyLifecycle(client(data),expected)).status!=="committed");});
Deno.test("missing independent receipt never becomes success",async()=>{const data:any=await rows();delete data.c3_memory_reply_lifecycle_receipt;assert((await readExactMemoryReplyLifecycle(client(data),expected)).status!=="committed");});
Deno.test("persistent transport error never becomes success",async()=>assert((await readExactMemoryReplyLifecycle(client(await rows(),()=>({data:null,error:{message:"transport"}})),expected)).status!=="committed"));
Deno.test("B2 source mismatch never becomes success",async()=>{const data:any=await rows();data.messages.metadata.b2_source_message_id="other";assert((await readExactMemoryReplyLifecycle(client(data),expected)).status!=="committed");});
