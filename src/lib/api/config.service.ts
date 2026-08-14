// P2: server-function binding layer.
// Browser-facing service (aiChatbotSettingsService) delegates here.
// All writes go through createServerFn + requireSupabaseAuth (RLS enforces admin).
// No direct browser-side supabase.from().update()/.insert() anywhere.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ---------------------------------------------------------------------------
// Shapes returned across the RPC boundary (plain DTOs only)
// ---------------------------------------------------------------------------

export interface LiveChannelConfigRow {
  id: string;
  name: string;
  channel_type: string;
  is_active: boolean;
  company_id: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------

async function resolveSingleActiveCompany(context: {
  supabase: any;
  userId: string;
}): Promise<ServerResult<string>> {
  const userId = String(context.userId);
  const { data: memberships, error: membershipErr } = await context.supabase
    .from("company_membership")
    .select("company_id, is_active")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (membershipErr) return { ok: false, error: "company_membership_lookup_failed" };

  const companyIds = [
    ...new Set((memberships ?? []).map((m: { company_id: string }) => String(m.company_id))),
  ];

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

  return { ok: true, data: companyId };
}

export const listChannelConfigsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ServerResult<LiveChannelConfigRow[]>> => {
    const { data, error } = await context.supabase
      .from("channel_config")
      .select("id, name, channel_type, is_active, company_id")
      .order("channel_type", { ascending: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: (data ?? []) as LiveChannelConfigRow[] };
  });

const bindChannelCompanyInput = z.object({
  channel_id: z.string().uuid(),
});

export const bindChannelToCurrentCompanyFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(bindChannelCompanyInput)
  .handler(async ({ data, context }): Promise<ServerResult<LiveChannelConfigRow>> => {
    const userId = String(context.userId);

    // Company-scoped RBAC is authoritative. A global user_roles row must never
    // grant or deny a tenant action independently of active membership.
    const { data: memberships, error: membershipErr } = await context.supabase
      .from("company_membership")
      .select("company_id, role, is_active")
      .eq("user_id", userId)
      .eq("role", "admin")
      .eq("is_active", true);
    if (membershipErr) return { ok: false, error: "company_membership_lookup_failed" };

    const companyIds = [...new Set((memberships ?? []).map((m) => String(m.company_id)))];
    if (companyIds.length === 0) {
      return { ok: false, error: "company_membership_unresolved" };
    }
    if (companyIds.length !== 1) {
      return { ok: false, error: "company_membership_ambiguous" };
    }
    const companyId = companyIds[0];

    const { data: company, error: companyErr } = await context.supabase
      .from("company")
      .select("id, is_active")
      .eq("id", companyId)
      .maybeSingle();
    if (companyErr) return { ok: false, error: "company_lookup_failed" };
    if (!company || company.is_active !== true) {
      return { ok: false, error: "company_inactive" };
    }

    const { data: channel, error: channelReadErr } = await context.supabase
      .from("channel_config")
      .select("id, name, channel_type, is_active, company_id")
      .eq("id", data.channel_id)
      .maybeSingle();
    if (channelReadErr) return { ok: false, error: "channel_lookup_failed" };
    if (!channel) return { ok: false, error: "channel_not_found" };

    if (channel.company_id && String(channel.company_id) !== companyId) {
      return { ok: false, error: "channel_company_conflict" };
    }

    if (!channel.company_id) {
      const { data: updated, error: updateErr } = await context.supabase
        .from("channel_config")
        .update({ company_id: companyId })
        .eq("id", data.channel_id)
        .is("company_id", null)
        .select("id, name, channel_type, is_active, company_id")
        .maybeSingle();
      if (updateErr) return { ok: false, error: "channel_company_update_failed" };
      if (!updated) return { ok: false, error: "channel_company_update_conflict" };
      return { ok: true, data: updated as LiveChannelConfigRow };
    }

    return { ok: true, data: channel as LiveChannelConfigRow };
  });

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
    return {
      ok: true,
      data: (data as LiveFeedbackConfigRow | null) ?? null,
    };
  });

const updateFeedbackInput = z.object({
  is_active: z.boolean().optional(),
  delay_minutes: z.number().int().min(1440).max(43200).optional(),
  config: z.record(z.string(), z.any()).optional(),
});
export type UpdateFeedbackInput = {
  is_active?: boolean;
  delay_minutes?: number;
  config?: JsonRecord;
};

