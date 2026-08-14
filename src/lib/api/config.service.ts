import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface LiveChannelConfigRow {
  id: string;
  name: string;
  channel_type: string;
  is_active: boolean;
  company_id: string | null;
  widget_config_id: string | null;
  allowed_origins: string[] | null;
}

export interface LiveWidgetConfigRow {
  id: string;
  name: string;
  header_title: string;
  welcome_message: string | null;
  placeholder_text: string | null;
  primary_color: string | null;
  logo_url: string | null;
  is_active: boolean | null;
  appearance_theme: "modern" | "classic";
}

export type JsonRecord = Record<string, any>;

export interface LiveFeedbackConfigRow {
  id: string;
  name: string;
  is_active: boolean;
  delay_minutes: number | null;
  trigger_event: string;
  config: JsonRecord | null;
  company_id: string;
}

export interface ServerResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type AppRole = "admin" | "supervisor" | "agent" | "qa";
const ROLE_PRECEDENCE: AppRole[] = ["admin", "supervisor", "agent", "qa"];

type CompanyScope = { companyId: string; roles: AppRole[] };

async function resolveCompanyScope(context: {
  supabase: any;
  userId: string;
}): Promise<ServerResult<CompanyScope>> {
  const { data: memberships, error: membershipErr } = await context.supabase
    .from("company_membership")
    .select("company_id, role")
    .eq("user_id", String(context.userId))
    .eq("is_active", true);

  if (membershipErr) return { ok: false, error: "company_membership_lookup_failed" };

  const companyIds = [...new Set((memberships ?? []).map((m: any) => String(m.company_id)))];
  if (companyIds.length === 0) return { ok: false, error: "company_membership_unresolved" };
  if (companyIds.length !== 1) return { ok: false, error: "company_membership_ambiguous" };

  const companyId = companyIds[0];
  const { data: company, error: companyErr } = await context.supabase
    .from("company")
    .select("id, is_active")
    .eq("id", companyId)
    .maybeSingle();

  if (companyErr) return { ok: false, error: "company_lookup_failed" };
  if (!company || company.is_active !== true) return { ok: false, error: "company_inactive" };

  const valid = new Set<AppRole>(ROLE_PRECEDENCE);
  const roles = [
    ...new Set(
      (memberships ?? [])
        .map((m: any) => String(m.role) as AppRole)
        .filter((r: AppRole) => valid.has(r)),
    ),
  ];

  return { ok: true, data: { companyId, roles } };
}

function requireRole(
  scope: ServerResult<CompanyScope>,
  allowed: readonly AppRole[],
): ServerResult<CompanyScope> {
  if (!scope.ok || !scope.data) return scope;
  if (!scope.data.roles.some((r) => allowed.includes(r))) {
    return { ok: false, error: "forbidden" };
  }
  return scope;
}

const CHANNEL_SELECT =
  "id, name, channel_type, is_active, company_id, widget_config_id, allowed_origins";

export const listChannelConfigsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ServerResult<LiveChannelConfigRow[]>> => {
    const scope = await resolveCompanyScope({
      supabase: context.supabase,
      userId: String(context.userId),
    });
    if (!scope.ok || !scope.data) return { ok: false, error: scope.error };

    const { data, error } = await context.supabase
      .from("channel_config")
      .select(CHANNEL_SELECT)
      .eq("company_id", scope.data.companyId)
      .order("channel_type", { ascending: true });

    if (error) return { ok: false, error: "channel_load_failed" };
    return { ok: true, data: (data ?? []) as LiveChannelConfigRow[] };
  });

const bindChannelCompanyInput = z.object({ channel_id: z.string().uuid() });

export const bindChannelToCurrentCompanyFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(bindChannelCompanyInput)
  .handler(async ({ data, context }): Promise<ServerResult<LiveChannelConfigRow>> => {
    const scope = requireRole(
      await resolveCompanyScope({
        supabase: context.supabase,
        userId: String(context.userId),
      }),
      ["admin"],
    );
    if (!scope.ok || !scope.data) return { ok: false, error: scope.error };

    const companyId = scope.data.companyId;
    const { data: channel, error: readErr } = await context.supabase
      .from("channel_config")
      .select(CHANNEL_SELECT)
      .eq("id", data.channel_id)
      .maybeSingle();

    if (readErr) return { ok: false, error: "channel_lookup_failed" };
    if (!channel) return { ok: false, error: "channel_not_found" };
    if (channel.company_id && String(channel.company_id) !== companyId) {
      return { ok: false, error: "channel_company_conflict" };
    }

    if (!channel.company_id) {
      const { data: updated, error } = await context.supabase
        .from("channel_config")
        .update({ company_id: companyId, updated_at: new Date().toISOString() })
        .eq("id", data.channel_id)
        .is("company_id", null)
        .select(CHANNEL_SELECT)
        .maybeSingle();
      if (error) return { ok: false, error: "channel_company_update_failed" };
      if (!updated) return { ok: false, error: "channel_company_update_conflict" };
      return { ok: true, data: updated as LiveChannelConfigRow };
    }
    return { ok: true, data: channel as LiveChannelConfigRow };
  });

