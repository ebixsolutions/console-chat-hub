import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";
import { validateWidgetOrigin } from "../_shared/widget-origin.ts";
import {
  classifyConversationalRoute,
  NOISE_CLARIFICATION,
  UNDERSPECIFIED_CLARIFICATION,
} from "../_shared/conversational-routing.ts";
import { workflow5ShortTopicHint } from "../_shared/conversation-runtime-state.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/webm", "video/quicktime",
  "application/pdf", "text/plain", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string { return typeof value === "string" && UUID_RE.test(value); }
function attachmentType(mime: string): "image" | "video" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const requestContentType = req.headers.get("content-type") ?? "";
    const isMultipart = requestContentType.toLowerCase().startsWith("multipart/form-data");
    let conversation_id: unknown;
    let session_token: unknown;
    let content: unknown = null;
    let client_message_id: unknown = req.headers.get("idempotency-key");
    let attachment: File | null = null;

    if (isMultipart) {
      const form = await req.formData();
      conversation_id = form.get("conversation_id");
      session_token = form.get("session_token");
      client_message_id = form.get("client_message_id") ?? client_message_id;
      const candidate = form.get("file");
      if (candidate instanceof File) attachment = candidate;
    } else {
      const body = await req.json().catch(() => ({}));
      conversation_id = body.conversation_id;
      session_token = body.session_token;
      content = body.content;
      client_message_id = body.client_message_id ?? client_message_id;
    }

    if (!isUuid(conversation_id) || typeof session_token !== "string" || session_token.length < 32 || session_token.length > 256) {
      return json({ success: false, error: "invalid_request" }, 400);
    }
    if (client_message_id != null && !isUuid(client_message_id)) {
      return json({ success: false, error: "invalid_client_message_id" }, 400);
    }
    if (!isMultipart && typeof content !== "string") return json({ success: false, error: "invalid_request" }, 400);
    if (isMultipart && !attachment) return json({ success: false, error: "invalid_attachment" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, getSupabaseAdminKey());
    const { data: sessionScope, error: sessionScopeError } = await supabase.from("visitor_session")
      .select("id, channel_config:channel_config_id(id, is_active, channel_type, allowed_origins)")
      .eq("session_token", session_token).maybeSingle();
    if (sessionScopeError) return json({ success: false, error: "session_scope_lookup_failed" }, 500);
    if (!sessionScope) return json({ success: false, error: "Invalid session" }, 401);

    const channel = sessionScope.channel_config as { id?: string; is_active?: boolean; channel_type?: string; allowed_origins?: string[] | null } | null;
    if (!channel || channel.is_active !== true || channel.channel_type !== "web_widget") return json({ success: false, error: "widget_channel_unavailable" }, 403);
    const originCheck = validateWidgetOrigin(req, channel.allowed_origins);
    if (!originCheck.ok) return json({ success: false, error: originCheck.error }, 403);

    if (isMultipart && attachment) {
      if (attachment.size <= 0 || attachment.size > MAX_ATTACHMENT_BYTES) return json({ success: false, error: "file_too_large" }, 400);
      if (!ALLOWED_ATTACHMENT_MIME.has(attachment.type)) return json({ success: false, error: "unsupported_file_type" }, 400);
      const { data: conversationScope, error: conversationScopeError } = await supabase.from("conversations")
        .select("id,status,visitor_session_id").eq("id", conversation_id).eq("visitor_session_id", sessionScope.id).maybeSingle();
      if (conversationScopeError) return json({ success: false, error: "conversation_scope_lookup_failed" }, 500);
      if (!conversationScope) return json({ success: false, error: "Conversation not found" }, 404);
      if (["resolved", "closed"].includes(conversationScope.status)) return json({ success: false, error: "Conversation is resolved" }, 403);

      const ext = (attachment.name.split(".").pop() || "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "bin";
      const storagePath = `${conversation_id}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from("widget-attachments")
        .upload(storagePath, attachment, { contentType: attachment.type, upsert: false, cacheControl: "3600" });
      if (uploadError) return json({ success: false, error: "attachment_upload_failed" }, 500);
      const attachmentClientId = typeof client_message_id === "string" ? client_message_id : crypto.randomUUID();
      const { data: txData, error: txError } = await supabase.rpc("receive_widget_attachment_tx", {
        p_conversation_id: conversation_id,
        p_session_token: session_token,
        p_content_type: attachmentType(attachment.type),
        p_storage_path: storagePath,
        p_original_name: attachment.name.slice(0, 255),
        p_mime_type: attachment.type,
        p_size_bytes: attachment.size,
        p_client_message_id: attachmentClientId,
      });
      const attachmentResult = String(txData?.result ?? "");
      if (attachmentResult === "idempotent") {
        await supabase.storage.from("widget-attachments").remove([storagePath]);
        return json({ success: true, data: { message_id: String(txData.message_id), content_type: attachmentType(attachment.type), ai_reply_pending: false, idempotent: true } });
      }
      if (txError || attachmentResult !== "success") {
        await supabase.storage.from("widget-attachments").remove([storagePath]);
        return json({ success: false, error: "attachment_transaction_failed" }, 500);
      }
      return json({ success: true, data: { message_id: String(txData.message_id), content_type: attachmentType(attachment.type), ai_reply_pending: false, idempotent: false } });
    }

    const normalizedContent = String(content).trim();
    if (!normalizedContent) return json({ success: false, error: "invalid_content" }, 400);
    if (normalizedContent.length > 2000) return json({ success: false, error: "message_too_long" }, 400);
    const { data: txData, error: txError } = await supabase.rpc("receive_widget_message_tx", {
      p_conversation_id: conversation_id,
      p_session_token: session_token,
      p_content: normalizedContent,
      p_client_message_id: typeof client_message_id === "string" ? client_message_id : null,
    });
    if (txError) return json({ success: false, error: "widget_message_transaction_failed" }, 500);

    const result = String(txData?.result ?? "unknown");
    if (result === "invalid_session") return json({ success: false, error: "Invalid session" }, 401);
    if (result === "not_found") return json({ success: false, error: "Conversation not found" }, 404);
    if (result === "resolved") return json({ success: false, error: "Conversation is resolved" }, 403);
    if (!["success", "human_control", "idempotent"].includes(result)) return json({ success: false, error: "widget_message_rejected" }, 409);

    const messageId = String(txData?.message_id ?? "");
    if (!messageId) return json({ success: false, error: "widget_message_missing_id" }, 500);
    if (result === "human_control") return json({ success: true, data: { message_id: messageId, ai_reply_pending: false, control_state: "human_control" } });
    if (result === "idempotent") return json({ success: true, data: { message_id: messageId, ai_reply_pending: Boolean(txData?.ai_reply_pending), control_state: "ai", idempotent: true } });

    const route = classifyConversationalRoute(normalizedContent);
    const knownShortTopic = workflow5ShortTopicHint(normalizedContent);
    // Noise-only input can be clarified locally. Meaningful underspecified input must
    // reach generate-reply so A3.1 multilingual semantic interpretation can resolve
    // ellipsis/referents from conversation context instead of keyword heuristics.
    if (!knownShortTopic && route.kind === "clarify") {
      const isUnderspecified = route.kind === "underspecified";
      const clarificationRoute = isUnderspecified ? "conversational_underspecified_clarification" : "conversational_clarification";
      const clarificationText = isUnderspecified ? UNDERSPECIFIED_CLARIFICATION[route.language] : NOISE_CLARIFICATION[route.language];
      const { data: commitData, error: commitError } = await supabase.rpc("commit_ai_reply_tx", {
        p_conversation_id: conversation_id,
        p_source_message_id: messageId,
        p_content: clarificationText,
        p_metadata: { response_route: clarificationRoute, kb_lookup: false, handoff_required: false, classifier_reason: route.reason },
      });
      if (commitError) return json({ success: false, error: "conversational_clarification_commit_failed" }, 500);
      const commitResult = String(commitData?.result ?? "unexpected_result");
      if (["success", "idempotent"].includes(commitResult)) return json({ success: true, data: { message_id: messageId, ai_reply_pending: false, control_state: "ai", response_route: clarificationRoute } });
      if (commitResult === "human_control") return json({ success: true, data: { message_id: messageId, ai_reply_pending: false, control_state: "human_control" } });
      if (["resolved", "superseded_source"].includes(commitResult)) return json({ success: true, data: { message_id: messageId, ai_reply_pending: false, control_state: commitResult } });
      return json({ success: false, error: `conversational_clarification_${commitResult}` }, 409);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceJwt = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
    if (!serviceJwt) return json({ success: false, error: "internal_service_auth_unavailable" }, 500);
    const generateReplyTask = fetch(`${supabaseUrl}/functions/v1/generate-reply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id, source_message_id: messageId, ...(route.kind === "conversational" ? { conversational_route: route.subtype } : {}) }),
    }).then((response) => {
      if (!response.ok) console.error("[receive-widget-message] generate-reply returned non-success", response.status);
    }).catch((err) => console.error("[receive-widget-message] generate-reply invoke error", err instanceof Error ? err.name : "unknown_error"));
    EdgeRuntime.waitUntil(generateReplyTask);
    return json({ success: true, data: { message_id: messageId, ai_reply_pending: true, control_state: "ai", response_route: route.kind === "conversational" ? route.subtype : "normal" } });
  } catch (e) {
    console.error("[receive-widget-message] unexpected", (e as Error).name);
    return json({ success: false, error: "internal_error" }, 500);
  }
});
