import { supabase } from "@/integrations/supabase/client";
import { AUTHORITATIVE_SUPABASE_PROJECT_ID } from "@/integrations/supabase/runtime-authority.mjs";
import { B12_SCOPE, scopeMatches, parseFunctionResponse, type Endpoint } from "@/lib/ce-evaluation-execution";

/** First-party caller: normal singleton auth, no custom headers or credentials. */
export async function verifyB12Identity() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user || data.user.id !== B12_SCOPE.userId || data.user.email !== B12_SCOPE.email) throw new Error("synthetic_identity_unavailable");
  const [membership, ticket, channel] = await Promise.all([
    supabase.from("company_membership").select("company_id,role,is_active").eq("user_id", data.user.id).eq("company_id", B12_SCOPE.companyId).eq("is_active", true).single(),
    supabase.from("conversations").select("id,company_id,channel_config_id").eq("id", B12_SCOPE.ticket).single(),
    supabase.from("channel_config").select("id,company_id,is_active").eq("id", B12_SCOPE.channelId).single(),
  ]);
  if (membership.error || ticket.error || channel.error || !membership.data || !ticket.data || !channel.data) throw new Error("scope_readback_unavailable");
  const scope = { userId: data.user.id, email: data.user.email, companyId: membership.data.company_id,
    role: membership.data.role, active: membership.data.is_active, ticket: ticket.data.id,
    channelId: ticket.data.channel_config_id ?? undefined, backend: AUTHORITATIVE_SUPABASE_PROJECT_ID };
  if (!scopeMatches(scope) || ticket.data.company_id !== B12_SCOPE.companyId || channel.data.company_id !== B12_SCOPE.companyId || !channel.data.is_active) throw new Error("scope_binding_mismatch");
  return Object.freeze(scope);
}
export function verificationBody(endpoint: Endpoint) {
  return Object.freeze(endpoint === "ce-evaluation-control" ? { conversation_id: B12_SCOPE.ticket, source: "manual" } :
    { conversation_id: B12_SCOPE.ticket, action: "evaluate" });
}
export async function invokeB12Negative(endpoint: Endpoint) {
  return parseFunctionResponse(await supabase.functions.invoke(endpoint, { body: verificationBody(endpoint), timeout: 15000 }));
}
