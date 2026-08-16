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

export type WidgetLauncherIcon = "chat" | "headset" | "sparkles" | "bot" | "mail";

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
  launcher_icon: WidgetLauncherIcon;
}

export type JsonRecord = Record<string, any>;

export interface LiveFeedbackConfigRow {
  id: string;
  name: string;
  is_active: boolean;
  delay_minutes: number | null;
  trigger_event: string;
  config: JsonRecord | null;
  /**
   * feedback_automation_config is a pre-canonical, company-unbound table: it has
   * no company_id column. Scope is therefore always null-company until the real
   * platform binding introduces one.
   */
  company_id: null;
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
    .select("company_id, role, is_active")
    .eq("user_id", String(context.userId));

  if (membershipErr) return { ok: false, error: "company_membership_lookup_failed" };

  const allMemberships = memberships ?? [];
  const companyIds = [...new Set(allMemberships.map((m: any) => String(m.company_id)))];
  if (companyIds.length === 0) return { ok: false, error: "company_membership_unresolved" };
  if (companyIds.length !== 1) return { ok: false, error: "company_membership_ambiguous" };

  const companyId = companyIds[0];
  const activeMemberships = allMemberships.filter(
    (membership: any) => membership.is_active === true && String(membership.company_id) === companyId,
  );
  if (activeMemberships.length === 0) return { ok: false, error: "not_a_member" };
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
      activeMemberships
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

const WIDGET_LAUNCHER_ICONS = new Set<WidgetLauncherIcon>(["chat", "headset", "sparkles", "bot", "mail"]);

function normalizeWidgetRow(row: any): LiveWidgetConfigRow {
  const theme: "modern" | "classic" = row?.appearance_theme === "classic" ? "classic" : "modern";
  const rawIcon = String(row?.launcher_icon ?? "chat") as WidgetLauncherIcon;
  const launcherIcon: WidgetLauncherIcon = WIDGET_LAUNCHER_ICONS.has(rawIcon) ? rawIcon : "chat";
  return {
    id: String(row.id),
    name: String(row.name ?? "Widget"),
    header_title: String(row.header_title ?? "Customer Support"),
    welcome_message: row.welcome_message == null ? null : String(row.welcome_message),
    placeholder_text: row.placeholder_text == null ? null : String(row.placeholder_text),
    primary_color: row.primary_color == null ? null : String(row.primary_color),
    logo_url: row.logo_url == null ? null : String(row.logo_url),
    is_active: row.is_active == null ? null : Boolean(row.is_active),
    appearance_theme: theme,
    launcher_icon: launcherIcon,
  };
}

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
      .select("*")
      .eq("id", owned.data.widgetId)
      .maybeSingle();

    if (error) return { ok: false, error: "widget_load_failed" };
    if (!widget) return { ok: false, error: "widget_not_found" };
    return { ok: true, data: normalizeWidgetRow(widget) };
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
  launcher_icon: z.enum(["chat", "headset", "sparkles", "bot", "mail"]).optional(),
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
      "launcher_icon",
    ] as const) {
      if (data[key] !== undefined) patch[key] = data[key];
    }

    const { data: widget, error } = await context.supabase
      .from("widget_config")
      .update(patch)
      .eq("id", owned.data.widgetId)
      .select("*")
      .maybeSingle();

    if (error) return { ok: false, error: "widget_update_failed" };
    if (!widget) return { ok: false, error: "widget_update_conflict" };
    return { ok: true, data: normalizeWidgetRow(widget) };
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

/**
 * Shared pre-activation scope semantics for config surfaces.
 *
 * Canonical always wins: when the caller has canonical company membership the
 * canonical company/role authorization is enforced exactly as before. Only when
 * canonical identity is genuinely absent (no membership rows at all, i.e. the
 * SU Platform binding has not happened yet) does the caller fall back to
 * pre-activation mode, which is limited to authenticated authorized roles and to
 * null-company records. No company id is ever fabricated.
 */
type ConfigScope =
  | { mode: "canonical"; companyId: string; roles: AppRole[] }
  | { mode: "pre_activation"; companyId: null; roles: AppRole[] };

async function resolveConfigScope(
  context: { supabase: any; userId: string },
  allowed: readonly AppRole[],
): Promise<ServerResult<ConfigScope>> {
  const canonical = await resolveCompanyScope(context);
  if (canonical.ok && canonical.data) {
    if (!canonical.data.roles.some((r) => allowed.includes(r))) {
      return { ok: false, error: "forbidden" };
    }
    return {
      ok: true,
      data: {
        mode: "canonical",
        companyId: canonical.data.companyId,
        roles: canonical.data.roles,
      },
    };
  }

  // Canonical company exists but the caller is not an active member, the company
  // is inactive, or membership is ambiguous: stay fail-closed, never fall back.
  if (canonical.error !== "company_membership_unresolved") {
    return { ok: false, error: canonical.error };
  }

  const { data: roleRows, error: roleErr } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", String(context.userId));
  if (roleErr) return { ok: false, error: "role_lookup_failed" };

  const valid = new Set<AppRole>(ROLE_PRECEDENCE);
  const roles: AppRole[] = [
    ...new Set(
      (roleRows ?? [])
        .map((r: any) => String(r.role) as AppRole)
        .filter((r: AppRole) => valid.has(r)),
    ),
  ] as AppRole[];

  if (!roles.some((r) => allowed.includes(r))) {
    return { ok: false, error: "forbidden" };
  }
  return { ok: true, data: { mode: "pre_activation", companyId: null, roles } };
}