function validOrigin(v: string): boolean {
  try {
    const u = new URL(v);
    if (u.pathname !== "/" || u.search || u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  } catch {
    return false;
  }
}

const updateChannelInput = z.object({
  channel_id: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  is_active: z.boolean().optional(),
  allowed_origins: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
});

export const updateChannelConfigFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(updateChannelInput)
  .handler(async ({ data, context }): Promise<ServerResult<LiveChannelConfigRow>> => {
    const scope = requireRole(
      await resolveCompanyScope({
        supabase: context.supabase,
        userId: String(context.userId),
      }),
      ["admin"],
    );
    if (!scope.ok || !scope.data) return { ok: false, error: scope.error };

    if (data.allowed_origins && data.allowed_origins.some((v) => !validOrigin(v))) {
      return { ok: false, error: "invalid_allowed_origin" };
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.is_active !== undefined) patch.is_active = data.is_active;
    if (data.allowed_origins !== undefined) patch.allowed_origins = [...new Set(data.allowed_origins)];

    const { data: updated, error } = await context.supabase
      .from("channel_config")
      .update(patch)
      .eq("id", data.channel_id)
      .eq("company_id", scope.data.companyId)
      .select(CHANNEL_SELECT)
      .maybeSingle();

    if (error) return { ok: false, error: "channel_update_failed" };
    if (!updated) return { ok: false, error: "channel_not_found_or_forbidden" };
    return { ok: true, data: updated as LiveChannelConfigRow };
  });

const widgetByChannelInput = z.object({ channel_id: z.string().uuid() });

async function resolveOwnedWidget(
  context: { supabase: any; userId: string },
  channelId: string,
  requireAdmin: boolean,
): Promise<ServerResult<{ companyId: string; widgetId: string }>> {
  let scope = await resolveCompanyScope(context);
  if (requireAdmin) scope = requireRole(scope, ["admin"]);
  if (!scope.ok || !scope.data) return { ok: false, error: scope.error };

  const { data: channel, error } = await context.supabase
    .from("channel_config")
    .select("id, company_id, widget_config_id")
    .eq("id", channelId)
    .eq("company_id", scope.data.companyId)
    .maybeSingle();

  if (error) return { ok: false, error: "channel_lookup_failed" };
  if (!channel) return { ok: false, error: "channel_not_found_or_forbidden" };
  if (!channel.widget_config_id) return { ok: false, error: "widget_not_configured" };

  return {
    ok: true,
    data: { companyId: scope.data.companyId, widgetId: String(channel.widget_config_id) },
  };
}

export const getWidgetConfigFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(widgetByChannelInput)
  .handler(async ({ data, context }): Promise<ServerResult<LiveWidgetConfigRow>> => {
    const owned = await resolveOwnedWidget(
      { supabase: context.supabase, userId: String(context.userId) },
      data.channel_id,
      false,
    );
    if (!owned.ok || !owned.data) return { ok: false, error: owned.error };

    const { data: widget, error } = await context.supabase
      .from("widget_config")
      .select("id, name, header_title, welcome_message, placeholder_text, primary_color, logo_url, is_active, appearance_theme")
      .eq("id", owned.data.widgetId)
      .maybeSingle();

    if (error) return { ok: false, error: "widget_load_failed" };
    if (!widget) return { ok: false, error: "widget_not_found" };
    return { ok: true, data: widget as LiveWidgetConfigRow };
  });

const updateWidgetInput = z.object({
  channel_id: z.string().uuid(),
  header_title: z.string().trim().min(1).max(120).optional(),
  welcome_message: z.string().max(1000).nullable().optional(),
  placeholder_text: z.string().max(200).nullable().optional(),
  primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  logo_url: z.string().url().max(2048).nullable().optional(),
  is_active: z.boolean().optional(),
  appearance_theme: z.enum(["modern", "classic"]).optional(),
});

export const updateWidgetConfigFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(updateWidgetInput)
  .handler(async ({ data, context }): Promise<ServerResult<LiveWidgetConfigRow>> => {
    const owned = await resolveOwnedWidget(
      { supabase: context.supabase, userId: String(context.userId) },
      data.channel_id,
      true,
    );
    if (!owned.ok || !owned.data) return { ok: false, error: owned.error };

    // widget_config has no company_id. Fail closed unless every channel
    // referencing this widget belongs to exactly the same company.
    const { data: links, error: linksErr } = await context.supabase
      .from("channel_config")
      .select("company_id")
      .eq("widget_config_id", owned.data.widgetId);

    if (linksErr) return { ok: false, error: "widget_ownership_check_failed" };
    const unsafeLink = (links ?? []).some(
      (row: any) => !row.company_id || String(row.company_id) !== owned.data!.companyId,
    );
    if (unsafeLink) return { ok: false, error: "widget_shared_or_unbound" };

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of [
      "header_title",
      "welcome_message",
      "placeholder_text",
      "primary_color",
      "logo_url",
      "is_active",
      "appearance_theme",
    ] as const) {
      if (data[key] !== undefined) patch[key] = data[key];
    }

    const { data: widget, error } = await context.supabase
      .from("widget_config")
      .update(patch)
      .eq("id", owned.data.widgetId)
      .select("id, name, header_title, welcome_message, placeholder_text, primary_color, logo_url, is_active, appearance_theme")
      .maybeSingle();

    if (error) return { ok: false, error: "widget_update_failed" };
    if (!widget) return { ok: false, error: "widget_update_conflict" };
    return { ok: true, data: widget as LiveWidgetConfigRow };
  });

