import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
export const APPLICATION_HEAD = 'b0c76120537b53b5c9172cc81a3bad1c4060621b';
export const APPLICATION_TREE = '57a7178fb558ef4cd925df78370a41d550dcb5f9';
export const VALIDATION_FILES = [
  '.github/scripts/phase1_console_final_gate.mjs',
  '.github/scripts/phase1_human_control_evidence.mjs',
  '.github/scripts/c3_director_candidate_scope.json',
  '.github/workflows/task-ai-abc-c3-final-gate.yml',
  'tests/phase1/human-control-evidence.test.mjs',
  'tests/phase1/customer-control-collector.cjs',
].sort();
const must = (v, label) => assert.ok(v, label);
const instant = v => { const n=Date.parse(v); must(Number.isFinite(n),'valid observation timestamp'); return n; };
function scope(s, ids, project) {
  must(s.project_id===project && s.conversation.id===ids.conversation && s.conversation.company_id===ids.company,'human-control snapshot tenant/project binding');
  must(s.conversation.visitor_session_id===ids.visitor_session && s.conversation.channel_config_id===ids.channel,'legal retained visitor/channel scope');
  must(['pending','transferred','unresolved'].includes(s.conversation.status) && s.conversation.assigned_agent_id===ids.agent,'assigned human control');
  must(s.queue.length===1 && s.queue[0].state==='assigned' && s.queue[0].company_id===ids.company && s.queue[0].assigned_agent_id===ids.agent,'assigned queue tenant/agent');
  must(s.assignment.filter(a=>a.is_active).length===1 && s.assignment.some(a=>a.is_active && a.agent_id===ids.agent && a.conversation_id===ids.conversation),'one legitimate active assignment');
  must(new Set(s.messages.map(m=>m.id)).size===s.messages.length,'unique canonical message rows');
  must(!s.messages.some(m=>m.content==='__THINKING__' || m.role==='assistant' && ['sending','pending','generating'].includes(m.status)),'no thinking or pending AI reply');
}
function receiptScope(r, ids, project) {
  must(r && r.observation_status==='CAPTURED' && r.body!==null && r.status===200 && r.body?.success===true,'captured successful HTTP receipt required');
  must(r.project_id===project && r.company_id===ids.company && r.conversation_id===ids.conversation,'receipt project/tenant/conversation binding');
  must(r.application_head===APPLICATION_HEAD && r.application_tree===APPLICATION_TREE,'receipt application identity');
  must(r.request_identity && (r.request_identity.client_message_id || r.request_identity.response_request_id || r.request_identity.message_id===r.message_id),'actual request/message identity');
  must(r.endpoint===`https://${project}.supabase.co/functions/v1/${r.kind==='widget_ingress_human_control'?'receive-widget-message':r.kind==='direct_generate_human_guard'?'generate-reply':'INVALID'}`,'receipt endpoint matches evidence kind');
}
export function verifySuppression({receipt:r,before,after,ids,project}) {
  receiptScope(r,ids,project);
  for(const s of [before,after]) scope(s,ids,project);
  must(before.capture_kind==='BEFORE_PROBE' && after.capture_kind==='AFTER_PROBE','real before/after probe captures required');
  must(instant(before.captured_at)<instant(r.started_at) && instant(r.started_at)<=instant(r.observed_at) && instant(r.observed_at)<=instant(after.captured_at),'probe capture chronology');
  if(r.kind==='widget_ingress_human_control') {
    must(r.body.data?.message_id===r.message_id && r.body.data.ai_reply_pending===false && r.body.data.control_state==='human_control','widget ingress human-control decision');
  } else if(r.kind==='direct_generate_human_guard') {
    must(r.body.skipped==='human_handling' && r.request_identity.source_message_id===r.message_id,'direct generator human guard decision');
  } else must(false,'supported human-control evidence kind');
  const rows=after.messages.filter(m=>m.id===r.message_id && m.role==='visitor');
  must(rows.length===1 && rows[0].content===r.content,'exact visitor canonical row/content');
  if(r.kind==='widget_ingress_human_control') {
    must(!before.messages.some(m=>m.id===r.message_id),'probe visitor absent before send');
    const oldIds=new Set(before.messages.map(m=>m.id));
    must(after.messages.filter(m=>!oldIds.has(m.id)).length===1,'exactly one supplemental visitor, no other new messages');
    must(before.messages.every(m=>after.messages.some(x=>isDeepStrictEqual(x,m))),'pre-existing messages preserved');
    if(r.request_identity.client_message_id) must(rows[0].metadata?.client_message_id===r.request_identity.client_message_id,'client request identity persisted');
  } else must(isDeepStrictEqual(before.messages,after.messages),'direct guard cannot create or change messages');
  must(isDeepStrictEqual(before.commerce,after.commerce),'exact canonical Commerce state/revision/hash/source lineage unchanged');
  must(isDeepStrictEqual(before.messages.filter(m=>m.role==='assistant'),after.messages.filter(m=>m.role==='assistant')),'no new or changed assistant during probe');
  return true;
}
export function verifyDelivery({receipt:r,snapshot:s,ids,project,ui}) {
  must(r && r.observation_status==='CAPTURED' && r.body!==null && r.status===200 && r.body?.success===true,'captured customer polling receipt required');
  must(r.endpoint===`https://${project}.supabase.co/functions/v1/widget-poll-messages` && r.project_id===project && r.conversation_id===ids.conversation && r.company_id===ids.company,'polling endpoint/project/tenant/conversation binding');
  must(r.application_head===APPLICATION_HEAD && r.application_tree===APPLICATION_TREE,'polling application identity');
  instant(r.observed_at); scope(s,ids,project);
  must(r.body.data?.ai_generating===false && r.body.data.human_support?.state==='assigned' && r.body.data.human_support.agent_assigned===true,'polling assigned human control and no generation');
  const canonical=s.messages.filter(m=>m.id===ids.human_reply && m.role==='agent' && m.sender_id===ids.agent);
  must(canonical.length===1 && canonical[0].metadata?.control_commit==='human','one canonical legitimate human reply');
  must(s.messages.filter(m=>m.role==='agent' && m.content===canonical[0].content).length===1,'human content canonical once');
  const polled=r.body.data.messages.filter(m=>m.id===ids.human_reply);
  must(polled.length===1 && polled[0].role==='agent' && polled[0].content===canonical[0].content,'customer poll target message exactly once');
  must(ui?.customer_received?.observed===true && ui.customer_received.evidence_path && ui.customer_received.message_id===ids.human_reply && ui.customer_received.content===canonical[0].content && ui.customer_received.displayed_bubble_count===1,'actual customer UI delivery binding remains required');
  const visitor=s.messages.find(m=>m.id===ids.original_suppressed_visitor);
  must(visitor && !s.messages.some(m=>m.role==='assistant' && instant(m.created_at)>instant(visitor.created_at)),'no AI after original suppressed visitor');
  return true;
}
export function verifyHistoricalControl({waiting,current,ids,project,ui}) {
  must(waiting.capture_kind==='HISTORICAL_WAITING_SNAPSHOT' && current.capture_kind==='POST_COMPLETION_READBACK','historical and post-completion sources distinguished');
  scope(current,ids,project);
  must(waiting.conversation.id===ids.conversation && waiting.conversation.company_id===ids.company && waiting.project_id===project,'waiting baseline binding');
  must(instant(waiting.captured_at)<instant(current.captured_at),'waiting baseline predates readback');
  must(isDeepStrictEqual(waiting.commerce,current.commerce),'original UI exact Commerce preservation against genuine waiting baseline');
  must(isDeepStrictEqual(waiting.messages.filter(m=>m.role==='assistant'),current.messages.filter(m=>m.role==='assistant')),'original UI assistant rows unchanged');
  must(current.messages.filter(m=>m.id===ids.original_suppressed_visitor && m.role==='visitor').length===1,'original visitor canonical exactly once');
  for(const key of ['login','customer_chat','summary_visible','generic_summary_visible','takeover_clicked','human_reply_sent','customer_received'])
    must(ui?.[key]?.observed===true && ui[key].evidence_path,'actual UI evidence required: '+key);
  must(ui.takeover_clicked.channel==='console_control' && ui.human_reply_sent.channel==='console_composer','actual Console controls required');
  return true;
}
