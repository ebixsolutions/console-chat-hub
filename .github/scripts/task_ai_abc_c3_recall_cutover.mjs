/** One-use, source-pinned C3 implementation on PR #12. Never connects to production. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
const BASE='e7b9dd06b60192f3536f7e1e0bd7feddd600e071';
const MAIN='1f2d285c6ad2d406cdccee2de7fbf74547920e77';
const BRANCH='director/ai-abc-c3-long-memory-final-cutover';
const SELF='.github/scripts/task_ai_abc_c3_recall_cutover.mjs';
const dir='supabase/functions/_shared/';
const run=(c,a,options={})=>execFileSync(c,a,{stdio:'inherit',...options});
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const must=(ok,msg)=>{if(!ok)throw new Error(msg);};
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const before=git('rev-parse','HEAD');
must(process.env.GITHUB_EVENT_NAME==='push' && process.env.GITHUB_REF===`refs/heads/${BRANCH}`,'wrong_event_or_branch');
must(process.env.GITHUB_SHA===before,'checkout_sha_drift');
must(git('rev-parse','origin/main')===MAIN,'main_drift');
run('git',['merge-base','--is-ancestor',BASE,before]);
const expected={
 'supabase/functions/generate-reply/index.ts':'5b5346bb0c0becb99b5a1b89929c4a83d062fe50',
 'supabase/functions/agent-assist/index.ts':'bed127fd948a5b9afbc37b48d699a95c6251c2d9',
 [dir+'conversation-long-memory.ts']:'881c54983f878f9c3442af2aa04bfa3d6cb9f623',
 '.github/scripts/task_ai_abc_c3_final_gate.mjs':'e3057bec561ab6431d59d02c6bace8d53226ae06',
};
for(const [p,h] of Object.entries(expected))must(git('hash-object',p)===h,`source_precondition:${p}`);
const PAYLOAD_FILES=['.github/scripts/c3-recall-payload-1.txt','.github/scripts/c3-recall-payload-2.txt','.github/scripts/c3-recall-payload-3.txt','.github/scripts/c3-recall-payload-4.txt','.github/scripts/c3-recall-payload-5.txt'];
// Normalize two known transport transcription errors; decoded bytes remain SHA256 pinned.
const transport=PAYLOAD_FILES.map((p,i)=>{
  let text=fs.readFileSync(p,'utf8');
  if(i===0 && git('hash-object',p)==='883a70f44a352de5575d94ea3d409b897001f0dc') text=text.replace('vLZJJjk','vLZJjk');
  if(i===1 && git('hash-object',p)==='927597240839d203aefa839307d5ac302ec504c0') text=text.replace('b5w0h382','b5w8h382');
  return text;
}).join('');
const packed=Buffer.from(transport,'base64');
must(sha(packed)==='620a7210d0a9e066f9c1c1b233feda51109da701087145e308ca514629e6a573','implementation_payload_corrupt');
const newFiles=JSON.parse(inflateSync(packed).toString('utf8'));
const allowedNew=[dir+'conversation-recall.ts',dir+'conversation-recall.test.ts',dir+'conversation-recall.integration.test.ts'];
must(JSON.stringify(Object.keys(newFiles).sort())===JSON.stringify(allowedNew.sort()),'payload_path_boundary');
for(const [p,s] of Object.entries(newFiles)){must(typeof s==='string' && !fs.existsSync(p),`new_file_precondition:${p}`);fs.writeFileSync(p,s);}
function once(s,from,to){must(s.split(from).length===2,`patch_anchor_mismatch:${from.slice(0,80)}`);return s.replace(from,to);}
let p='supabase/functions/generate-reply/index.ts',s=fs.readFileSync(p,'utf8');
s=once(s,'  resolveStructuredMemoryResponse,\n','');
s='import { prepareConversationRecall, type RecallCommerceSnapshot } from "../_shared/conversation-recall.ts";\n'+s;
s=once(s,'  let _c3MemoryContext = "";','  let _c3MemoryContext = "";\n  let _c3CommerceSnapshot: RecallCommerceSnapshot | null = null;');
s=once(s,'supabaseAdmin.from("conversation_commerce_state")\n            .select("revision,state")','supabaseAdmin.from("conversation_commerce_state")\n            .select("conversation_id,company_id,source_message_id,revision,state")');
s=once(s,'      const memoryOutcome = await refreshConversationLongMemory(',`      if (commerceState) {
        _c3CommerceSnapshot = {
          conversation_id: String(commerceRow.conversation_id),
          company_id: String(commerceRow.company_id),
          source_message_id: String(commerceRow.source_message_id ?? ""),
          revision: Number(commerceRow.revision),
          state: commerceState,
        };
      }
      const memoryOutcome = await refreshConversationLongMemory(`);
const recallBlock=`  // C3 fact ownership routing: after E2/A3 and durable memory, before commerce
  // reply shortcuts, context clarification and current-KB/C1 resolution.
  const _c3Recall = prepareConversationRecall({
    conversation_id,
    company_id: _criticalE2ExpectedTenantId ?? "",
    source_message_id: _h1SourceMessageId,
    question: _h1LastMsg,
    memory: _c3Memory,
    commerce: _c3CommerceSnapshot,
    explicit_handoff: isHandoffIntent(_h1LastMsg),
    referents: _a3SemanticFrame?.referents ?? [],
    recent_questions: ((_pr5HistoryRows ?? []) as MemoryHistoryRow[])
      .filter(row => row.role === "visitor" && row.id !== _h1SourceMessageId)
      .slice(0, 12).map(row => String(row.content ?? "")),
  }, _visitorLang);
  if (_c3Recall.reply) {
    const recallCommit = await commitAiReplyWithControlGate(
      supabaseAdmin, conversation_id, _h1SourceMessageId,
      _c3Recall.reply, _c3Recall.metadata,
    );
    await cleanupThinking(supabaseAdmin, conversation_id, _h1SourceMessageId);
    if (recallCommit.ok) {
      return new Response(JSON.stringify({
        success: true, reply: _c3Recall.reply,
        response_route: _c3Recall.metadata.response_route,
        recall_authority: _c3Recall.metadata.recall_authority,
        recall_fact_type: _c3Recall.metadata.recall_fact_type,
        handoff_required: false, idempotent: recallCommit.idempotent,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (["human_control", "resolved", "superseded_source", "source_already_replied"].includes(recallCommit.result)) {
      return new Response(JSON.stringify({ success: true, skipped: recallCommit.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({success: false,
      error: \`conversation_memory_commit_\${recallCommit.result}\`}),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
`;
s=once(s,'  if (_a3Commerce && _a3Commerce.reply) {',recallBlock+'  if (_a3Commerce && _a3Commerce.reply) {');
s=once(s,`  const _conversationMemoryReply = resolveStructuredMemoryResponse(
    _h1LastMsg,
    _c3Memory,
  ) ?? resolveConversationMemoryResponse(_h1LastMsg, _pr5HistoryRows ?? []);`,`  const _conversationMemoryReply = !_c3Recall.decision.handled &&
      _c3Recall.decision.reason === "NOT_A_RECALL_QUERY" &&
      _c3Recall.decision.detail !== "HANDOFF_PRECEDENCE"
    ? resolveConversationMemoryResponse(_h1LastMsg, _pr5HistoryRows ?? [])
    : null;`);
fs.writeFileSync(p,s);
p=dir+'conversation-long-memory.ts';s=fs.readFileSync(p,'utf8');
s='import { resolveConversationRecall, renderConversationRecall } from "./conversation-recall.ts";\n'+s;
const start=s.indexOf('export function resolveStructuredMemoryResponse('),end=s.indexOf('export function buildBoundedConversationContext(',start);
must(start>=0&&end>start,'legacy_recall_adapter_boundary');
s=s.slice(0,start)+`/** Compatibility API; all classification and selection live in one resolver. */
export function resolveStructuredMemoryResponse(latestInput: string, memory: CanonicalConversationMemory | null): string | null {
  if (!memory) return null;
  const decision = resolveConversationRecall({
    question: latestInput, memory, commerce: null,
    conversation_id: memory.conversation_id, company_id: memory.company_id,
    source_message_id: memory.source_message_id,
  });
  return renderConversationRecall(decision, /[\\u4e00-\\u9fff]/.test(latestInput) ? "zh-TW" : "en");
}

