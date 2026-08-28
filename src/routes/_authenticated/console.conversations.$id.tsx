import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { feedbackService } from "@/lib/api/feedback.service";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { AgentToolPanel } from "@/components/console/AgentToolPanel";
import { CRMPanel, RIGHT_COPY, buildBoundedContext, computeContextRevisionKey } from "@/components/console/CRMPanel";
import { MessageAttachment, isAttachmentMessage, type AttachmentMeta } from "@/components/console/MessageAttachment";
import { AttachmentButtons, EmojiPickerButton, insertAtCaret } from "@/components/console/ComposerTools";


export const Route = createFileRoute("/_authenticated/console/conversations/$id")({
  component: ConversationDetailGuard,
});

function ConversationDetailGuard() {
  const { role, loading } = useCurrentRole();
  if (loading) return <LoadingState />;
  if (role !== "admin" && role !== "supervisor" && role !== "agent") {
    return (
      <PermissionDenied message="您沒有權限查看此對話詳情。 / You do not have permission to access this conversation." />
    );
  }
  return <ConversationDetailContent />;
}

type Msg = {
  id: string;
  role: string;
  content: string;
  content_type: string | null;
  status: string | null;
  is_recalled: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};


type Conversation = {
  id: string;
  status: string;
  assigned_agent_id: string | null;
  channel_config: { name: string } | null;
  visitor_session: { id: string } | null;
};

type AgentLite = { id: string; display_name: string; role: string; status: string };

const ELEVATED = new Set(["manager", "admin", "super_admin"]);
const ADMIN_ONLY = new Set(["admin", "super_admin"]);

