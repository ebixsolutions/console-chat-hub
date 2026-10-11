import {execute, guards, SCOPE, BODY, sanitizeResponse, readBounded} from './executor.mjs';
import {SNAPSHOT_SQL} from './snapshot.mjs';
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS'};
const response = (body,status=200) => new Response(JSON.stringify(body), {status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
export const CALLER = Object.freeze({id:'4348ee35-9632-4626-a846-e313bcc4a5f9',email:'authe@gmail.com'});
const AUTH_URL = 'https://nrfxhqabwblzxoushgnm.supabase.co/auth/v1/user';
// Auth server verifies signature/expiry; unverified JWT claims are never trusted.
async function verifyCaller(authorization, env, fetcher) {
  if(!/^Bearer [^\s]+$/.test(authorization))return false;
  const publicKey=env('SUPABASE_ANON_KEY'); if(!publicKey)return false;
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),5000);
  try {
    const result=await fetcher(AUTH_URL,{method:'GET',redirect:'manual',signal:controller.signal,
      headers:{Authorization:authorization,apikey:publicKey}});
    if(result.status!==200)return false;
    const user=JSON.parse(await readBounded(result,8192));
    return user?.id===CALLER.id && user?.email===CALLER.email && user?.role==='authenticated';
  } catch {return false;} finally {clearTimeout(timer);}
}
async function callerScope(sql) {
  const [row]=await sql`select exists(select 1 from public.company_membership m
    join public.channel_config ch on ch.company_id=m.company_id
    join public.conversations c on c.company_id=m.company_id and c.channel_config_id=ch.id
    where m.user_id=${CALLER.id} and m.company_id=${SCOPE.company}
      and m.is_active=true and m.role='admin' and ch.id=${SCOPE.channel}
      and ch.is_active=true and c.id=${SCOPE.conversation}) as authorized_scope`;
  return row?.authorized_scope===true;
}
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
function constantTimeEqual(a,b) {
  const x=new TextEncoder().encode(a), y=new TextEncoder().encode(b);
  let mismatch=x.length^y.length; for(let i=0;i<Math.max(x.length,y.length);i++)mismatch|=(x[i]??0)^(y[i]??0);
  return mismatch===0;
}
export function createHandler(env, connect, fetcher) {
  return async req => {
    // Preflight has no DB/Auth/Vault/Worker side effects. Bearer is sent only to
    // this project's Auth server; CORS is not an authentication authority.
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
    if(req.method!=='POST') return response({state:'STOP',code:'method_not_allowed'},405);
    if(env('SUPABASE_URL')!=='https://nrfxhqabwblzxoushgnm.supabase.co')
      return response({state:'STOP',code:'runtime_project_mismatch'},409);
    const authorization=req.headers.get('Authorization')??'';
    if(!await verifyCaller(authorization,env,fetcher))
      return response({state:'STOP',code:'caller_authentication_failed'},401);
    let input;
    try { if(Number(req.headers.get('content-length')??0)>1024)throw 0;
      const text=await readBounded(req,1024); input=text?JSON.parse(text):{}; }
    catch { return response({state:'STOP',code:'input_unavailable'},400); }
    // Reject all unregistered request inputs before DB or private credential access.
    if(Object.keys(input??{}).some(k=>!['mode','activation_id'].includes(k)))
      return response({state:'STOP',code:'fixed_input_required'},400);
    let sql, privateBinding;
    try {
      const dbURL=env('SUPABASE_DB_URL'); if(!dbURL)throw 0;
      sql=connect(dbURL); // Only protected Edge gets the default injected DB URL.
      if(!await callerScope(sql))return response({state:'STOP',code:'caller_scope_denied'},403);
      const [slot]=await sql`select armed,spent_at,expires_at>now() as live
        from c3_b12_once.ledger where operation=${SCOPE.activation}`;
      if(!slot || slot.spent_at || slot.live!==true)
        return response({state:'STOP',code:'operation_expired_or_spent'},409);
      if((input.mode??'dry-run')==='dry-run' && slot.armed!==false)
        return response({state:'STOP',code:'operation_already_armed'},409);
      const [capability]=await sql`select
        has_table_privilege(current_user,'vault.decrypted_secrets','SELECT') as vault_read,
        has_table_privilege(current_user,'c3_b12_once.ledger','SELECT') as ledger_select,
        has_table_privilege(current_user,'c3_b12_once.ledger','UPDATE') as ledger_update,
        has_function_privilege(current_user,'public.ce_verify_worker_token_v1(text)','EXECUTE') as verifier_access`;
      if(capability?.vault_read!==true || capability.ledger_select!==true
        || capability.ledger_update!==true || capability.verifier_access!==true)throw 0;
      const snapshot = async () => (await sql.unsafe(SNAPSHOT_SQL))[0];
      const io={snapshot,
        async prepare() {
          if(!await verifyCaller(authorization,env,fetcher))return null;
          // Short isolated ops-row lock. Transaction commits before outbound HTTP.
          const prepared=await sql.begin('isolation level repeatable read',async tx=>{
            const [slot]=await tx`select armed,spent_at,expires_at>now() as live,
              guards_reviewed_at>now()-interval '60 seconds' as reviewed
              from c3_b12_once.ledger where operation=${SCOPE.activation} for update`;
            if(!slot?.armed || slot.spent_at || !slot.live || !slot.reviewed)return null;
            if(!await callerScope(tx))return null;
            if(!guards((await tx.unsafe(SNAPSHOT_SQL))[0]))return null;
            const [binding]=await tx`select worker_secret_id,worker_token_hash,worker_url,enabled
              from public.ce_automation_runtime where singleton=true`;
            if(!binding?.worker_secret_id || !binding.worker_token_hash || binding.enabled
              || binding.worker_url!==SCOPE.endpoint) return null;
            // This SELECT must NEVER be executed through Work tools. Only inside
            // this explicitly approved protected Edge runtime. No RPC returns it.
            const [secret]=await tx`select decrypted_secret as credential
              from vault.decrypted_secrets where id=${binding.worker_secret_id}`;
            if(!secret?.credential)return null;
            // Match the pinned verifier's direct UTF8 SHA256 internally, without
            // introducing another SQL call carrying the private token parameter.
            const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret.credential));
            const actualHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
            if(!constantTimeEqual(actualHash,binding.worker_token_hash))return null;
            const rows=await tx`update c3_b12_once.ledger set spent_at=now(),armed=false
              where operation=${SCOPE.activation} and spent_at is null returning operation`;
            if(rows.length!==1)return null;
            return {credential:secret.credential,binding};
          });
          if(!prepared)return null;
          privateBinding=prepared.binding;
          let called=false;
          return async () => {
            if(called)throw 0; called=true;
            const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),10000);
            try {
              const result=await fetcher(SCOPE.endpoint,{method:'POST',redirect:'manual',signal:controller.signal,
                headers:{'Content-Type':'application/json','X-CE-Worker-Token':prepared.credential},body:BODY});
              const raw=await readBounded(result);
              return sanitizeResponse(result.status,raw,result.headers.get('x-request-id'),
                [prepared.credential,authorization,dbURL,prepared.binding.worker_token_hash]);
            } finally { clearTimeout(timer); prepared.credential=''; }
          };
        },
        async bindingUnchanged() {
          const [binding]=await sql`select worker_secret_id,worker_token_hash,worker_url,enabled
            from public.ce_automation_runtime where singleton=true`;
          return same(privateBinding,binding);
        },
        async finish(receipt) {
          const rows=await sql`update c3_b12_once.ledger set receipt=${sql.json(receipt)}
            where operation=${SCOPE.activation} and spent_at is not null and receipt is null returning operation`;
          if(rows.length!==1)throw 0;
        }};
      return response(await execute(input,io));
    } catch { return response({state:'STOP',code:'protected_runtime_unavailable',send_attempts:'READ_PERSISTENT_LEDGER'},409); }
    finally { if(sql)try{await sql.end({timeout:1});}catch{} }
  };
}
