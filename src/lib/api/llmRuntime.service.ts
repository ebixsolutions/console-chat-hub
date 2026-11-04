import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { resolveEvidenceAdminScope, linkConversationEvidenceTurns } from "./evidence-log-scope";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * LLM runtime telemetry read path.
 *
 * Scope semantics are identical to the frozen pre-activation contract:
 *   - canonical membership ALWAYS wins; telemetry is filtered on that company.
 *   - pre_activation is permitted ONLY when the caller has zero membership rows
 *     at all, and it may only read `company_id IS NULL` telemetry rows.
 *   - an inactive membership, an inactive company, or ambiguous multi-company
 *     identity fails closed.
 *   - no company id is ever fabricated.
 * Provider credentials and model environment variables are never read here.
 */

export type LlmRuntimeRole = "admin" | "supervisor";
const ALLOWED_ROLES: readonly string[] = ["admin", "supervisor"];

export interface LlmRuntimeLogRow {
  id: string;
  created_at: string;
  response_status: number | null;
  response_latency_ms: number | null;
  error_message: string | null;
  request_payload: LlmRuntimePayload | null;
}

/** Safe, serializable subset of persisted runtime metadata. */
export interface LlmRuntimePayload {
  model?: string;
  purpose?: string;
  outcome?: string;
  input_tokens?: number;
  output_tokens?: number;
  attempts?: number;
  error_code?: string;
}

export interface LlmRuntimeResult {
  ok: boolean;
  error?: string;
  data?: {
    mode: "canonical" | "pre_activation";
    rows: LlmRuntimeLogRow[];
  };
}

type Scope =
  | { ok: true; mode: "canonical"; companyId: string }
  | { ok: true; mode: "pre_activation"; companyId: null }
  | { ok: false; error: string };

