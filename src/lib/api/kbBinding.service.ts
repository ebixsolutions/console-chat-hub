// SAME AI-ABC-C3 / original Console. Server-authorized development/UAT binding only.
// No production-visible admin page or new backend/Edge Function.
// Scoped deployment authorization must cover C3_KB_BINDING_DEV_ENABLED,
// VITE_C3_KB_BINDING_DEV_ENABLED, C3_KB_BINDING_INVITES_ENABLED, preview
// host visibility, and a separate explicit Supabase Auth/role grant scope.
// All default OFF; this Source change does not authorize enabling them.
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { withConfigSession } from "@/integrations/supabase/config-session-transport";

export type KBDevBinding = {
  company_id: string;
  company_name: string;
  kb_tenant_id: string | null;
  kb_company_id: string | null;
  is_active: boolean;
  revision: number;
  has_key: boolean;
  channels_ready: boolean;
  updated_at: string | null;
  members: Array<{ user_id: string; role: string; email: string | null; is_active: boolean }>;
};
type Result<T> = { ok: true; data: T } | { ok: false; error: string };
const uuid = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
const email = z.string().email().max(254);
const roles = z.enum(["admin", "supervisor", "agent", "qa"]);

/** Host + explicit server permission, not a VITE-only UI flag. */
export function isKBDevHost(host: string, enabled: boolean): boolean {
  if (!enabled) return false;
  const h = host.toLowerCase().split(":")[0];
  if (h === "localhost" || h === "127.0.0.1") return true;
  const id = "4dbf593e-577e-4af4-a553-460441c34473";
  return h === id + ".lovableproject.com" ||
    /^[a-z0-9-]+--4dbf593e-577e-4af4-a553-460441c34473\.lovableproject\.com$/.test(h) ||
    /^id-preview(?:-[a-z0-9-]+)?--4dbf593e-577e-4af4-a553-460441c34473\.lovable\.app$/.test(h);
}

function devAllowed(): boolean {
  const request = getRequest();
  if (!request || process.env.C3_KB_BINDING_DEV_ENABLED !== "true") return false;
  return isKBDevHost(new URL(request.url).host, true);
}

async function ownAdminCompanies(context: { supabase: any; userId: string }): Promise<Result<Array<{ id: string; display_name: string; channels_ready: boolean }>>> {
  // User-scoped RLS client + verified identity, NEVER caller-provided email/tenant.
  const sb = context.supabase;
  const { data: member, error: memberError } = await sb.from("company_membership")
    .select("company_id,role").eq("user_id", context.userId).eq("is_active", true).eq("role", "admin");
  if (memberError) return { ok: false, error: "membership_read_failed" };
  const companyIds = [...new Set<string>((member ?? []).map((m: any) => String(m.company_id)))];
  if (!companyIds.length || companyIds.length > 12) return { ok: false, error: "admin_company_scope_unresolved" };
  const { data: assignedRole, error: roleError } = await sb.from("user_roles")
    .select("user_id").eq("user_id", context.userId).eq("role", "admin").maybeSingle();
  if (roleError || !assignedRole) return { ok: false, error: "admin_role_required" };
  const { data: companies, error: companyError } = await sb.from("company")
    .select("id,display_name,is_active").in("id",companyIds).eq("is_active", true);
  if (companyError || (companies ?? []).length !== companyIds.length) return { ok: false, error: "company_scope_invalid" };
  const { data: channels, error: channelError } = await sb.from("channel_config")
    .select("company_id").in("company_id",companyIds).eq("is_active",true).eq("channel_type","web_widget");
  if (channelError) return { ok: false, error: "company_channel_lookup_failed" };
  const active = new Set<string>((channels ?? []).map((ch: any) => String(ch.company_id)));
  return { ok: true, data: (companies ?? []).map((co: any) => ({
    id: String(co.id), display_name: String(co.display_name ?? co.id), channels_ready: active.has(String(co.id)),
  })) };
}

export const listKBDevBindingsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Result<KBDevBinding[]>> => {
    if (!devAllowed()) return { ok: false, error: "development_binding_disabled" };
    const owned = await ownAdminCompanies({ supabase: context.supabase, userId: String(context.userId) });
    if (!owned.ok) return owned;
    // Typed API deliberately never fetches plaintext keys or decrypted Vault view.
    const ids = owned.data.map((co) => co.id);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: bindings, error } = await (supabaseAdmin as any)
      .from("company_kb_tenant_binding")
      .select("company_id,kb_tenant_id,kb_company_id,is_active,revision,api_key_secret_ref,updated_at")
      .in("company_id", ids);
    if (error) return { ok: false, error: "binding_table_not_available" };
    const { data: members, error: memberError } = await context.supabase
      .from("company_membership").select("company_id,user_id,role,is_active")
      .in("company_id", ids).limit(100);
    if (memberError) return { ok: false, error: "membership_read_failed" };
    const userIds = [...new Set<string>((members ?? []).map((m: any) => String(m.user_id)))].slice(0, 100);
    const emails = new Map<string, string | null>();
    await Promise.all(userIds.map(async (id) => {
      try {
        const { data: result, error: lookupError } = await supabaseAdmin.auth.admin.getUserById(id);
        emails.set(id, lookupError ? null : result.user?.email ?? null);
      } catch { emails.set(id, null); }
    }));
    return { ok: true, data: owned.data.map((co) => {
      const b = (bindings ?? []).find((x: any) => x.company_id === co.id);
      return {
        company_id: co.id, company_name: co.display_name,
        kb_tenant_id: b?.kb_tenant_id ?? null, kb_company_id: b?.kb_company_id ?? null,
        is_active: b?.is_active === true, revision: Number(b?.revision ?? 0),
        has_key: !!b?.api_key_secret_ref, updated_at: b?.updated_at ?? null,
        channels_ready: co.channels_ready,
        members: (members ?? []).filter((m: any) => m.company_id === co.id)
          .map((m: any) => ({ user_id: String(m.user_id), role: String(m.role), email: emails.get(String(m.user_id)) ?? null, is_active: m.is_active === true })),
      };
    }) };
  });

