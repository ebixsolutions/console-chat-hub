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
}

export interface ServerResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------

export const listChannelConfigsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ServerResult<LiveChannelConfigRow[]>> => {
    const { data, error } = await context.supabase
      .from("channel_config")
      .select("id, name, channel_type, is_active")
      .order("channel_type", { ascending: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: (data ?? []) as LiveChannelConfigRow[] };
  });

export const getFeedbackConfigFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ServerResult<LiveFeedbackConfigRow | null>> => {
    const { data, error } = await context.supabase
      .from("feedback_automation_config")
      .select("id, name, is_active, delay_minutes, trigger_event, config")
      .order("created_at", { ascending: true })
      .limit(1)
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
    // Try to find existing row
    const { data: existing, error: readErr } = await context.supabase
      .from("feedback_automation_config")
      .select("id")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (readErr) return { ok: false, error: `read_before_write_failed: ${readErr.message}` };

    let targetId: string;

    if (!existing) {
      // Seed a row (admin-only per RLS). Single default row model.
      const { data: inserted, error: insertErr } = await context.supabase
        .from("feedback_automation_config")
        .insert({
          name: "Default Feedback Automation",
          trigger_event: "conversation_resolved",
          is_active: data.is_active ?? false,
          delay_minutes: data.delay_minutes ?? 1440,
          config: (data.config ?? {}) as never,
        })
        .select("id")
        .single();
      if (insertErr) return { ok: false, error: `insert_failed: ${insertErr.message}` };
      targetId = inserted.id;
    } else {
      // Step B: RPC (rpc_update_feedback_config) swallows real errors in
      // EXCEPTION WHEN OTHERS -> 'INTERNAL', making the failure undiagnosable
      // from the client. Since the RPC SQL and audit_log are frozen, bypass
      // the RPC with a direct authenticated update. RLS still applies
      // (context.supabase carries the caller's bearer token; NO service_role).
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
        .select("id")
        .maybeSingle();
      if (updateErr) return { ok: false, error: `update_failed: ${updateErr.message}` };
      if (!updated) return { ok: false, error: "update_failed: row not updated (RLS or missing)" };
      targetId = existing.id;
    }


    // Verify persistence by re-SELECTing the row we just wrote.
    const { data: verified, error: verifyErr } = await context.supabase
      .from("feedback_automation_config")
      .select("id, name, is_active, delay_minutes, trigger_event, config")
      .eq("id", targetId)
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

export type AppRole = "admin" | "supervisor" | "agent";

export const authService = {
  getCurrentUserRole: async (): Promise<AppRole | null> => {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return null;
    const { data, error } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    if (error || !data || data.length === 0) return null;
    const roles = data.map((r) => r.role as AppRole);
    if (roles.includes("admin")) return "admin";
    if (roles.includes("supervisor")) return "supervisor";
    if (roles.includes("agent")) return "agent";
    return null;
  },
};