export async function resolveTelemetryScope(
  db: any,
  userId: string,
): Promise<Scope> {
  const { data: membershipRows, error: membershipError } = await db
    .from("company_membership")
    .select("company_id, role, is_active")
    .eq("user_id", userId);
  if (membershipError) return { ok: false, error: "company_membership_lookup_failed" };

  const memberships = (membershipRows ?? []) as {
    company_id: string | null;
    role: string | null;
    is_active: boolean | null;
  }[];

  const companyIds: string[] = [
    ...new Set(
      memberships
        .map((row) => row.company_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (companyIds.length > 1) return { ok: false, error: "company_membership_ambiguous" };

  if (companyIds.length === 1) {
    const companyId = companyIds[0];
    const active = memberships.filter(
      (row) => row.company_id === companyId && row.is_active === true,
    );
    if (active.length === 0) return { ok: false, error: "not_a_member" };

    const { data: company, error: companyError } = await db
      .from("company")
      .select("id, is_active")
      .eq("id", companyId)
      .maybeSingle();
    if (companyError) return { ok: false, error: "company_lookup_failed" };
    if (!company || company.is_active !== true) return { ok: false, error: "company_inactive" };

    const roles = active.map((row) => String(row.role ?? ""));
    if (!roles.some((role) => ALLOWED_ROLES.includes(role))) {
      return { ok: false, error: "forbidden" };
    }
    return { ok: true, mode: "canonical", companyId };
  }

  // Reachable only after proving the caller has zero canonical membership rows.
  if (memberships.length > 0) return { ok: false, error: "not_a_member" };

  const { data: roleRows, error: roleError } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (roleError) return { ok: false, error: "role_lookup_failed" };

  const roles = ((roleRows ?? []) as { role: string | null }[]).map((r) =>
    String(r.role ?? ""),
  );
  if (!roles.some((role) => ALLOWED_ROLES.includes(role))) {
    return { ok: false, error: "forbidden" };
  }
  return { ok: true, mode: "pre_activation", companyId: null };
}

export const getLlmRuntimeTelemetryFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<LlmRuntimeResult> => {
    const db = context.supabase as any;
    const scope = await resolveTelemetryScope(db, String(context.userId));
    if (!scope.ok) return { ok: false, error: scope.error };

    let query = db
      .from("upstream_call_log")
      .select(
        "id, created_at, response_status, response_latency_ms, error_message, request_payload",
      )
      .eq("upstream_service", "llm");

    query = scope.mode === "canonical"
      ? query.eq("company_id", scope.companyId)
      : query.is("company_id", null);

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) return { ok: false, error: "llm_runtime_log_query_failed" };

    return {
      ok: true,
      data: {
        mode: scope.mode,
        rows: ((data ?? []) as any[]).map((row): LlmRuntimeLogRow => {
          const payload = (row.request_payload ?? null) as Record<string, unknown> | null;
          return {
            id: String(row.id),
            created_at: String(row.created_at),
            response_status: typeof row.response_status === "number" ? row.response_status : null,
            response_latency_ms:
              typeof row.response_latency_ms === "number" ? row.response_latency_ms : null,
            error_message: row.error_message === null || row.error_message === undefined
              ? null
              : String(row.error_message),
            request_payload: payload
              ? {
                  ...(typeof payload.model === "string" ? { model: payload.model } : {}),
                  ...(typeof payload.purpose === "string" ? { purpose: payload.purpose } : {}),
                  ...(typeof payload.outcome === "string" ? { outcome: payload.outcome } : {}),
                  ...(Number.isFinite(Number(payload.input_tokens))
                    ? { input_tokens: Number(payload.input_tokens) }
                    : {}),
                  ...(Number.isFinite(Number(payload.output_tokens))
                    ? { output_tokens: Number(payload.output_tokens) }
                    : {}),
                  ...(Number.isFinite(Number(payload.attempts))
                    ? { attempts: Number(payload.attempts) }
                    : {}),
                  ...(typeof payload.error_code === "string"
                    ? { error_code: payload.error_code }
                    : {}),
                }
              : null,
          };
        }),
      },
    };
  });
/** Existing Console service: no new backend or service-role access in browser. */
export interface EvidenceConversation{id:string;status:string;channelId:string|null;createdAt:string;updatedAt:string;}
export interface EvidenceListResult{ok:boolean;error?:string;rows?:EvidenceConversation[];}
export interface EvidenceTurnsResult{ok:boolean;error?:string;conversationId?:string;
 turns?:ReturnType<typeof linkConversationEvidenceTurns>["turns"];
 unlinkedReplies?:ReturnType<typeof linkConversationEvidenceTurns>["unlinkedReplies"];
 nextOffset?:number|null;}
export const getAdminEvidenceConversationsFn=createServerFn({method:"GET"})
 .middleware([requireSupabaseAuth])
 .handler(async({context}):Promise<EvidenceListResult>=>{
  const db=context.supabase as any;
  const scope=await resolveEvidenceAdminScope(db,String(context.userId));
  if(!scope.ok)return{ok:false,error:scope.error};
  const {data,error}=await db.from("conversations")
   .select("id,status,channel_config_id,created_at,updated_at")
   .eq("company_id",scope.companyId).order("updated_at",{ascending:false}).limit(40);
  if(error)return{ok:false,error:"evidence_conversations_unavailable"};
  return{ok:true,rows:(data??[]).map((r:any)=>({id:String(r.id),status:String(r.status??"unknown"),
    channelId:r.channel_config_id?String(r.channel_config_id):null,
    createdAt:String(r.created_at),updatedAt:String(r.updated_at)}))};
 });
const evidenceTurnInput=z.object({
 conversationId:z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i),
 offset:z.number().int().min(0).max(10000).default(0),
});
export const getAdminEvidenceTurnsFn=createServerFn({method:"GET"})
 .middleware([requireSupabaseAuth]).inputValidator(evidenceTurnInput)
 .handler(async({context,data}):Promise<EvidenceTurnsResult>=>{
  const db=context.supabase as any,scope=await resolveEvidenceAdminScope(db,String(context.userId));
  if(!scope.ok)return{ok:false,error:scope.error};
  const {data:ticket,error:ticketError}=await db.from("conversations").select("id,company_id")
   .eq("id",data.conversationId).eq("company_id",scope.companyId).maybeSingle();
  if(ticketError||!ticket)return{ok:false,error:"conversation_not_in_admin_scope"};
  const pageLimit=100;
  const {data:messages,error:messageError}=await db.from("messages")
   .select("id,role,content,created_at,metadata,is_recalled")
   .eq("conversation_id",data.conversationId)
   .order("created_at",{ascending:true}).order("id",{ascending:true})
   .range(data.offset,data.offset+pageLimit);
  if(messageError)return{ok:false,error:"evidence_messages_unavailable"};
  const page=(messages??[]) as Array<{id:string;role:string;content:string;created_at:string;metadata:unknown;is_recalled:boolean}>;
  const hasMore=page.length>pageLimit,selected=page.slice(0,pageLimit);
  const ids=selected.filter(m=>["visitor","customer","user"].includes(m.role)).map(m=>m.id);
  let traces:any[]=[];
  if(ids.length){
   const read=await db.from("rag_trace")
    .select("id,message_id,query_sent,retrieved_chunks,top_score,kb_source,created_at")
    .eq("conversation_id",data.conversationId).in("message_id",ids)
    .order("created_at",{ascending:true}).limit(300);
   if(read.error)return{ok:false,error:"evidence_trace_unavailable"};
   traces=read.data??[];
  }
  const evidence=linkConversationEvidenceTurns(selected,traces);
  return{ok:true,conversationId:data.conversationId,turns:evidence.turns,
    unlinkedReplies:evidence.unlinkedReplies,nextOffset:hasMore?data.offset+pageLimit:null};
 });
