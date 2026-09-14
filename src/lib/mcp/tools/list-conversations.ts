import { createClient } from "@supabase/supabase-js";
import { resolveAuthoritativeSupabaseBinding } from "@/integrations/supabase/runtime-authority.mjs";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  const binding = resolveAuthoritativeSupabaseBinding({
    url: process.env.SUPABASE_URL,
    projectId: process.env.SUPABASE_PROJECT_ID,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  });
  return createClient(binding.url, binding.publishableKey, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "list_conversations",
  title: "List conversations",
  description:
    "List support conversations visible to the signed-in user, ordered by most recently updated.",
  inputSchema: {
    status: z
      .enum(["open", "pending", "resolved"])
      .optional()
      .describe("Optional status filter."),
    limit: z.number().int().min(1).max(100).default(20).describe("Max rows to return (1-100)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ status, limit }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const sb = supabaseForUser(ctx);
    let q = sb
      .from("conversations")
      .select("id, status, assigned_agent_id, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error)
      return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { conversations: data ?? [] },
    };
  },
});