export const updateFeedbackConfigFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(updateFeedbackInput)
  .handler(async ({ data, context }): Promise<ServerResult<LiveFeedbackConfigRow>> => {
    const company = await resolveSingleActiveCompany({
      supabase: context.supabase,
      userId: String(context.userId),
    });
    if (!company.ok || !company.data) return { ok: false, error: company.error };
    const companyId = company.data;

    const { data: existing, error: readErr } = await context.supabase
      .from("feedback_automation_config")
      .select("id")
      .eq("company_id", companyId)
      .maybeSingle();
    if (readErr) return { ok: false, error: `read_before_write_failed: ${readErr.message}` };

    let targetId: string;

    if (!existing) {
      const { data: inserted, error: insertErr } = await context.supabase
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
      if (insertErr) return { ok: false, error: `insert_failed: ${insertErr.message}` };
      targetId = inserted.id;
    } else {
      const updatePayload: {
        is_active?: boolean;
        delay_minutes?: number;
        config?: JsonRecord;
        updated_at: string;
      } = { updated_at: new Date().toISOString() };
      if (data.is_active !== undefined) updatePayload.is_active = data.is_active;
      if (data.delay_minutes !== undefined) updatePayload.delay_minutes = data.delay_minutes;
      if (data.config !== undefined) updatePayload.config = data.config;

      const { data: updated, error: updateErr } = await context.supabase
        .from("feedback_automation_config")
        .update(updatePayload as never)
        .eq("id", existing.id)
        .eq("company_id", companyId)
        .select("id")
        .maybeSingle();
      if (updateErr) return { ok: false, error: `update_failed: ${updateErr.message}` };
      if (!updated) return { ok: false, error: "update_failed: row not updated (RLS or missing)" };
      targetId = existing.id;
    }

    const { data: verified, error: verifyErr } = await context.supabase
      .from("feedback_automation_config")
      .select("id, name, is_active, delay_minutes, trigger_event, config, company_id")
      .eq("id", targetId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (verifyErr) return { ok: false, error: `verify_read_failed: ${verifyErr.message}` };
    if (!verified) return { ok: false, error: "verify_read_failed: row missing after write" };
    return { ok: true, data: verified as LiveFeedbackConfigRow };
  });

// ---------------------------------------------------------------------------
// Client-side facade (existing API surface, now backed by server functions)
// ---------------------------------------------------------------------------

export const configService = {
  listChannelConfigs: () => listChannelConfigsFn(),
  bindChannelToCurrentCompany: (channelId: string) =>
    bindChannelToCurrentCompanyFn({ data: { channel_id: channelId } }),
  getFeedbackConfig: () => getFeedbackConfigFn(),
  updateFeedbackConfig: (params: z.infer<typeof updateFeedbackInput>) =>
    updateFeedbackConfigFn({ data: params }),

  // P2 out-of-scope stubs preserved for future work.
  updateWidgetConfig: async (_p: unknown): Promise<ServerResult<never>> => ({
    ok: false,
    error: "Not implemented (P2 out of scope).",
  }),
  updateChannelConfig: async (_p: unknown): Promise<ServerResult<never>> => ({
    ok: false,
    error: "Not implemented (P2 out of scope).",
  }),
  updateAgentProfile: async (_p: unknown): Promise<ServerResult<never>> => ({
    ok: false,
    error: "Not implemented (P2 out of scope).",
  }),
};

// L7A back-compat export.
export const DEFERRED_RESPONSE = {
  ok: false as const,
  deferred: true as const,
  message: "Config save available after L7B binding.",
};
export type DeferredResponse = typeof DEFERRED_RESPONSE;

// Read stubs (unchanged) — kept to avoid breaking callers.
export const agentService = {
  listAgents: async (): Promise<{ data: unknown[]; error: null }> => ({ data: [], error: null }),
};
export const analyticsService = {
  getSummary: async (): Promise<{ data: null; error: null }> => ({ data: null, error: null }),
};

// ---------------------------------------------------------------------------
// Production role model
// ---------------------------------------------------------------------------
export type AppRole = "admin" | "supervisor" | "agent" | "qa";

const ROLE_PRECEDENCE: AppRole[] = ["admin", "supervisor", "agent", "qa"];

async function getCurrentCompanyRoles(): Promise<AppRole[]> {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id;
  if (!userId) return [];

  // Role authority is the active membership in exactly one active company.
  // Ambiguous multi-company sessions fail closed until an explicit company
  // selector/context contract exists.
  const { data: memberships, error: membershipErr } = await supabase
    .from("company_membership")
    .select("company_id, role, is_active")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (membershipErr || !memberships || memberships.length === 0) return [];

  const companyIds = [
    ...new Set(memberships.map((m) => String(m.company_id))),
  ];
  if (companyIds.length !== 1) return [];

  const companyId = companyIds[0];
  const { data: company, error: companyErr } = await supabase
    .from("company")
    .select("id, is_active")
    .eq("id", companyId)
    .maybeSingle();
  if (companyErr || !company || company.is_active !== true) return [];

  const valid = new Set<AppRole>(["admin", "supervisor", "agent", "qa"]);
  return [
    ...new Set(
      memberships
        .map((m) => String(m.role) as AppRole)
        .filter((role): role is AppRole => valid.has(role)),
    ),
  ];
}

export const authService = {
  getCurrentUserRole: async (): Promise<AppRole | null> => {
    const roles = await getCurrentCompanyRoles();
    for (const candidate of ROLE_PRECEDENCE) {
      if (roles.includes(candidate)) return candidate;
    }
    return null;
  },

  /** All roles held inside the current unique active company, unordered. */
  getCurrentUserRoles: async (): Promise<AppRole[]> =>
    getCurrentCompanyRoles(),
};
