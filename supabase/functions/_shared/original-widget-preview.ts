import { getSupabaseAdminKey } from "./supabase-admin-key.ts";
/** Original human-operated Preview permission, separate from synthetic UAT.
 * Deployment does not grant paid use: the exact server authorization must also
 * be approved and installed. No browser flag, old success or metadata can mint it. */
export const ORIGINAL_PREVIEW_AUTHORIZATION = "original-widget-preview-v1:frankie-authe:existing-vertex-production";
export const ORIGINAL_PREVIEW_ACCOUNTS = [
  {email:"frankien.ng@gmail.com",company:"3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",channel:"b0000000-0000-0000-0000-000000000001"},
  {email:"authe@gmail.com",company:"4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec",channel:"0405282f-77dc-47cf-8074-99dd3dc6c393"},
] as const;
type Env = (name:string)=>string|undefined;
const env:Env = name=>Deno.env.get(name);
export function originalPreviewEnabled(read:Env=env): boolean {
  return read("ORIGINAL_WIDGET_PREVIEW_AUTHORIZATION") === ORIGINAL_PREVIEW_AUTHORIZATION;
}
export function originalPreviewCandidate(user:any, company:string, channel:string): boolean {
  return typeof user?.id === "string" && !!user.email_confirmed_at &&
    ORIGINAL_PREVIEW_ACCOUNTS.some(a=>a.email===user.email?.toLowerCase() && a.company===company && a.channel===channel);
}
export function originalPreviewActor(user:any,company:string,channel:string,read:Env=env):boolean {
  return originalPreviewEnabled(read) && originalPreviewCandidate(user,company,channel);
}
type Receipt = {version:1;actor:string;email:string;company:string;channel:string;conversation:string;session:string;authorization:string;signature:string};
const encoded = (r:Omit<Receipt,"signature">) => JSON.stringify(["original-widget-preview-v1",r.version,r.actor,r.email,r.company,r.channel,r.conversation,r.session,r.authorization]);
const encoder=new TextEncoder();
async function key() { return await crypto.subtle.importKey("raw",encoder.encode(getSupabaseAdminKey()),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]); }
export async function signOriginalPreview(user:any,company:string,channel:string,conversation:string,session:string,read:Env=env):Promise<Receipt> {
  if(!originalPreviewActor(user,company,channel,read))throw Error("ORIGINAL_PREVIEW_AUTHORIZATION_REQUIRED");
  const claims:Omit<Receipt,"signature">={version:1,actor:user.id,email:user.email.toLowerCase(),company,channel,conversation,session,authorization:ORIGINAL_PREVIEW_AUTHORIZATION};
  const signature=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",await key(),encoder.encode(encoded(claims)))),b=>b.toString(16).padStart(2,"0")).join("");
  return {...claims,signature};
}
export function originalPreviewMetadata(m:any,actor:string):boolean {
  return m?.source==="widget_live_test" && m.widget_live_test===true && m.test_mode===true && m.exclude_training===true &&
    m.synthetic!==true && m.execution_class==="authenticated_admin_preview" && m.owner_user_id===actor && m.scope_mode==="canonical";
}
/** Recheck persisted identity and current membership/channel on each paid dispatch.
 * Receipt is signed with the existing server key; copying or changing markers,
 * actor, Session, Company or ticket cannot confer permission. Never returned. */
export async function verifyOriginalPreview(db:any,c:any,read:Env=env,requireEnabled=true):Promise<boolean> {
  if(requireEnabled && !originalPreviewEnabled(read))return false;
  const m=c?.metadata_source,r=m?.original_preview_authority as Receipt;
  if(!r || !originalPreviewMetadata(m,r.actor) || r.version!==1 || r.authorization!==ORIGINAL_PREVIEW_AUTHORIZATION ||
    r.company!==c.company_id || r.channel!==c.channel_config_id || r.conversation!==c.id || r.session!==c.visitor_session_id ||
    !ORIGINAL_PREVIEW_ACCOUNTS.some(a=>a.email===r.email && a.company===r.company && a.channel===r.channel) ||
    typeof r.signature!=="string" || !/^[a-f0-9]{64}$/.test(r.signature))return false;
  if(!await crypto.subtle.verify("HMAC",await key(),new Uint8Array(r.signature.match(/../g)!.map(v=>parseInt(v,16))),encoder.encode(encoded(r))))return false;
  const member=await db.from("company_membership").select("company_id,role,is_active").eq("user_id",r.actor).eq("company_id",r.company).eq("is_active",true).maybeSingle();
  const company=await db.from("company").select("id,is_active").eq("id",r.company).maybeSingle();
  const channel=await db.from("channel_config").select("id,company_id,is_active,channel_type").eq("id",r.channel).eq("company_id",r.company).maybeSingle();
  const session=await db.from("visitor_session").select("id,channel_config_id,visitor_fingerprint,visitor_metadata").eq("id",r.session).eq("channel_config_id",r.channel).maybeSingle();
  const s=session.data,sm=s?.visitor_metadata;
  return !member.error && member.data?.role==="admin" && member.data?.is_active===true && member.data?.company_id===r.company &&
    !company.error && company.data?.id===r.company && company.data?.is_active===true &&
    !channel.error && channel.data?.id===r.channel && channel.data?.company_id===r.company && channel.data?.is_active===true && channel.data?.channel_type==="web_widget" &&
    !session.error && s?.id===r.session && s.channel_config_id===r.channel && s.visitor_fingerprint===`widget-live-test:${r.actor}` &&
    sm?.source==="widget_live_test" && sm.test_mode===true && sm.exclude_training===true && sm.owner_user_id===r.actor && sm.scope_mode==="canonical";
}
/** Actual caller validation at the public visitor ingress/poll boundary. A
 * signed registration alone is not a current Admin login or a visitor token. */
export async function originalPreviewRequest(req:Request,createClient:any,db:any,c:any,requireEnabled=true):Promise<boolean> {
  const token=/^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "")?.[1];
  if(!token)return false;
  const auth=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const r=await auth.auth.getUser(token),user=r.data?.user;
  return !r.error && user?.id===c.metadata_source?.owner_user_id && originalPreviewCandidate(user,c.company_id,c.channel_config_id) &&
    await verifyOriginalPreview(db,c,undefined,requireEnabled);
}
