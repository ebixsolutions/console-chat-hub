import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
const AGENT_ASSIST_MAX_CONTENT = 2000;

const TOOL_COPY = {
  panelTitle: { en: "Agent Assist Tools", zh: "智能協助工具" },
  useDraft: { en: "Use draft", zh: "使用草稿" },
  useSelected: { en: "Selected msg", zh: "已選訊息" },
  customInput: { en: "Custom", zh: "自訂" },
  customPh: { en: "Paste or type...", zh: "貼上或輸入..." },
  translate: { en: "Translate", zh: "翻譯" },
  grammar: { en: "Grammar", zh: "文法" },
  policy: { en: "Policy", zh: "政策" },
  knowledge: { en: "Knowledge", zh: "知識" },
  suggest: { en: "Suggest", zh: "建議" },
  processing: { en: "Processing...", zh: "處理中..." },
  useInDraft: { en: "Use in Draft", zh: "套用至草稿" },
  use: { en: "Use", zh: "使用" },
  draftOnly: { en: "Draft only — review before sending", zh: "僅為草稿 — 發送前請確認" },
  noContent: { en: "Select a message or enter text", zh: "請選取訊息或輸入文字" },
  draftEmpty: { en: "Draft empty", zh: "草稿為空" },
  noSel: { en: "No selection", zh: "未選取" },
  clear: { en: "Clear", zh: "清除" },
  selPrev: { en: "Selected:", zh: "已選：" },
  kbUnavail: { en: "KB unavailable", zh: "知識庫無法存取" },
  kbNoResults: { en: "No relevant sources", zh: "無相關來源" },
  kbDenied: { en: "Access denied", zh: "存取被拒" },
  polSrcUnavail: { en: "Policy source unavailable", zh: "政策來源無法取得" },
  toolHint: { en: "Enter text, then select a tool.", zh: "輸入文字後選取工具。" },
  basedOn: { en: "Based on provided policy sources only", zh: "僅基於所提供的政策來源" },
  resolved: { en: "Conversation resolved — tools disabled", zh: "對話已解決 — 工具已停用" },
  reqFailed: { en: "Request failed", zh: "請求失敗" },
  netError: { en: "Network error", zh: "網路錯誤" },
  polFailed: { en: "Policy check failed", zh: "政策檢查失敗" },
  transResult: { en: "Translation", zh: "翻譯結果" },
  gramResult: { en: "Grammar Check", zh: "文法檢查" },
  polResult: { en: "Policy Check", zh: "政策檢查" },
  kbResult: { en: "Knowledge", zh: "知識" },
  sugResult: { en: "Suggested Replies", zh: "建議回覆" },
  tooLong: { en: "Content exceeds 2,000 characters", zh: "內容超過 2,000 字元" },
} as const;
type TCK = keyof typeof TOOL_COPY;

function validateKbResults(
  data: unknown,
): Array<{ display_label: string; content: string; source_type: string }> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.success !== true || !Array.isArray(d.results)) return null;
  const out: Array<{ display_label: string; content: string; source_type: string }> = [];
  for (const r of d.results) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    if (typeof o.display_label !== "string" || typeof o.content !== "string" || typeof o.source_type !== "string")
      return null;
    out.push({ display_label: o.display_label, content: o.content, source_type: o.source_type });
  }
  return out;
}

