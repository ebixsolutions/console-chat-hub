import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export default defineTool({
  name: "get_conversation",
  title: "Get conversation with messages",
  description: "Fetch a single conversation and its messages (oldest first).",
  inputSchema: {
    conversation_id: z.string().uuid().describe("Conversation UUID."),
    message_limit: z.number().int().min(1).max(500).default(100),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ conversation_id, message_limit }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const sb = supabaseForUser(ctx);
    const [{ data: conv, error: cErr }, { data: msgs, error: mErr }] = await Promise.all([
      sb.from("conversations").select("*").eq("id", conversation_id).maybeSingle(),
      sb
        .from("messages")
        .select("id, role, content, status, created_at")
        .eq("conversation_id", conversation_id)
        .order("created_at", { ascending: true })
        .limit(message_limit),
    ]);
    if (cErr || mErr)
      return {
        content: [{ type: "text", text: (cErr ?? mErr)!.message }],
        isError: true,
      };
    if (!conv)
      return { content: [{ type: "text", text: "Conversation not found" }], isError: true };
    const payload = { conversation: conv, messages: msgs ?? [] };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  },
});
