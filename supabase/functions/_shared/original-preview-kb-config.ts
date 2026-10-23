/** Shared server-only original Preview RAG configuration admission. No remote
 * request, model call, permit or knowledge-authority claim is made here. */
export const FRANKIE_KB_SCOPE = Object.freeze({
  actor:"3bdf936e-b543-41d8-9fff-fa020a85f3f6", company:"3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
  channel:"b0000000-0000-0000-0000-000000000001", tenant:"34",
  endpoint:"https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search",
});
export const RAG_API_MODE = "query_embedding_rag_authority_v1";
export const ORIGINAL_RAG_ACTIVATION = Object.freeze({
  preview_version:4,inbox_version:3,
  remote_mode:RAG_API_MODE,allow_remote_embedding:true,
  rag_api_contract:"singapore_rag_aggregation_v1",
  accepted_remote_risk:"authenticated_tenant_rag_filter_unversioned_v1",
});
export type RagApiPolicy = {
  remote_mode:typeof RAG_API_MODE;
  rag_api_contract:"singapore_rag_published_v1" | "singapore_rag_aggregation_v1";
  accepted_remote_risk:"authenticated_rag_authority_no_independent_metadata_v1" | "authenticated_tenant_rag_filter_unversioned_v1";
};
export function ragApiPolicy(binding:any):RagApiPolicy|null {
  return binding?.remote_mode===RAG_API_MODE && binding.allow_remote_embedding===true &&
    (binding.rag_api_contract==="singapore_rag_published_v1" && binding.accepted_remote_risk==="authenticated_rag_authority_no_independent_metadata_v1" ||
     binding.rag_api_contract==="singapore_rag_aggregation_v1" && binding.accepted_remote_risk==="authenticated_tenant_rag_filter_unversioned_v1") &&
    ["evidence_reference","remote_runtime_sha256","attestation_payload","attestation_signature"].every(k=>binding[k]===undefined)
    ? {remote_mode:RAG_API_MODE,rag_api_contract:binding.rag_api_contract,accepted_remote_risk:binding.accepted_remote_risk} : null;
}

export type PreviewRagConfiguration = {ready:boolean;code:"configuration_ready"|"authorization_absent"|"authorization_invalid"|"scope_denied"|"tenant_mapping_unverified"|"endpoint_unverified"|"credential_unavailable";retrieval_verified:false};
export function originalPreviewRagConfiguration(read:(name:string)=>string|undefined,scope:{actor:string;company:string;channel:string}):PreviewRagConfiguration {
  const result=(code:PreviewRagConfiguration["code"]):PreviewRagConfiguration=>({ready:code==="configuration_ready",code,retrieval_verified:false});
  const raw=read("ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION");
  if(!raw)return result("authorization_absent");
  let grant:any,map:any,keys:any;
  try{grant=JSON.parse(raw);}catch{return result("authorization_invalid");}
  if(grant?.version!==4 || !Array.isArray(grant.bindings) || grant.bindings.length>20 || Object.keys(grant).some(k=>!["version","bindings"].includes(k)))return result("authorization_invalid");
  if(scope.actor!==FRANKIE_KB_SCOPE.actor || scope.company!==FRANKIE_KB_SCOPE.company || scope.channel!==FRANKIE_KB_SCOPE.channel)return result("scope_denied");
  const bindings=grant.bindings.filter((b:any)=>b?.actor_id===scope.actor && b.company_id===scope.company && b.channel_id===scope.channel);
  const fields=["actor_id","company_id","channel_id","tenant_id","endpoint","provider","purpose","remote_mode","allow_remote_embedding","rag_api_contract","accepted_remote_risk"];
  if(bindings.length!==1 || !ragApiPolicy(bindings[0]) || Object.keys(bindings[0]).some(k=>!fields.includes(k)) ||
     bindings[0].tenant_id!==FRANKIE_KB_SCOPE.tenant || bindings[0].endpoint!==FRANKIE_KB_SCOPE.endpoint || bindings[0].provider!=="singapore-kb" || bindings[0].purpose!=="kb_embedding")return result("scope_denied");
  try{map=JSON.parse(read("KB_SINGAPORE_TENANT_MAP_JSON")??"null");}catch{return result("tenant_mapping_unverified");}
  if(!map || Array.isArray(map) || String(map[scope.company])!==bindings[0].tenant_id)return result("tenant_mapping_unverified");
  const configured=(read("KB_SINGAPORE_BASE_URL")??read("KB_RAG_ENDPOINT")??read("KB_RAG_BASE_URL")??"https://py.ebixmall.com/py-knowledge-base").trim().replace(/\/+$/,"");
  const endpoint=configured.endsWith("/api/v1/rag/context-search")?configured:configured+"/api/v1/rag/context-search";
  if(endpoint!==bindings[0].endpoint || (read("KB_SINGAPORE_API_KEY_HEADER")??"x-api-key").trim().toLowerCase()!=="x-api-key")return result("endpoint_unverified");
  try{keys=JSON.parse(read("KB_SINGAPORE_TENANT_API_KEYS_JSON")??"null");}catch{return result("credential_unavailable");}
  const key=keys?.[bindings[0].tenant_id];
  if(typeof key!=="string" || key!==key.trim() || key.length<16 || key.length>4096 || /[\r\n\0]/.test(key))return result("credential_unavailable");
  return result("configuration_ready");
}
