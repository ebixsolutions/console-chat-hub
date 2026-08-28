/**
 * Task 3.3 (E/F) — authenticated console attachment send + retrieval.
 *
 * Safety contract:
 *   * private "widget-attachments" bucket only, never public access
 *   * 10 MB size limit + MIME allowlist enforced server-side
 *   * tenant + current human-control preflight happens before storage upload
 *   * authoritative row-lock ownership/control checks remain inside
 *     public.agent_send_attachment_tx
 *   * failed DB/RPC commits trigger compensating storage cleanup
 *   * raw storage bucket/path live only in message_attachment_private and are
 *     never returned in messages.metadata or browser payloads
 *   * reads use short-lived authenticated signed URLs only
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_MIME = [
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/webm", "video/quicktime",
  "application/pdf", "text/plain", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

const ATTACHMENT_BUCKET = "widget-attachments";
const SIGNED_URL_TTL_SECONDS = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AttachmentContentType = "image" | "video" | "file";

export function attachmentTypeForMime(mime: string): AttachmentContentType {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export type AgentAttachmentSendResult =
  | { ok: true; message_id: string | null; content_type: AttachmentContentType }
  | { ok: false; error_type: string; error: string };

export type AgentAttachmentUrlResult =
  | {
      ok: true;
      url: string;
      expires_in: number;
      content_type: AttachmentContentType;
      original_name: string;
      mime_type: string;
      size_bytes: number | null;
    }
  | { ok: false; error_type: string; error: string };

function fail(error_type: string, error: string): { ok: false; error_type: string; error: string } {
  return { ok: false, error_type, error };
}

/** Resolve the caller's active agent profile and single active company boundary. */
async function resolveAgentScope(
  admin: { from: (relation: string) => any },
  userId: string,
): Promise<
  | { ok: true; agentId: string; agentName: string | null; companyId: string }
  | { ok: false; error_type: string; error: string }
> {
  const { data: agent, error: agentError } = await admin
    .from("agent_profile")
    .select("id, user_id, status, display_name")
    .eq("user_id", userId)
    .maybeSingle();

  if (agentError) return fail("agent_lookup_failed", "Agent lookup failed");
  if (!agent) return fail("agent_not_found", "Agent profile not found");
  if (agent.status !== "active") return fail("agent_inactive", "Agent account is inactive");

  const { data: memberships, error: membershipError } = await admin
    .from("company_membership")
    .select("company_id")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (membershipError) return fail("company_scope_lookup_failed", "Company scope lookup failed");

  const companyIds = [...new Set((memberships ?? []).map((row: { company_id: string }) => String(row.company_id)))];
  if (companyIds.length === 0) return fail("company_scope_unresolved", "Company scope is not configured");
  if (companyIds.length !== 1) return fail("company_scope_ambiguous", "Company scope is ambiguous");

  const { data: company, error: companyError } = await admin
    .from("company")
    .select("id, is_active")
    .eq("id", companyIds[0])
    .maybeSingle();

  if (companyError) return fail("company_scope_lookup_failed", "Company scope lookup failed");
  if (!company || company.is_active !== true) return fail("company_inactive", "Company is inactive");

  return {
    ok: true,
    agentId: String(agent.id),
    agentName: typeof agent.display_name === "string" ? agent.display_name : null,
    companyId: String(companyIds[0]),
  };
}

function rpcFailure(result: string): { ok: false; error_type: string; error: string } {
  switch (result) {
    case "resolved":
      return fail("conversation_resolved", "Conversation is resolved");
    case "takeover_required":
      return fail("takeover_required", "Take over this conversation before sending");
    case "owned_by_another_agent":
      return fail("conversation_owned_by_another_agent", "This conversation is assigned to another agent");
    case "human_control_required":
      return fail("human_control_required", "Conversation is not under human control");
    case "tenant_unresolved":
      return fail("company_scope_unresolved", "Conversation company scope is not configured");
    case "agent_not_found":
      return fail("agent_not_found", "Agent profile not found");
    case "agent_inactive":
      return fail("agent_inactive", "Agent is inactive");
    case "not_found":
      return fail("conversation_not_found", "Conversation not found");
    case "invalid_content_type":
    case "invalid_size":
    case "invalid_storage_path":
    case "invalid_mime_type":
      return fail(result, "Invalid attachment");
    default:
      return fail("attachment_transaction_failed", "Attachment could not be sent");
  }
}