const updateSelfProfileInput = z.object({
  display_name: z.string().trim().min(1).max(80).optional(),
  avatar_url: z.string().url().max(2048).nullable().optional(),
});

export const updateAgentProfileFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(updateSelfProfileInput)
  .handler(async ({ data, context }): Promise<ServerResult<{ display_name: string; avatar_url: string | null }>> => {
    if (data.display_name === undefined && data.avatar_url === undefined) {
      return { ok: false, error: "no_changes" };
    }
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.display_name !== undefined) patch.display_name = data.display_name;
    if (data.avatar_url !== undefined) patch.avatar_url = data.avatar_url;

    const { data: row, error } = await context.supabase
      .from("agent_profile")
      .update(patch)
      .eq("user_id", String(context.userId))
      .select("display_name, avatar_url")
      .maybeSingle();

    if (error) return { ok: false, error: "profile_update_failed" };
    if (!row) return { ok: false, error: "profile_not_found_or_forbidden" };
    return { ok: true, data: row as { display_name: string; avatar_url: string | null } };
  });

async function resolveSingleActiveCompany(context: {
  supabase: any;
  userId: string;
}): Promise<ServerResult<string>> {
  const scope = await resolveCompanyScope(context);
  return scope.ok && scope.data
    ? { ok: true, data: scope.data.companyId }
    : { ok: false, error: scope.error };
}

export const getFeedbackConfigFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ServerResult<LiveFeedbackConfigRow | null>> => {
    const company = await resolveSingleActiveCompany({
      supabase: context.supabase,
      userId: String(context.userId),
    });
    if (!company.ok || !company.data) return { ok: false, error: company.error };

    const { data, error } = await context.supabase
      .from("feedback_automation_config")
      .select("id, name, is_active, delay_minutes, trigger_event, config, company_id")
      .eq("company_id", company.data)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: (data as LiveFeedbackConfigRow | null) ?? null };
  });

const updateFeedbackInput = z.object({
  is_active: z.boolean().optional(),
  delay_minutes: z.number().int().min(1440).max(43200).optional(),
  config: z.record(z.string(), z.any()).optional(),
});