const writeInput = z.object({
  company_id: uuid,
  kb_tenant_id: z.string().regex(/^[1-9][0-9]{0,15}$/),
  kb_company_id: z.string().min(1).max(80).nullable(),
  is_active: z.boolean(),
  expected_revision: z.number().int().min(0),
  api_key: z.string().min(16).max(4096).optional(),
}).strict();

export const saveKBDevBindingFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(writeInput)
  .handler(async ({ context, data }): Promise<Result<{ company_id: string; kb_tenant_id: string; revision: number; has_key: boolean; is_active: boolean }>> => {
    if (!devAllowed()) return { ok: false, error: "development_binding_disabled" };
    const owned = await ownAdminCompanies({ supabase: context.supabase, userId: String(context.userId) });
    if (!owned.ok) return { ok: false, error: owned.error };
    if (!owned.data.some((co) => co.id === data.company_id && co.channels_ready)) {
      return { ok: false, error: "company_not_owned_or_channel_inactive" };
    }
    // Secrets go ONLY into protected SECURITY DEFINER -> Supabase Vault.
    // Caller never chooses actor ID; no secret is ever returned.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: output, error } = await (supabaseAdmin as any).rpc("kb_binding_write_v1", {
      p_actor: String(context.userId), p_company: data.company_id,
      p_tenant: data.kb_tenant_id, p_kb_company: data.kb_company_id,
      p_active: data.is_active, p_expected_revision: data.expected_revision,
      p_new_key: data.api_key ?? null,
    });
    if (error || !output || output.company_id !== data.company_id) {
      const code = String(error?.message ?? "");
      return { ok: false, error: code.includes("KB_BINDING_REVISION_CONFLICT")
        ? "binding_revision_conflict_reload" : "binding_save_failed" };
    }
    return { ok: true, data: {
      company_id: output.company_id, kb_tenant_id: output.kb_tenant_id,
      revision: Number(output.revision), has_key: output.has_key === true,
      is_active: output.is_active === true,
    } };
  });

const inviteInput = z.object({ company_id: uuid, email, role: roles }).strict();
export const inviteKBDevTesterFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator(inviteInput)
  .handler(async ({ context, data }): Promise<Result<{ invited: boolean }>> => {
    if (!devAllowed() || process.env.C3_KB_BINDING_INVITES_ENABLED !== "true") {
      return { ok: false, error: "test_account_invite_not_authorized" };
    }
    const owned = await ownAdminCompanies({ supabase: context.supabase, userId: String(context.userId) });
    if (!owned.ok || !owned.data.some((co) => co.id === data.company_id && co.channels_ready)) {
      return { ok: false, error: "company_not_owned_or_channel_inactive" };
    }
    // Two external stages: Supabase Auth invitation followed by ONE transaction
    // granting the canonical role + active same-Company membership. Only this
    // server-issued Auth UID enters the RPC; clients cannot supply a target UID.
    // An invite alone is never reported as a usable account.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: invited, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(data.email.trim().toLowerCase());
    if (error || !invited.user?.id ||
        invited.user.email?.toLowerCase() !== data.email.trim().toLowerCase()) {
      return { ok: false, error: "invitation_failed_or_existing_account" };
    }
    const { data: granted, error: grantError } = await (supabaseAdmin as any)
      .rpc("kb_binding_invite_grant_v1", {
        p_actor: String(context.userId), p_company: data.company_id,
        p_invited_user: invited.user.id, p_role: data.role,
      });
    if (grantError || granted?.user_id !== invited.user.id ||
        granted?.company_id !== data.company_id ||
        granted?.role !== data.role || granted?.is_active !== true) {
      const detail = String(grantError?.message ?? "");
      return { ok: false, error: detail.includes("KB_INVITE_ROLE_CONFLICT")
        ? "invited_but_role_conflict_no_access"
        : "invited_but_grant_not_verified_no_access" };
    }
    return { ok: true, data: { invited: true } };
  });

export const kbDevBindingService = {
  list: () => withConfigSession(supabase.auth, (headers) => listKBDevBindingsFn({ headers })),
  save: (data: z.infer<typeof writeInput>) => withConfigSession(supabase.auth, (headers) => saveKBDevBindingFn({ data, headers })),
  invite: (data: z.infer<typeof inviteInput>) => withConfigSession(supabase.auth, (headers) => inviteKBDevTesterFn({ data, headers })),
};