export const sendAgentAttachment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: FormData) => {
    if (!(data instanceof FormData)) throw new Error("invalid_request");
    return data;
  })
  .handler(async ({ data, context }): Promise<AgentAttachmentSendResult> => {
    const conversationId = String(data.get("conversation_id") ?? "");
    const candidate = data.get("file");
    const file = candidate instanceof File ? candidate : null;

    if (!UUID_RE.test(conversationId)) return fail("invalid_request", "conversation_id required");
    if (!file) return fail("invalid_attachment", "file required");
    if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      return fail("file_too_large", "File too large (max 10 MB)");
    }
    if (!(ALLOWED_ATTACHMENT_MIME as readonly string[]).includes(file.type)) {
      return fail("unsupported_file_type", "Unsupported file type");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const scope = await resolveAgentScope(supabaseAdmin as never, context.userId);
    if (!scope.ok) return scope;

    // Fail before any storage write when control state is not currently sendable.
    // The transactional RPC repeats these checks under FOR UPDATE after upload.
    const { data: conversation, error: conversationError } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversationId)
      .eq("company_id", scope.companyId)
      .maybeSingle();

    if (conversationError) return fail("conversation_lookup_failed", "Conversation lookup failed");
    if (!conversation) return fail("conversation_not_found", "Conversation not found");
    if (conversation.status === "resolved" || conversation.status === "closed") {
      return fail("conversation_resolved", "Conversation is resolved");
    }
    if (!conversation.assigned_agent_id) {
      return fail("takeover_required", "Take over this conversation before sending");
    }
    if (String(conversation.assigned_agent_id) !== scope.agentId) {
      return fail("conversation_owned_by_another_agent", "This conversation is assigned to another agent");
    }
    if (conversation.status !== "pending") {
      return fail("human_control_required", "Conversation is not under human control");
    }

    const ext = (file.name.split(".").pop() || "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "bin";
    const storagePath = `agent/${conversationId}/${crypto.randomUUID()}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(ATTACHMENT_BUCKET)
      .upload(storagePath, file, { contentType: file.type, upsert: false, cacheControl: "3600" });

    if (uploadError) return fail("attachment_upload_failed", "Attachment upload failed");

    const contentType = attachmentTypeForMime(file.type);
    const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc("agent_send_attachment_tx" as never, {
      p_conversation_id: conversationId,
      p_agent_id: scope.agentId,
      p_content_type: contentType,
      p_storage_path: storagePath,
      p_original_name: file.name.slice(0, 255),
      p_mime_type: file.type,
      p_size_bytes: file.size,
      p_agent_name: scope.agentName,
    } as never);

    const payload = (rpcData ?? {}) as { result?: string; message_id?: string };
    const result = String(payload.result ?? (rpcError ? "rpc_error" : "unknown"));

    if (rpcError || result !== "success") {
      // Compensating cleanup: a failed commit must never leave an orphan object.
      await supabaseAdmin.storage.from(ATTACHMENT_BUCKET).remove([storagePath]);
      return rpcFailure(result);
    }

    return {
      ok: true,
      message_id: typeof payload.message_id === "string" ? payload.message_id : null,
      content_type: contentType,
    };
  });

export const getAgentAttachmentUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { message_id: string }) => {
    if (!data || !UUID_RE.test(String(data.message_id))) throw new Error("invalid_request");
    return { message_id: String(data.message_id) };
  })
  .handler(async ({ data, context }): Promise<AgentAttachmentUrlResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const scope = await resolveAgentScope(supabaseAdmin as never, context.userId);
    if (!scope.ok) return scope;

    // Browser-safe message metadata is used for display only. Private storage
    // location is resolved independently from the service-role-only table.
    const { data: message, error: messageError } = await supabaseAdmin
      .from("messages")
      .select("id, content_type, metadata, conversation_id, conversations!inner(id, company_id)")
      .eq("id", data.message_id)
      .eq("conversations.company_id", scope.companyId)
      .maybeSingle();

    if (messageError) return fail("attachment_lookup_failed", "Attachment lookup failed");
    if (!message) return fail("attachment_not_found", "Attachment not found");

    const { data: locator, error: locatorError } = await supabaseAdmin
      .from("message_attachment_private")
      .select("storage_bucket, storage_path")
      .eq("message_id", data.message_id)
      .eq("conversation_id", message.conversation_id)
      .eq("company_id", scope.companyId)
      .maybeSingle();

    if (locatorError) return fail("attachment_lookup_failed", "Attachment lookup failed");
    if (!locator || locator.storage_bucket !== ATTACHMENT_BUCKET || typeof locator.storage_path !== "string") {
      return fail("attachment_not_found", "Attachment not found");
    }

    const { data: signed, error: signError } = await supabaseAdmin.storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUrl(locator.storage_path, SIGNED_URL_TTL_SECONDS);

    if (signError || !signed?.signedUrl) return fail("attachment_unavailable", "Attachment unavailable");

    const metadata = (message.metadata ?? {}) as Record<string, unknown>;
    const rawContentType = String(message.content_type ?? "file");
    return {
      ok: true,
      url: signed.signedUrl,
      expires_in: SIGNED_URL_TTL_SECONDS,
      content_type:
        rawContentType === "image" || rawContentType === "video" ? rawContentType : "file",
      original_name: typeof metadata["original_name"] === "string" ? metadata["original_name"] : "",
      mime_type: typeof metadata["mime_type"] === "string" ? metadata["mime_type"] : "",
      size_bytes: typeof metadata["size_bytes"] === "number" ? metadata["size_bytes"] : null,
    };
  });