`+s.slice(end);
s=once(s,'Canonical structured conversation memory (derived; lower authority than commerce state and current KB):','Canonical structured conversation memory (customer-owned facts: canonical commerce, latest valid correction, current customer memory; external business facts still require current published KB):');
fs.writeFileSync(p,s);
p='supabase/functions/agent-assist/index.ts';s=fs.readFileSync(p,'utf8');
s='import { prepareConversationRecall, type RecallCommerceSnapshot } from "../_shared/conversation-recall.ts";\nimport { isConversationCommerceState } from "../_shared/commerce-state-contract.ts";\n'+s;
const assist=`  // Draft-only recall uses the same tenant/source-bound resolver as generation.
  // C2 persisted handoff, translation, grammar and authorization remain above.
  if(toolType==="suggest_reply" && body.context_mode!=="manual" && conv.company_id){
    const {data:recallHistory,error:recallHistoryError}=await supabaseAdmin.from("messages")
      .select("id,role,content,created_at").eq("conversation_id",conversationId)
      .eq("is_recalled",false).neq("content","__THINKING__")
      .order("created_at",{ascending:false}).order("id",{ascending:false}).limit(24);
    const recallSource=(recallHistory??[]).find((row:any)=>row.role==="visitor");
    if(!recallHistoryError && recallSource){
      const {data:recallCommerce,error:recallCommerceError}=await supabaseAdmin.from("conversation_commerce_state")
        .select("conversation_id,company_id,source_message_id,revision,state")
        .eq("conversation_id",conversationId).eq("company_id",conv.company_id).maybeSingle();
      const recallSnapshot:RecallCommerceSnapshot|null=!recallCommerceError && isConversationCommerceState(recallCommerce?.state)?{
        conversation_id:String(recallCommerce.conversation_id),company_id:String(recallCommerce.company_id),
        source_message_id:String(recallCommerce.source_message_id??""),revision:Number(recallCommerce.revision),state:recallCommerce.state,
      }:null;
      const recallRoute = prepareConversationRecall({
        question:content,conversation_id:conversationId,company_id:conv.company_id,
        source_message_id:String(recallSource.id),memory:c3Memory,commerce:recallSnapshot,
        recent_questions:(recallHistory??[]).filter((row:any)=>row.role==="visitor").slice(0,12).map((row:any)=>String(row.content??"")),
      },/[\\u4e00-\\u9fff]/.test(content)?"zh-TW":"en");
      if(recallRoute.reply)return jsonRes({success:true,tool_type:"suggest_reply",draft_only:true,
        knowledge_grounded:false,scope_mode:scope.mode,selected_document_id:null,
        response_route:recallRoute.metadata.response_route,recall_authority:recallRoute.metadata.recall_authority,
        result:{suggestions:[{content:recallRoute.reply,tone_label:"Informative"}]}},200,req);
    }
  }