/**
 * feedback_automation_config has no company_id column: it is a single
 * pre-canonical configuration row. Authorization is therefore role-based via
 * resolveConfigScope (canonical membership role first, pre-activation role only
 * when canonical identity is genuinely absent) and reads/writes are never
 * filtered on a company column that does not exist.
 */
const FEEDBACK_SELECT = "id, name, is_active, delay_minutes, trigger_event, config";

function normalizeFeedbackRow(row: any): LiveFeedbackConfigRow {
  return {
    id: String(row.id),
    name: String(row.name),
    is_active: row.is_active === true,
    delay_minutes: row.delay_minutes ?? null,
    trigger_event: String(row.trigger_event),
    config: (row.config ?? null) as JsonRecord | null,
    company_id: null,
  };
}

export const getFeedbackConfigFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ServerResult<LiveFeedbackConfigRow | null>> => {
    const scope = await resolveConfigScope(
      { supabase: context.supabase, userId: String(context.userId) },
      ["admin", "supervisor", "qa"],
    );
    if (!scope.ok || !scope.data) return { ok: false, error: scope.error };

    const { data, error } = await context.supabase
      .from("feedback_automation_config")
      .select(FEEDBACK_SELECT)
      .eq("trigger_event", "conversation_resolved")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: data ? normalizeFeedbackRow(data) : null };
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
    const scope = await resolveConfigScope(
      { supabase: context.supabase, userId: String(context.userId) },
      ["admin", "supervisor"],
    );
    if (!scope.ok || !scope.data) return { ok: false, error: scope.error };

    const { data: existing, error: readErr } = await context.supabase
      .from("feedback_automation_config")
      .select("id")
      .eq("trigger_event", "conversation_resolved")
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
        } as never)
        .select("id")
        .single();
      if (error) return { ok: false, error: `insert_failed: ${error.message}` };
      targetId = String(inserted.id);
    } else {
      const patch: Record<string, any> = { updated_at: new Date().toISOString() };
      if (data.is_active !== undefined) patch.is_active = data.is_active;
      if (data.delay_minutes !== undefined) patch.delay_minutes = data.delay_minutes;
      if (data.config !== undefined) patch.config = data.config;
      const { data: updated, error } = await context.supabase
        .from("feedback_automation_config")
        .update(patch as never)
        .eq("id", existing.id)
        .select("id")
        .maybeSingle();
      if (error) return { ok: false, error: `update_failed: ${error.message}` };
      if (!updated) return { ok: false, error: "update_failed: row not updated" };
      targetId = String(existing.id);
    }

    const { data: verified, error: verifyErr } = await context.supabase
      .from("feedback_automation_config")
      .select(FEEDBACK_SELECT)
      .eq("id", targetId)
      .maybeSingle();
    if (verifyErr || !verified) return { ok: false, error: "verify_read_failed" };
    return { ok: true, data: normalizeFeedbackRow(verified) };
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
const PREVIEW_PROJECT_ID = "4dbf593e-577e-4af4-a553-460441c34473";

export function isApprovedLovablePreviewHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;

  // Current Lovable editor Preview host:
  //   <project-id>.lovableproject.com
  // Some preview sessions may prepend an isolated preview token:
  //   <preview-token>--<project-id>.lovableproject.com
  const lovableProjectHost = `${PREVIEW_PROJECT_ID}.lovableproject.com`;
  if (host === lovableProjectHost) return true;

  const lovableProjectSuffix = `--${lovableProjectHost}`;
  if (host.endsWith(lovableProjectSuffix)) {
    const prefix = host.slice(0, -lovableProjectSuffix.length);
    if (/^[a-z0-9][a-z0-9-]*$/.test(prefix)) return true;
  }

  // Older Lovable isolated identity-preview hosts:
  //   id-preview--<project-id>.lovable.app
  //   id-preview-<preview-id>--<project-id>.lovable.app
  const lovableAppSuffix = `--${PREVIEW_PROJECT_ID}.lovable.app`;
  if (host.endsWith(lovableAppSuffix)) {
    const prefix = host.slice(0, -lovableAppSuffix.length);
    if (/^id-preview(?:-[a-z0-9-]+)?$/.test(prefix)) return true;
  }

  // Important: the published app hostname (for example
  // console-chat-hub.lovable.app) never matches either project-scoped rule.
  return false;
}

/**
 * FRONTEND ACCEPTANCE ONLY.
 *
 * The canonical production authority remains company_membership. This bridge is
 * intentionally reachable only on this project's Lovable editor Preview hosts
 * (or localhost) and only for explicitly named UAT admin accounts. It never writes
 * company/company_membership and never changes server-side RBAC/RLS.
 *
 * Product-ready integration must provide the real SU Platform company UUID/int;
 * once canonical membership exists this bridge is irrelevant because the
 * canonical role is returned first.
 */
async function resolvePreviewAcceptanceRole(): Promise<AppRole | null> {
  if (typeof window === "undefined") return null;

  const host = window.location.hostname.toLowerCase();
  const isLovableIdPreview = isApprovedLovablePreviewHost(host);
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
