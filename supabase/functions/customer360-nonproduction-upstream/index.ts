// C3 DB-backed nonproduction Customer360 upstream. No CORS, no client auth.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isC3NonproductionProject, resolveServerSecret } from "../_shared/nonproduction-secret.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER = /^cus_[A-Za-z0-9_-]{16,64}$/;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});
Deno.serve(async (req: Request) => {
  if (!isC3NonproductionProject()) return json(503, { success: false, error: "nonproduction_identity_required" });
  if (req.method !== "POST") return json(405, { success: false, error: "method_not_allowed" });
  const expected = await resolveServerSecret("CUSTOMER360_API_TOKEN", "c3_customer360_upstream_token");
  const presented = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!expected || !presented || presented !== expected) return json(401, { success: false, error: "unauthorized" });

  const requestId = req.headers.get("X-Request-ID")?.trim() ?? "";
  const companyId = req.headers.get("X-AI-Company-ID")?.trim() ?? "";
  const sourceIdentity = req.headers.get("X-Source-Identity")?.trim() ?? "";
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const conversationId = typeof body?.conversation_id === "string" ? body.conversation_id : "";
  const customerRef = typeof body?.customer_ref === "string" ? body.customer_ref : "";
  if (
    body?.operation !== "read_customer_context" || !UUID.test(companyId) ||
    !UUID.test(conversationId) || !CUSTOMER.test(customerRef) ||
    !UUID.test(requestId) || sourceIdentity !== "ai-chatbot-c3-nonproduction"
  ) return json(400, { success: false, error: "request_contract_invalid" });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return json(503, { success: false, error: "server_config_missing" });
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: customer, error: customerError } = await sb
    .from("c3_nonprod_crm_customer")
    .select("id,company_id,conversation_id,customer_ref,source_identity,context,is_active")
    .eq("company_id", companyId)
    .eq("conversation_id", conversationId)
    .eq("customer_ref", customerRef)
    .maybeSingle();
  if (customerError) return json(500, { success: false, error: "customer_lookup_failed" });
  if (!customer || customer.is_active !== true) return json(404, { success: false, error: "customer_not_found" });

  const { data: entitlements, error: entitlementError } = await sb
    .from("c3_nonprod_crm_entitlement")
    .select("name,value,scope,status,valid_from,valid_until")
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: true });
  if (entitlementError) return json(500, { success: false, error: "entitlement_lookup_failed" });
  return json(200, {
    success: true,
    company_id: customer.company_id,
    conversation_id: customer.conversation_id,
    customer_ref: customer.customer_ref,
    request_id: requestId,
    source_identity: customer.source_identity,
    customer_context: customer.context,
    entitlements: entitlements ?? [],
  });
});