function ConversationDetailContent() {
  const { id } = Route.useParams();
  const { user } = useAuth();
  const { role: currentRole } = useCurrentRole();
  const lang = useConsoleLang();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [myAgent, setMyAgent] = useState<AgentLite | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sendGuardOpen, setSendGuardOpen] = useState(false);
  const [resolvedWarningOpen, setResolvedWarningOpen] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<{ id: string; role: string; content: string } | null>(null);
  const [useConfirmOpen, setUseConfirmOpen] = useState(false);
  const [pendingUseText, setPendingUseText] = useState("");

  // ── RIGHT-CRM-KB-CONTEXT-1: bounded context scoped to this conversation ──
  const boundedContext = useMemo(() => buildBoundedContext(messages), [messages]);
  const contextRevisionKey = useMemo(() => computeContextRevisionKey(id, messages), [id, messages]);

  // ── J1: Realtime infrastructure ──
  const realtimeConnectedRef = useRef(true);
  const fallbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function startDetailFallback() {
    if (fallbackTimerRef.current) return;
    fallbackTimerRef.current = setInterval(() => {
      loadConv();
      loadMessages();
    }, 20000);
  }
  function stopDetailFallback() {
    if (!fallbackTimerRef.current) return;
    clearInterval(fallbackTimerRef.current);
    fallbackTimerRef.current = null;
    loadConv();
    loadMessages();
  }
  function handleDetailSubscribeStatus(status: string) {
    if (status === "SUBSCRIBED") {
      realtimeConnectedRef.current = true;
      stopDetailFallback();
    }
    if (status === "TIMED_OUT" || status === "CLOSED" || status === "CHANNEL_ERROR") {
      realtimeConnectedRef.current = false;
      startDetailFallback();
    }
  }

  const loadConv = useCallback(async () => {
    const { data } = await supabase
      .from("conversations")
      .select(
        `
        id, status, assigned_agent_id,
        channel_config:channel_config_id(name),
        visitor_session:visitor_session_id(id)
      `,
      )
      .eq("id", id)
      .single();
    setConv(data as Conversation | null);
  }, [id]);

  const loadMessages = useCallback(async () => {
    const { data } = await supabase
      .from("messages")
      .select("id, role, content, content_type, status, is_recalled, metadata, created_at")
      .eq("conversation_id", id)
      .neq("content", "__THINKING__")
      .order("created_at", { ascending: true });
    setMessages((data as Msg[]) ?? []);
  }, [id]);

  const loadAgents = useCallback(async () => {
    const { data } = await supabase
      .from("agent_profile")
      .select("id, display_name, role, status")
      .eq("status", "active");
    setAgents((data as AgentLite[]) ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      await Promise.all([loadConv(), loadMessages(), loadAgents()]);
      setLoading(false);
    })();

    const convChannel = supabase
      .channel(`detail-conv-${id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "conversations",
          filter: `id=eq.${id}`,
        },
        () => {
          loadConv();
        },
      )
      .subscribe(handleDetailSubscribeStatus);

    const msgChannel = supabase
      .channel(`detail-msgs-${id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${id}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT" && (payload.new as { content?: string })?.content === "__THINKING__")
            return;
          loadMessages();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(convChannel);
      supabase.removeChannel(msgChannel);
      if (fallbackTimerRef.current) clearInterval(fallbackTimerRef.current);
    };
  }, [id, loadConv, loadMessages, loadAgents]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("agent_profile")
        .select("id, display_name, role, status")
        .eq("user_id", user.id)
        .maybeSingle();
      setMyAgent((data as AgentLite | null) ?? null);
    })();
  }, [user]);

  // ── J1: Visibility catch-up ──
  useEffect(() => {
    function handleVisibility() {
      if (!document.hidden) {
        loadConv();
        loadMessages();
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [loadConv, loadMessages]);

  async function callEF(name: string, body: Record<string, unknown>) {
    const { data, error } = await supabase.functions.invoke(name, { body });
    if (error) {
      toast.error(error.message);
      return false;
    }
    if (data && (data as { error?: string }).error) {
      toast.error((data as { error: string }).error);
      return false;
    }
    return true;
  }

  async function sendReply() {
    const content = reply.trim();
    if (!content) return;
    setSending(true);
    const ok = await callEF("agent-send-reply", { conversation_id: id, content });
    setSending(false);
    if (ok) {
      setReply("");
      toast.success("Reply sent");
      loadMessages();
    }
  }

  // ── Dev22-F2: Send Guard — aligned with index route ───────────────
  function handleSendClick() {
    if (!reply.trim()) return;
    if (!conv) return;
    if (!myAgent) {
      toast.error("Agent profile is not available. Please refresh and try again.");
      return;
    }
    if (conv.status === "resolved") {
      setResolvedWarningOpen(true);
      return;
    }
    if (conv.status === "pending" && conv.assigned_agent_id === myAgent?.id) {
      sendReply();
      return;
    }
    setSendGuardOpen(true);
  }

  async function handleTakeOverAndSend() {
    const content = reply.trim();
    if (!content) {
      setSendGuardOpen(false);
      return;
    }
    setSending(true);
    const takeOverOk = await callEF("take-over-conversation", { conversation_id: id });
    if (!takeOverOk) {
      setSending(false);
      setSendGuardOpen(false);
      toast.error("Take over failed. Message not sent.");
      return;
    }
    const sendOk = await callEF("agent-send-reply", { conversation_id: id, content });
    setSending(false);
    setSendGuardOpen(false);
    if (sendOk) {
      setReply("");
      toast.success("Took over and sent reply");
      loadConv();
      loadMessages();
    } else {
      toast.info("Conversation taken over, but message was not sent. Please re-send.");
      loadConv();
    }
  }
  // ── End Dev22-F2 ──────────────────────────────────────────────────

  async function handleResolve() {
    if (await callEF("resolve-conversation", { conversation_id: id })) {
      toast.success("Marked resolved");
      // P3-FB: Schedule feedback request BEFORE reload (non-blocking)
      try {
        const schedResult = await feedbackService.scheduleFeedbackRequest(id);
        if (schedResult && !schedResult.ok) {
          toast.warning("Conversation resolved, but feedback scheduling failed.");
        }
      } catch {
        toast.warning("Conversation resolved, but feedback scheduling failed.");
      }
      loadConv();
    }
  }
  async function handleUnresolve() {
    if (await callEF("mark-unresolved", { conversation_id: id })) {
      toast.success("Marked unresolved");
      loadConv();
    }
  }
  async function handleAssign(targetId: string) {
    if (await callEF("assign-conversation", { conversation_id: id, target_agent_id: targetId })) {
      toast.success("Assigned");
      loadConv();
    }
  }
  async function handleTransfer(targetId: string) {
    if (await callEF("transfer-conversation", { conversation_id: id, to_agent_id: targetId })) {
      toast.success("Transferred");
      loadConv();
      loadMessages();
    }
  }
  async function handleRecall(messageId: string, role: string) {
    if (!myAgent) return;
    if (role === "visitor" && !ADMIN_ONLY.has(myAgent.role)) {
      toast.error("Only admins can recall visitor messages");
      return;
    }
    if (await callEF("recall-message", { message_id: messageId })) {
      toast.success("Message recalled");
      loadMessages();
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!conv) {
    return <div className="text-sm text-muted-foreground">Conversation not found.</div>;
  }

  const assignedName = agents.find((a) => a.id === conv.assigned_agent_id)?.display_name || "Unassigned";
  const isElevated = myAgent ? ELEVATED.has(myAgent.role) : false;
  const transferableAgents = agents.filter((a) => a.id !== myAgent?.id);
  const visitorShortId = `Visitor #${(conv.visitor_session?.id || id).slice(0, 8)}`;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden", background: "#f5f4f0" }}>
      {/* LEFT: Static context panel — no new queries, uses existing conv state */}
      <div
        style={{
          width: 260,
          flexShrink: 0,
          background: "#fff",
          borderRight: "0.5px solid #e8e6e0",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "10px 12px", borderBottom: "0.5px solid #e8e6e0", flexShrink: 0 }}>
          <Link
            to="/console/conversations"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              fontWeight: 600,
              color: "#555",
              textDecoration: "none",
            }}
          >
            <ArrowLeft style={{ width: 12, height: 12 }} />
            Back to Inbox
          </Link>
        </div>
        <div style={{ padding: "12px", overflowY: "auto", flex: 1 }}>
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase" as const,
                color: "#aaa",
                letterSpacing: "0.08em",
                marginBottom: 8,
              }}
            >
              Current Conversation
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(
                [
                  ["Visitor", visitorShortId],
                  ["Status", conv.status],
                  ["Channel", conv.channel_config?.name || "—"],
                  ["Assigned", assignedName],
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                  <span style={{ color: "#888" }}>{label}</span>
                  <span
                    style={{
                      color: "#1a1a1a",
                      fontWeight: 500,
                      textAlign: "right",
                      maxWidth: "60%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap" as const,
                    }}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div
            style={{
              background: "#f5f4f0",
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 10,
              color: "#888",
              lineHeight: 1.5,
            }}
          >
            📋 Full conversation list coming in Phase-2B
          </div>
        </div>
      </div>

      {/* MIDDLE: Original detail content — zero changes to logic */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "#fff",
          borderLeft: "0.5px solid #e8e6e0",
        }}
      >
        <div
          className="space-y-4"
          style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: "16px" }}
        >
          <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
            <h1 className="text-xl font-semibold">Conversation #{conv.id.slice(0, 8)}</h1>
            <Badge variant="secondary" className="capitalize">
              {conv.status}
            </Badge>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[65%_35%]" style={{ flex: 1, overflow: "hidden" }}>
            <div
              className="space-y-2 rounded-md border p-4"
              style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
            >
              <div className="max-h-[60vh] space-y-2 overflow-y-auto" style={{ flex: 1 }}>
                {messages.length === 0 && <div className="text-sm text-muted-foreground">No messages.</div>}
                {messages.map((m) => {
                  const isVisitor = m.role === "visitor";
                  const isAgent = m.role === "agent";
                  const isAssistant = m.role === "assistant";
                  const bubbleClass = isVisitor
                    ? "ml-auto bg-muted text-foreground"
                    : isAgent
                      ? "bg-blue-500/15 text-blue-900 dark:text-blue-100"
                      : isAssistant
                        ? "bg-purple-500/15 text-purple-900 dark:text-purple-100"
                        : "bg-muted";
                  const agentName = (m.metadata as { agent_name?: string } | null)?.agent_name;
                  return (
                    <div
                      key={m.id}
                      className={`group max-w-[80%] rounded-lg px-3 py-2 text-sm ${bubbleClass}`}
                      onClick={() =>
                        !m.is_recalled && setSelectedMessage({ id: m.id, role: m.role, content: m.content })
                      }
                      style={{
                        cursor: m.is_recalled ? "default" : "pointer",
                        outline: selectedMessage?.id === m.id ? "2px solid #8b5cf6" : "none",
                        outlineOffset: 2,
                      }}
                    >
                      {isAgent && agentName && <div className="text-[10px] font-medium opacity-70">{agentName}</div>}
                      {isAssistant && <div className="text-[10px] font-medium opacity-70">AI</div>}
                      {m.is_recalled ? (
                        <div className="italic text-muted-foreground">[訊息已撤回]</div>
                      ) : (
                        isAttachmentMessage(m.content_type) ? (
                          <MessageAttachment
                            messageId={m.id}
                            contentType={m.content_type}
                            metadata={(m.metadata as AttachmentMeta | null) ?? null}
                          />
                        ) : (
                          <div className="whitespace-pre-wrap">{m.content}</div>
                        )

                      )}
                      {!m.is_recalled &&
                        (isAgent || isAssistant || (isVisitor && myAgent && ADMIN_ONLY.has(myAgent.role))) && (
                          <button
                            onClick={() => handleRecall(m.id, m.role)}
                            className="mt-1 hidden text-[10px] text-destructive underline group-hover:inline"
                          >
                            Recall
                          </button>
                        )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3 rounded-md border p-4">
              <div className="space-y-1 text-sm">
                <div>
                  <span className="text-muted-foreground">Status:</span> {conv.status}
                </div>
                <div>
                  <span className="text-muted-foreground">Channel:</span> {conv.channel_config?.name || "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">Visitor:</span> {conv.visitor_session?.id?.slice(0, 8) || "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">Assigned:</span> {assignedName}
                </div>
              </div>

              <div className="space-y-2">
                <Textarea
                  ref={replyRef}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Type your reply…"
                  rows={4}
                  maxLength={4000}
                />
                <div className="flex items-center gap-2">
                  <EmojiPickerButton
                    onInsert={(emoji) => {
                      const node = replyRef.current;
                      const { value, caret } = insertAtCaret(node, reply, emoji);
                      setReply(value);
                      requestAnimationFrame(() => {
                        node?.focus();
                        node?.setSelectionRange(caret, caret);
                      });
                    }}
                  />
                  <AttachmentButtons conversationId={id} onSent={() => loadMessages()} />
                </div>
                <Button onClick={handleSendClick} disabled={sending || !reply.trim()} className="w-full">
                  {sending ? "Sending…" : "Send reply"}
                </Button>
              </div>


              <div className="flex flex-col gap-2">
                {conv.status !== "resolved" && (
                  <Button variant="outline" onClick={handleResolve}>
                    Resolve
                  </Button>
                )}
                {conv.status !== "unresolved" && (
                  <Button variant="outline" onClick={handleUnresolve}>
                    Mark Unresolved
                  </Button>
                )}
              </div>

              {/* Contextual Assign OR Transfer - never both */}
              {conv.status !== "resolved" && (
                <>
                  {!conv.assigned_agent_id && isElevated && (
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">Assign to</div>
                      <Select onValueChange={handleAssign}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select agent" />
                        </SelectTrigger>
                        <SelectContent>
                          {agents.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.display_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {conv.assigned_agent_id && (
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">Transfer to</div>
                      <Select onValueChange={handleTransfer}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select agent" />
                        </SelectTrigger>
                        <SelectContent>
                          {transferableAgents.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.display_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT: CRMPanel + AgentToolPanel */}
      <div style={{ width: 360, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ flex: 1, overflow: "hidden", borderBottom: "0.5px solid #e8e6e0" }}>
          <CRMPanel
            conv={{
              id: conv.id,
              status: conv.status,
              channel_config: conv.channel_config,
              visitor_session_id: conv.visitor_session?.id ?? null,
            }}
            visitorLabel={visitorShortId}
            onResolve={handleResolve}
            boundedContext={boundedContext}
            contextRevisionKey={contextRevisionKey}
            draftText={reply}
            currentRole={currentRole}
            onInsertDraft={(text) => {
              if (reply.trim() && reply.trim() !== text.trim()) {
                setPendingUseText(text);
                setUseConfirmOpen(true);
              } else {
                setReply(text);
                toast.success(RIGHT_COPY.inserted[lang] ?? "Inserted");
              }
            }}
          />
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          <AgentToolPanel
            conversationId={id}
            convStatus={conv.status}
            draftText={reply}
            selectedMessage={selectedMessage}
            onClearSelection={() => setSelectedMessage(null)}
            onUseDraft={(text) => {
              if (reply.trim() && reply.trim() !== text.trim()) {
                setPendingUseText(text);
                setUseConfirmOpen(true);
              } else {
                setReply(text);
              }
            }}
          />
        </div>
      </div>

      {/* Dev22-F2: Resolved Warning */}
      <Dialog open={resolvedWarningOpen} onOpenChange={setResolvedWarningOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Conversation Resolved</DialogTitle>
            <DialogDescription>
              This conversation is resolved. Please mark it as unresolved before replying.
            </DialogDescription>
          </DialogHeader>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <Button size="sm" onClick={() => setResolvedWarningOpen(false)}>
              OK
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dev22-F2: Send Guard — Take Over Confirmation */}
      <Dialog open={sendGuardOpen} onOpenChange={setSendGuardOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Take Over Conversation?</DialogTitle>
            <DialogDescription>
              This conversation is not currently under your control. Take over before sending this message?
            </DialogDescription>
          </DialogHeader>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Button variant="outline" size="sm" onClick={() => setSendGuardOpen(false)} disabled={sending}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleTakeOverAndSend} disabled={sending}>
              {sending ? "Processing…" : "Take Over & Send"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={useConfirmOpen} onOpenChange={setUseConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{lang === "zh" ? "取代草稿？" : "Replace Draft?"}</DialogTitle>
            <DialogDescription>
              {lang === "zh"
                ? "目前的草稿將被工具結果取代，此操作無法復原。"
                : "Your current draft will be replaced with the tool result."}
            </DialogDescription>
          </DialogHeader>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setUseConfirmOpen(false);
                setPendingUseText("");
              }}
            >
              {lang === "zh" ? "取消" : "Cancel"}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setReply(pendingUseText);
                setUseConfirmOpen(false);
                setPendingUseText("");
              }}
            >
              {lang === "zh" ? "取代" : "Replace"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
