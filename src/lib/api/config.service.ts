// L7A: interface stubs ONLY — no supabase.rpc() calls.
// L7B will replace stub bodies with real supabase.rpc() calls.
import { supabase } from "@/integrations/supabase/client";

export const DEFERRED_RESPONSE = {
  ok: false as const,
  deferred: true as const,
  message: "Config save available after L7B binding.",
};

export type DeferredResponse = typeof DEFERRED_RESPONSE;

export const configService = {
  updateWidgetConfig: async (_params: unknown): Promise<DeferredResponse> => DEFERRED_RESPONSE,
  updateChannelConfig: async (_params: unknown): Promise<DeferredResponse> => DEFERRED_RESPONSE,
  updateFeedbackConfig: async (_params: unknown): Promise<DeferredResponse> => DEFERRED_RESPONSE,
  updateAgentProfile: async (_params: unknown): Promise<DeferredResponse> => DEFERRED_RESPONSE,
};

// Read stubs — components import these; no supabase.from() in route components.
export const agentService = {
  // L7A: stub returns empty array — agent own-profile row deferred to L7B.
  listAgents: async (): Promise<{ data: unknown[]; error: null }> => ({ data: [], error: null }),
};

export const analyticsService = {
  getSummary: async (): Promise<{ data: null; error: null }> => ({ data: null, error: null }),
};

// Role lookup — uses user_roles per project security pattern.
// Centralized here so route components do not scatter supabase.from() calls.
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