function AgentToolPanel({
  conversationId,
  convStatus,
  draftText,
  selectedMessage,
  onClearSelection,
  onUseDraft,
}: {
  conversationId: string;
  convStatus: string;
  draftText: string;
  selectedMessage: { id: string; role: string; content: string } | null;
  onClearSelection: () => void;
  onUseDraft: (t: string) => void;
}) {
  const lang = useConsoleLang();
  const tc = (k: TCK) => TOOL_COPY[k]?.[lang] ?? TOOL_COPY[k]?.en ?? k;
  const [cs, setCs] = useState<"draft" | "selected" | "custom">("custom");
  const [ci, setCi] = useState("");
  const [tr, setTr] = useState<{ type: string; data: Record<string, unknown> } | null>(null);
  const [tl, setTl] = useState(false);
  const [te, setTe] = useState("");
  const [kr, setKr] = useState<Array<{ display_label: string; content: string; source_type: string }>>([]);
  const [kl, setKl] = useState(false);
  const [ke, setKe] = useState("");

  const gc = (): string => {
    if (cs === "draft") return draftText.trim();
    if (cs === "selected") return selectedMessage?.content?.trim() ?? "";
    return ci.trim();
  };
  const ac = gc();
  const hc = ac.length > 0 && ac.length <= AGENT_ASSIST_MAX_CONTENT;
  const tooLong = ac.length > AGENT_ASSIST_MAX_CONTENT;
  const isResolved = convStatus === "resolved";

  async function runTool(tt: string, extra?: Record<string, unknown>) {
    if (!hc || isResolved) return;
    setTl(true);
    setTe("");
    setTr(null);
    try {
      const { data, error } = await supabase.functions.invoke("agent-assist", {
        body: { tool_type: tt, conversation_id: conversationId, content: ac, ...extra },
      });
      if (error || !data?.success) {
        if (data?.result?.status === "insufficient_evidence") setTr({ type: tt, data: data.result });
        else setTe(tc("reqFailed"));
      } else setTr({ type: tt, data: data.result });
    } catch {
      setTe(tc("netError"));
    }
    setTl(false);
  }

  async function runKb() {
    if (!hc || isResolved) return;
    setKl(true);
    setKr([]);
    setKe("");
    try {
      const { data, error } = await supabase.functions.invoke("kb-search-proxy", { body: { query: ac, top_k: 3 } });
      if (error) {
        setKe(tc("kbUnavail"));
        setKl(false);
        return;
      }
      const valid = validateKbResults(data);
      if (!valid) {
        setKe(
          data?.error === "forbidden"
            ? tc("kbDenied")
            : data?.results?.length === 0
              ? tc("kbNoResults")
              : tc("kbUnavail"),
        );
        setKl(false);
        return;
      }
      if (valid.length === 0) {
        setKe(tc("kbNoResults"));
        setKl(false);
        return;
      }
      setKr(valid);
    } catch {
      setKe(tc("kbUnavail"));
    }
    setKl(false);
  }

  async function runPol() {
    if (!hc || isResolved) return;
    setTl(true);
    setTe("");
    setTr(null);
    let pctx: Array<{ label: string; content: string; source_type: string }> = [];
    let kbFailed = false;
    try {
      const { data, error } = await supabase.functions.invoke("kb-search-proxy", { body: { query: ac, top_k: 3 } });
      if (error) {
        kbFailed = true;
      } else {
        const valid = validateKbResults(data);
        if (!valid) {
          kbFailed = true;
        } else
          pctx = valid
            .slice(0, 3)
            .map((r) => ({
              label: r.display_label.slice(0, 120),
              content: r.content.slice(0, 800),
              source_type: r.source_type.slice(0, 40),
            }));
      }
    } catch {
      kbFailed = true;
    }
    if (kbFailed) {
      setTe(tc("polSrcUnavail"));
      setTl(false);
      return;
    }
    try {
      const body: Record<string, unknown> = { tool_type: "check_policy", conversation_id: conversationId, content: ac };
      if (pctx.length > 0) body.policy_context = pctx;
      const { data, error } = await supabase.functions.invoke("agent-assist", { body });
      if (error || !data?.success) setTe(tc("polFailed"));
      else setTr({ type: "check_policy", data: data.result });
    } catch {
      setTe(tc("netError"));
    }
    setTl(false);
  }

  const dis = tl || kl || !hc || isResolved;
  const TOOLS = [
    {
      k: "translate",
      l: tc("translate"),
      i: "🌐",
      a: () => runTool("translate", { target_language: lang === "zh" ? "en" : "zh-TW" }),
    },
    { k: "grammar", l: tc("grammar"), i: "✏️", a: () => runTool("grammar") },
    { k: "check_policy", l: tc("policy"), i: "📋", a: runPol },
    { k: "knowledge", l: tc("knowledge"), i: "📚", a: runKb },
    { k: "suggest_reply", l: tc("suggest"), i: "💡", a: () => runTool("suggest_reply") },
  ];

  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        background: "#fff",
        borderLeft: "0.5px solid #e8e6e0",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "0.5px solid #e8e6e0",
          fontSize: 11,
          fontWeight: 600,
          color: "#374151",
          flexShrink: 0,
        }}
      >
        {tc("panelTitle")}
      </div>
      {isResolved ? (
        <div style={{ padding: "20px 10px", textAlign: "center", color: "#9ca3af", fontSize: 11 }}>
          {tc("resolved")}
        </div>
      ) : (
        <>
          <div style={{ padding: "6px 10px", borderBottom: "0.5px solid #f3f4f6", flexShrink: 0, fontSize: 10 }}>
            <div style={{ display: "flex", gap: 3, marginBottom: 4 }}>
              {[
                { k: "draft" as const, l: tc("useDraft"), d: !draftText.trim() },
                { k: "selected" as const, l: tc("useSelected"), d: !selectedMessage },
                { k: "custom" as const, l: tc("customInput"), d: false },
              ].map((s) => (
                <button
                  key={s.k}
                  onClick={() => !s.d && setCs(s.k)}
                  style={{
                    fontSize: 8,
                    padding: "2px 5px",
                    borderRadius: 3,
                    border: cs === s.k ? "1px solid #8b5cf6" : "1px solid #e5e7eb",
                    background: cs === s.k ? "#faf5ff" : s.d ? "#f9fafb" : "#fff",
                    color: s.d ? "#d1d5db" : cs === s.k ? "#7c3aed" : "#555",
                    cursor: s.d ? "not-allowed" : "pointer",
                    fontWeight: 500,
                  }}
                >
                  {s.l}
                </button>
              ))}
            </div>
            {cs === "draft" && (
              <div
                style={{
                  fontSize: 9,
                  color: draftText.trim() ? "#555" : "#d1d5db",
                  background: "#f9fafb",
                  borderRadius: 3,
                  padding: "3px 5px",
                  maxHeight: 40,
                  overflow: "hidden",
                }}
              >
                {draftText.trim() || tc("draftEmpty")}
              </div>
            )}
            {cs === "selected" && (
              <div
                style={{
                  fontSize: 9,
                  background: "#f9fafb",
                  borderRadius: 3,
                  padding: "3px 5px",
                  maxHeight: 40,
                  overflow: "hidden",
                }}
              >
                {selectedMessage ? (
                  <>
                    <span style={{ color: "#8b5cf6", fontWeight: 600 }}>
                      {tc("selPrev")}[{selectedMessage.role}]
                    </span>{" "}
                    {selectedMessage.content.slice(0, 60)}
                    <button
                      onClick={onClearSelection}
                      style={{
                        marginLeft: 3,
                        fontSize: 8,
                        color: "#ef4444",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      {tc("clear")}
                    </button>
                  </>
                ) : (
                  <span style={{ color: "#d1d5db" }}>{tc("noSel")}</span>
                )}
              </div>
            )}
            {cs === "custom" && (
              <textarea
                value={ci}
                onChange={(e) => setCi(e.target.value)}
                placeholder={tc("customPh")}
                style={{
                  width: "100%",
                  fontSize: 9,
                  border: "1px solid #e5e7eb",
                  borderRadius: 3,
                  padding: "3px 5px",
                  resize: "vertical",
                  minHeight: 30,
                  maxHeight: 70,
                  fontFamily: "inherit",
                  boxSizing: "border-box",
                }}
              />
            )}
            {tooLong && <div style={{ fontSize: 8, color: "#ef4444", marginTop: 2 }}>{tc("tooLong")}</div>}
          </div>
          <div
            style={{
              padding: "5px 10px",
              display: "flex",
              flexWrap: "wrap",
              gap: 3,
              borderBottom: "0.5px solid #f3f4f6",
              flexShrink: 0,
            }}
          >
            {TOOLS.map((t) => (
              <button
                key={t.k}
                onClick={t.a}
                disabled={dis}
                style={{
                  fontSize: 9,
                  padding: "3px 6px",
                  borderRadius: 4,
                  border: "1px solid #e5e7eb",
                  background: dis ? "#f9fafb" : "#fff",
                  cursor: dis ? "not-allowed" : "pointer",
                  color: dis ? "#d1d5db" : "#374151",
                  fontWeight: 500,
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                }}
              >
                <span>{t.i}</span>
                {t.l}
              </button>
            ))}
          </div>
        </>
      )}
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px", fontSize: 10 }}>
        {(tl || kl) && <div style={{ textAlign: "center", color: "#888", padding: 14 }}>{tc("processing")}</div>}
        {te && <div style={{ color: "#ef4444", padding: "4px 0" }}>{te}</div>}
        {ke && <div style={{ color: "#ef4444", padding: "4px 0" }}>{ke}</div>}
        {kr.length > 0 && (
          <div>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#6366f1", marginBottom: 3 }}>{tc("kbResult")}</div>
            {kr.map((r, i) => (
              <div
                key={i}
                style={{
                  background: "#f9fafb",
                  border: "1px solid #e8e6e0",
                  borderRadius: 4,
                  padding: "4px 6px",
                  marginBottom: 3,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 9 }}>{r.display_label}</div>
                <div style={{ fontSize: 9, color: "#555", lineHeight: 1.4 }}>{r.content.slice(0, 150)}</div>
                {r.source_type && (
                  <span
                    style={{
                      fontSize: 8,
                      background: "#ede9fe",
                      color: "#6366f1",
                      padding: "1px 4px",
                      borderRadius: 6,
                    }}
                  >
                    {r.source_type}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {tr?.type === "translate" && (
          <div>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#2563eb", marginBottom: 3 }}>{tc("transResult")}</div>
            <div
              style={{
                background: "#f0f9ff",
                border: "1px solid #bae6fd",
                borderRadius: 4,
                padding: "5px",
                lineHeight: 1.4,
              }}
            >
              {String(tr.data.translated_text)}
            </div>
            <button
              onClick={() => onUseDraft(String(tr.data.translated_text))}
              style={{
                marginTop: 3,
                fontSize: 9,
                padding: "2px 7px",
                borderRadius: 3,
                border: "1px solid #2563eb",
                background: "#eff6ff",
                color: "#2563eb",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {tc("useInDraft")}
            </button>
          </div>
        )}
        {tr?.type === "grammar" && (
          <div>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#16a34a", marginBottom: 3 }}>{tc("gramResult")}</div>
            <div
              style={{
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: 4,
                padding: "5px",
                lineHeight: 1.4,
              }}
            >
              {String(tr.data.corrected_text)}
            </div>
            <div style={{ fontSize: 8, color: "#888", marginTop: 2 }}>
              {String(tr.data.summary)} · {String(tr.data.tone_assessment)}
            </div>
            <button
              onClick={() => onUseDraft(String(tr.data.corrected_text))}
              style={{
                marginTop: 3,
                fontSize: 9,
                padding: "2px 7px",
                borderRadius: 3,
                border: "1px solid #16a34a",
                background: "#f0fdf4",
                color: "#16a34a",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {tc("useInDraft")}
            </button>
          </div>
        )}
        {tr?.type === "check_policy" && (
          <div>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#f59e0b", marginBottom: 3 }}>{tc("polResult")}</div>
            <div
              style={{
                background:
                  tr.data.status === "compliant"
                    ? "#f0fdf4"
                    : tr.data.status === "insufficient_evidence"
                      ? "#f9fafb"
                      : "#fef3c7",
                border:
                  "1px solid " +
                  (tr.data.status === "compliant"
                    ? "#bbf7d0"
                    : tr.data.status === "insufficient_evidence"
                      ? "#e5e7eb"
                      : "#fde68a"),
                borderRadius: 4,
                padding: "5px",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 9, textTransform: "uppercase" }}>{String(tr.data.status)}</div>
              <div style={{ fontSize: 9, lineHeight: 1.4 }}>{String(tr.data.summary)}</div>
            </div>
            <div style={{ fontSize: 8, color: "#888", marginTop: 2, fontStyle: "italic" }}>{tc("basedOn")}</div>
            {Array.isArray(tr.data.issues) &&
              (tr.data.issues as Array<Record<string, string>>).map((iss, i) => (
                <div
                  key={i}
                  style={{
                    marginTop: 2,
                    fontSize: 8,
                    padding: "2px 4px",
                    background: iss.severity === "violation" ? "#fef2f2" : "#fffbeb",
                    borderRadius: 3,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{iss.severity}:</span> {iss.excerpt}{" "}
                  <span style={{ color: "#888" }}>({iss.policy_label})</span>
                </div>
              ))}
          </div>
        )}
        {tr?.type === "suggest_reply" && (
          <div>
            <div style={{ fontSize: 9, fontWeight: 600, color: "#8b5cf6", marginBottom: 3 }}>{tc("sugResult")}</div>
            <div style={{ fontSize: 8, color: "#888", marginBottom: 3, fontStyle: "italic" }}>{tc("draftOnly")}</div>
            {Array.isArray(tr.data.suggestions) &&
              (tr.data.suggestions as Array<{ content: string; tone_label: string }>).map((s, i) => (
                <div
                  key={i}
                  style={{
                    background: "#faf5ff",
                    border: "1px solid #e9d5ff",
                    borderRadius: 4,
                    padding: "5px",
                    marginBottom: 3,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                    <span
                      style={{
                        fontSize: 8,
                        background: "#ede9fe",
                        color: "#6366f1",
                        padding: "1px 4px",
                        borderRadius: 6,
                        fontWeight: 600,
                      }}
                    >
                      {s.tone_label}
                    </span>
                    <button
                      onClick={() => onUseDraft(s.content)}
                      style={{
                        fontSize: 8,
                        padding: "1px 6px",
                        borderRadius: 3,
                        border: "1px solid #8b5cf6",
                        background: "#faf5ff",
                        color: "#8b5cf6",
                        cursor: "pointer",
                        fontWeight: 600,
                      }}
                    >
                      {tc("use")}
                    </button>
                  </div>
                  <div style={{ fontSize: 9, lineHeight: 1.4 }}>{s.content}</div>
                </div>
              ))}
          </div>
        )}
        {!tl && !te && !tr && kr.length === 0 && !ke && !isResolved && (
          <div style={{ padding: "16px 10px", textAlign: "center", color: "#cbd5e1", fontSize: 9 }}>
            <div style={{ fontSize: 16, marginBottom: 4 }}>🛠️</div>
            {tc(hc ? "toolHint" : "noContent")}
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationDetailContent() {
  const { id } = Route.useParams();
  const { user } = useAuth();
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
      .select("id, role, content, status, is_recalled, metadata, created_at")
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

  const lang = useConsoleLang();
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
                        <div className="whitespace-pre-wrap">{m.content}</div>
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
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Type your reply…"
                  rows={4}
                  maxLength={4000}
                />
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

              {isElevated && (
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
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT: Agent Assist Tool Panel */}
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
