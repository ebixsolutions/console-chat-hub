// Callback for the existing tenant-authenticated KB runtime. No provider credentials or browser access.
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
import { parseStringMap, resolveKBEndpoint } from "../_shared/kb-client.ts";
import { resolveSingaporeCredential } from "../_shared/kb-auth.ts";
import {
  remoteAccountingAction,
  remoteAccountingSecret,
  type RemoteScope,
  verifyRemote,
} from "../_shared/remote-model-accounting.ts";
export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  try {
    const rawScope = req.headers.get("x-c3-accounting-scope") ?? "";
    if (rawScope.length > 1024) throw Error("scope");
    const scope = JSON.parse(rawScope) as RemoteScope;
    if (
      scope.company !== "4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec" ||
      typeof scope.operation !== "string" ||
      !/^(?:kb|coach_sync):[a-f0-9-]{36}$/.test(scope.operation)
    ) throw Error("scope");
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      getSupabaseAdminKey(),
    );
    const { data: company, error } = await db.from("company").select(
      "id,is_active",
    ).eq("id", scope.company).maybeSingle();
    const mapping = parseStringMap(
      Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON"),
    );
    if (error || !company?.is_active) throw Error("tenant");
    if (
      (scope.service ?? "kb") === "kb" &&
      mapping?.[scope.company] !== scope.tenant
    ) throw Error("tenant");
    if (scope.service === "coach_sync" && scope.tenant !== scope.company) {
      throw Error("tenant");
    }
    if (
      scope.service !== undefined &&
      !["kb", "coach_sync"].includes(scope.service)
    ) throw Error("service");
    let secret: string | undefined;
    if (scope.service === "coach_sync") {
      secret = Deno.env.get("COACH_C360_SYNC_API_TOKEN");
    } else {
      const endpoint = resolveKBEndpoint();
      if (!endpoint) throw Error("config");
      const credential = await resolveSingaporeCredential({
        mode: "canonical",
        aiCompanyId: scope.company,
        singaporeTenantId: scope.tenant,
      }, endpoint);
      secret = credential.ok
        ? remoteAccountingSecret(credential, endpoint)
        : undefined;
    }
    if (
      !secret ||
      !await verifyRemote(
        rawScope,
        req.headers.get("x-c3-accounting-signature") ?? "",
        secret,
      )
    ) throw Error("auth");
    const raw = await req.text();
    if (raw.length > 4096) throw Error("size");
    // The body must be signed too; a leaked capability cannot mint or finalize arbitrary attempts.
    if (
      !await verifyRemote(
        rawScope + "\n" + raw,
        req.headers.get("x-c3-accounting-body-signature") ?? "",
        secret,
      )
    ) throw Error("auth");
    const result = await remoteAccountingAction(db, scope, JSON.parse(raw));
    return Response.json(result);
  } catch {
    return Response.json({ ok: false, code: "MODEL_ACCOUNTING_DENIED" }, {
      status: 403,
    });
  }
}
if (import.meta.main) Deno.serve(handler);