`;
s=once(s,'  const kbPrefix=',assist+'  const kbPrefix=');fs.writeFileSync(p,s);
p='.github/scripts/task_ai_abc_c3_final_gate.mjs';s=fs.readFileSync(p,'utf8');
s=once(s,'const files = {',`const files = {
  recall: "${dir}conversation-recall.ts",
  recallUnit: "${dir}conversation-recall.test.ts",
  recallIntegration: "${dir}conversation-recall.integration.test.ts",`);
s=once(s,'"resolveStructuredMemoryResponse(",','"prepareConversationRecall(",');
s=once(s,'runDeno(["test", "--no-lock", "--allow-read", files.integration]);','runDeno(["test", "--no-lock", "--allow-read", files.integration, files.recallIntegration]);');
s=once(s,'  files.memory,\n  files.terminalGuard,','  files.memory,\n  files.recall,\n  files.terminalGuard,');
s=once(s,'  files.memory,\n  files.unit,','  files.memory,\n  files.recall,\n  files.recallUnit,\n  files.recallIntegration,\n  files.unit,');fs.writeFileSync(p,s);
// Restore no other existing file; DB schema, migration, ACL, terminal and B2 stay byte-identical.
fs.unlinkSync(SELF);
for(const p of PAYLOAD_FILES)fs.unlinkSync(p);
const changed=[...Object.keys(expected),...allowedNew];
run('npx',['--yes','deno','fmt',...allowedNew]);
run('git',['add','--',...changed,SELF,...PAYLOAD_FILES]);
run('git',['-c','user.name=AI ABC C3 Director','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','commit','-m','fix(c3): resolve customer-owned recall before current KB']);
const candidate=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');
const reportDir=path.join(process.env.RUNNER_TEMP,'c3-recall-report');fs.mkdirSync(reportDir,{recursive:true});
const migration='supabase/migrations/20260915040000_ai_abc_c3_director_runtime_closure.sql';
const migrationText=fs.readFileSync(migration,'utf8');
must(sha(migrationText)==='45f1f03ec1face1bb83b54fd9a5abf22522311180922aa096779429690874692','migration_changed');
const report={task:'AI-ABC-C3',pr:12,production_attempted:false,original_head:BASE,staging_head:before,candidate_head:candidate,candidate_tree:tree,main:MAIN,status:'RUNNING_PREPRODUCTION',migration_sha256:sha(migrationText),migration_body_sha256:sha(migrationText.split('\n').slice(3).join('\n')),files:changed.map(p=>({path:p,sha256:sha(fs.readFileSync(p)),git_blob:git('hash-object',p)}))};
function relativeSourceClosure(entry){
 const seen=new Map();const external=new Set();
 const visit=p=>{
  if(seen.has(p))return;
  const source=fs.readFileSync(p,'utf8');seen.set(p,{path:p,sha256:sha(source),git_blob:git('hash-object',p)});
  for(const m of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g)){
   if(m[1].startsWith('.'))visit(path.posix.normalize(path.posix.join(path.posix.dirname(p),m[1])));
   else external.add(m[1]);
  }
 };
 visit(entry);
 const files=[...seen.values()].sort((a,b)=>a.path.localeCompare(b.path));
 return {entrypoint:entry,file_count:files.length,manifest_sha256:sha(JSON.stringify(files)),files,external_imports:[...external].sort()};
}
report.relative_import_closures=[relativeSourceClosure('supabase/functions/generate-reply/index.ts'),relativeSourceClosure('supabase/functions/agent-assist/index.ts')];
const save=()=>fs.writeFileSync(path.join(reportDir,'C3_RECALL_REPORT.json'),JSON.stringify(report,null,2));
save();
try{
 run('node',['.github/scripts/task_ai_abc_c3_final_gate.mjs']);
 report.status='PASS_PREPRODUCTION_PRODUCTION_NOT_RETESTED';
 const remote=git('ls-remote','origin',`refs/heads/${BRANCH}`).split(/\s/)[0];
 must(remote===before,'branch_changed_before_publish');
 must(git('rev-parse','origin/main')===MAIN,'main_changed_before_publish');
 run('git',['push','origin',`HEAD:refs/heads/${BRANCH}`]);
 report.published=true;save();console.log('C3_CANDIDATE_PUBLISHED '+JSON.stringify(report));
}catch(e){report.status='FAIL_PREPRODUCTION';report.error=String(e.message);save();throw e;}
