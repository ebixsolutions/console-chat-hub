/* Reviewed customer Chrome Sources > Snippets collector. Reuses customer-proof
 * polling/DOM collection. It observes ONE normal Widget Send; it never sends,
 * restores sessions, reads agent Auth, or retries. Download contains no secrets. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else api.arm(root);})(globalThis,function(){
  'use strict';
  const PROJECT='nbtowfuvvfqpxqydyoby', COMPANY='f6000000-0000-4000-8000-000000000001';
  const CONVERSATION='1f5d3608-86ba-40e5-aca8-83ea009293a5',CHANNEL='f6000000-0000-4000-8000-000000000130';
  const HEAD='b0c76120537b53b5c9172cc81a3bad1c4060621b',TREE='57a7178fb558ef4cd925df78370a41d550dcb5f9';
  const BASE='https://'+PROJECT+'.supabase.co/functions/v1/',PREFIX='nexus_widget_'+CHANNEL;
  const HUMAN='你好，我已接手，會按你之前提供的要求跟進。',TARGET='1f8b22b1-9d67-42e8-8ab6-eda7e06dce43';
  const now=()=>new Date().toISOString();
  function stop(m){throw new Error('STOP: '+m);}
  function validate(env){
    if(env.location.origin!=='https://localhost:5173'||env.location.pathname!=='/phase1-demo')stop('wrong customer page');
    const page=env.document.body.innerText;
    if(!['NONPRODUCTION',PROJECT,HEAD,TREE].every(x=>page.includes(x))||page.includes('WORKTREE MODIFIED'))stop('application identity mismatch');
    if(env.localStorage.getItem(PREFIX+'_conversation_id')!==CONVERSATION||env.localStorage.getItem(PREFIX+'_channel_id')!==CHANNEL)stop('wrong retained customer scope');
  }
  const binding=()=>({project_id:PROJECT,company_id:COMPANY,conversation_id:CONVERSATION,channel_id:CHANNEL,application_head:HEAD,application_tree:TREE});
  async function collect(env,fetcher=env.fetch.bind(env)){
    validate(env);let token=env.localStorage.getItem(PREFIX+'_session_token');
    if(typeof token!=='string'||token.length<32||token.length>256)stop('existing session unavailable');
    let res;const started_at=now();
    try{res=await fetcher(BASE+'widget-poll-messages',{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversation_id:CONVERSATION,session_token:token,after_message_id:'7cc939a9-246f-49c9-b8da-c234ee40df2e'}),signal:env.AbortSignal.timeout(15000)});}finally{token=null;}
    const raw=await res.json();
    if(res.status!==200||raw.success!==true||!Array.isArray(raw.data?.messages))stop('customer polling failed');
    const messages=raw.data.messages.map(m=>({id:m.id,role:m.role,content:m.content,created_at:m.created_at}));
    const target=messages.filter(m=>m.id===TARGET);
    if(target.length!==1||target[0].role!=='agent'||target[0].content!==HUMAN||raw.data.ai_generating!==false||raw.data.human_support?.state!=='assigned'||raw.data.human_support.agent_assigned!==true)stop('poll target/control mismatch');
    const dom=Array.from(env.document.querySelectorAll('.nx-msg'));
    const count=dom.filter(el=>el.classList.contains('agent')&&el.textContent===HUMAN).length;
    if(count!==1)stop('existing human reply must appear once in Widget');
    return {...binding(),endpoint:BASE+'widget-poll-messages',observation_status:'CAPTURED',started_at,observed_at:now(),status:res.status,
      body:{success:raw.success,data:{messages,ai_generating:raw.data.ai_generating,human_support:{state:raw.data.human_support.state,agent_assigned:raw.data.human_support.agent_assigned}}},customer_dom:{target_message_id:TARGET,human_text_count:count}};
  }
  function download(env,evidence){const blob=new env.Blob([JSON.stringify(evidence,null,2)],{type:'application/json'});const url=env.URL.createObjectURL(blob);const a=env.document.createElement('a');a.href=url;a.download='c3-customer-control-receipts-'+now().replace(/[:.]/g,'-')+'.json';env.document.body.append(a);a.click();a.remove();env.setTimeout(()=>env.URL.revokeObjectURL(url),1000);}
  async function arm(env){
    if(env.__c3ControlCollectorArmed) return env.alert('STOP: collector already armed; do not send again.');
    const original=env.fetch;
    try{
      const first=await collect(env,original.bind(env));
      const evidence={schema:'c3-customer-control-receipts-v2',...binding(),purpose:'SUPPLEMENTAL HUMAN-CONTROL PROBE',before_customer_poll:first,receipt:null,customer_poll:first,original_receipt_status:'NOT_CAPTURED'};
      env.__c3ControlCollectorArmed=true;
      env.fetch=async function(input,init){
        if(String(input)!==BASE+'receive-widget-message')return original.call(env,input,init);
        // Restore before issuing the one intercepted request. Never replay it.
        env.fetch=original;
        const started_at=now();let request;
        try{request=JSON.parse(init.body);}catch{env.alert('STOP: unsupported Widget request; do not retry.');throw new Error('collector unsupported request');}
        if(request.conversation_id!==CONVERSATION||request.content!=='收到，請繼續跟進。'){env.alert('STOP: probe scope/content mismatch; no probe sent.');throw new Error('collector probe mismatch');}
        const client_message_id=request.client_message_id??null;request=null;
        let response;
        try{
          response=await original.call(env,input,init);const raw=await response.clone().json();
          evidence.receipt={...binding(),kind:'widget_ingress_human_control',endpoint:BASE+'receive-widget-message',observation_status:'CAPTURED',started_at,observed_at:now(),status:response.status,content:'收到，請繼續跟進。',message_id:raw.data?.message_id??null,request_identity:{client_message_id,response_request_id:response.headers.get('sb-request-id'),message_id:raw.data?.message_id??null},body:{success:raw.success,data:raw.data?{message_id:raw.data.message_id,ai_reply_pending:raw.data.ai_reply_pending,control_state:raw.data.control_state}:null}};
          evidence.customer_poll=await collect(env,original.bind(env));download(env,evidence);
          env.alert('One actual Widget request captured. No retry. Attach the sanitized JSON to Work.');
        }catch{
          evidence.collection_status='FAILED_DO_NOT_RESEND';download(env,evidence);env.alert('STOP: receipt collection incomplete. Do not send again. Attach the JSON.');
        }
        return response;
      };
      env.alert('Collector armed. In this existing Widget, send exactly once: 收到，請繼續跟進。 Do not send a human reply again.');
      return evidence;
    }catch(error){env.fetch=original;env.alert(error.message?.startsWith('STOP:')?error.message:'STOP: polling collection failed; no message sent.');}
  }
  return {collect,arm};
});
