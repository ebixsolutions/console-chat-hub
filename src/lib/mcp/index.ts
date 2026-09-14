import { auth, defineMcp } from "@lovable.dev/mcp-js";
import whoamiTool from "./tools/whoami";
import listConversationsTool from "./tools/list-conversations";
import getConversationTool from "./tools/get-conversation";
import { AUTHORITATIVE_SUPABASE_PROJECT_ID } from "@/integrations/supabase/runtime-authority.mjs";

// Direct Supabase issuer (proxy hostnames are rejected by RFC 8414 issuer match).
// Bound to the authoritative user-owned project, never an injected substitute.
const projectRef = AUTHORITATIVE_SUPABASE_PROJECT_ID;

export default defineMcp({
  name: "ai-chatbot-console-mcp",
  title: "AI Chatbot Console MCP",
  version: "0.1.0",
  instructions:
    "Tools for the AI Chatbot support console. Use `whoami` to verify auth, `list_conversations` to browse tickets, and `get_conversation` to read a thread with messages. All calls run as the signed-in user under RLS.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [whoamiTool, listConversationsTool, getConversationTool],
});