export const updateFeedbackConfigFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(updateFeedbackInput)
  .handler(async ({ data, context }): Promise<ServerResult<LiveFeedbackConfigRow>> => {
    const scope = requireRole(
      await resolveCompanyScope({
        supabase: context.supabase,
        userId: String(context.userId),
      }),
      ["admin", "supervisor"],
    );
    if (!scope.ok || !scope.data) return { ok: false, error: scope.error };
    const companyId = scope.data.companyId;

    const { data: existing, error: readErr } = await context.supabase
      .from("feedback_automation_config")
      .select("id")
      .eq("company_id", companyId)
      .maybeSingle();
    if (readErr) return { ok: false, error: `read_before_write_failed: ${readErr.message}` };

    let targetId: string;
    if (!existing) {
      const { data: inserted, error } = await context.supabase
        .from("feedback_automation_config")
        .insert({
          name: "Default Feedback Automation",
          trigger_event: "conversation_resolved",
          is_active: data.is_active ?? false,
          delay_minutes: data.delay_minutes ?? 1440,
          config: (data.config ?? {}) as never,
          company_id: companyId,
        } as never)
        .select("id")
        .single();
      if (error) return { ok: false, error: `insert_failed: ${error.message}` };
      targetId = inserted.id;
    } else {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (data.is_active !== undefined) patch.is_active = data.is_active;
      if (data.delay_minutes !== undefined) patch.delay_minutes = data.delay_minutes;
      if (data.config !== undefined) patch.config = data.config;
      const { data: updated, error } = await context.supabase
        .from("feedback_automation_config")
        .update(patch as never)
        .eq("id", existing.id)
        .eq("company_id", companyId)
        .select("id")
        .maybeSingle();
      if (error) return { ok: false, error: `update_failed: ${error.message}` };
      if (!updated) return { ok: false, error: "update_failed: row not updated" };
      targetId = existing.id;
    }

    const { data: verified, error: verifyErr } = await context.supabase
      .from("feedback_automation_config")
      .select("id, name, is_active, delay_minutes, trigger_event, config, company_id")
      .eq("id", targetId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (verifyErr || !verified) return { ok: false, error: "verify_read_failed" };
    return { ok: true, data: verified as LiveFeedbackConfigRow };
  });

export const configService = {
  listChannelConfigs: () => listChannelConfigsFn(),
  bindChannelToCurrentCompany: (channelId: string) =>
    bindChannelToCurrentCompanyFn({ data: { channel_id: channelId } }),
  updateChannelConfig: (params: z.infer<typeof updateChannelInput>) =>
    updateChannelConfigFn({ data: params }),
  getWidgetConfig: (channelId: string) =>
    getWidgetConfigFn({ data: { channel_id: channelId } }),
  updateWidgetConfig: (params: z.infer<typeof updateWidgetInput>) =>
    updateWidgetConfigFn({ data: params }),
  updateAgentProfile: (params: z.infer<typeof updateSelfProfileInput>) =>
    updateAgentProfileFn({ data: params }),
  getFeedbackConfig: () => getFeedbackConfigFn(),
  updateFeedbackConfig: (params: z.infer<typeof updateFeedbackInput>) =>
    updateFeedbackConfigFn({ data: params }),
};

const PREVIEW_ADMIN_EMAILS = new Set([
  "frankien.ng@gmail.com",
  "frankien.mega001@gmail.com",
]);

/**
 * FRONTEND ACCEPTANCE ONLY.
 *
 * The canonical production authority remains company_membership. This bridge is
 * intentionally reachable only on Lovable's isolated id-preview hostname (or
 * localhost) and only for explicitly named UAT admin accounts. It never writes
 * company/company_membership and never changes server-side RBAC/RLS.
 *
 * Product-ready integration must provide the real SU Platform company UUID/int;
 * once canonical membership exists this bridge is irrelevant because the
 * canonical role is returned first.
 */
async function resolvePreviewAcceptanceRole(): Promise<AppRole | null> {
  if (typeof window === "undefined") return null;

  const host = window.location.hostname.toLowerCase();
  const isLovableIdPreview =
    host.startsWith("id-preview--") && host.endsWith(".lovable.app");
  const isLocalhost = host === "localhost" || host === "127.0.0.1";
  if (!isLovableIdPreview && !isLocalhost) return null;

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.email) return null;

  const email = data.user.email.trim().toLowerCase();
  return PREVIEW_ADMIN_EMAILS.has(email) ? "admin" : null;
}

async function getCurrentCompanyRoles(): Promise<AppRole[]> {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id;
  if (!userId) return [];

  const { data: memberships, error } = await supabase
    .from("company_membership")
    .select("company_id, role")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (error || !memberships?.length) return [];

  const companyIds = [...new Set(memberships.map((m) => String(m.company_id)))];
  if (companyIds.length !== 1) return [];

  const { data: company, error: companyErr } = await supabase
    .from("company")
    .select("id, is_active")
    .eq("id", companyIds[0])
    .maybeSingle();
  if (companyErr || !company || company.is_active !== true) return [];

  const valid = new Set<AppRole>(ROLE_PRECEDENCE);
  return [
    ...new Set(
      memberships
        .map((m) => String(m.role) as AppRole)
        .filter((r): r is AppRole => valid.has(r)),
    ),
  ];
}

export const authService = {
  getCurrentUserRole: async (): Promise<AppRole | null> => {
    const roles = await getCurrentCompanyRoles();
    for (const candidate of ROLE_PRECEDENCE) {
      if (roles.includes(candidate)) return candidate;
    }

    // Frontend acceptance bridge only. Never use this result for server writes,
    // RLS, tenant resolution, or production authorization.
    return await resolvePreviewAcceptanceRole();
  },
  getCurrentUserRoles: async (): Promise<AppRole[]> => {
    const roles = await getCurrentCompanyRoles();
    if (roles.length > 0) return roles;
    const previewRole = await resolvePreviewAcceptanceRole();
    return previewRole ? [previewRole] : [];
  },
};
