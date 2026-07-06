import { auth, defineMcp } from "@lovable.dev/mcp-js";
import whoamiTool from "./tools/whoami";
import listConversationsTool from "./tools/list-conversations";
import getConversationTool from "./tools/get-conversation";

// Direct Supabase issuer (proxy hostnames are rejected by RFC 8414 issuer match).
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

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
