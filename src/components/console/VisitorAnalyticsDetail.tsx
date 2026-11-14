import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { parseFunctionResponse } from "@/lib/ce-evaluation-execution";
import { useConsoleLang } from "@/hooks/useEffectiveRole";

type Detail = {
  first_seen: string | null;
  last_seen: string | null;
  conversations: Array<{ status: string; created_at: string | null; resolved_at: string | null;
    message_count: number; has_feedback: boolean; rating: number | null }>;
};
type Receipt = { status: number | null; requestId: string; error: string | null };
export function VisitorAnalyticsDetail() {
  const lang = useConsoleLang();
  const text = (en: string, zh: string) => lang === "zh" ? zh : en;
  const [sessionId, setSessionId] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; }, []);

  async function readDetail() {
    const id = sessionId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      setState("error"); setDetail(null); setReceipt({ status: null, requestId: "", error: "invalid_visitor_session_id" }); return;
    }
    const current = ++epoch.current;
    setState("loading"); setDetail(null); setReceipt(null);
    try {
      const result = await supabase.functions.invoke("visitor-analytics", { body: { visitor_session_id: id } });
      const parsed = await parseFunctionResponse(result);
      if (current !== epoch.current) return;
      const body = result.data as { success?: boolean; visitor?: Detail; error?: string } | null;
      const errorBody = parsed.body as { error?: string } | null;
      const requestId = result.response?.headers.get("sb-request-id") ?? parsed.requestId;
      const error = body?.error ?? errorBody?.error ?? (result.error ? parsed.classification : null);
      setReceipt({ status: parsed.status, requestId, error });
      const valid = Array.isArray(body?.visitor?.conversations) && body.visitor.conversations.every(c =>
        typeof c.status === "string" && Number.isSafeInteger(c.message_count) && c.message_count >= 0 &&
        typeof c.has_feedback === "boolean" && (c.rating === null || typeof c.rating === "number" && Number.isFinite(c.rating)));
      if (result.error || !body?.success || !valid) {
        if (!error) setReceipt({ status: parsed.status, requestId, error: "invalid_response" });
        setState("error"); return;
      }
      if (!body.visitor) return;
      setDetail(body.visitor); setState("success");
    } catch {
      if (current !== epoch.current) return;
      setReceipt({ status: null, requestId: "", error: "transport_unknown" }); setState("error");
    }
  }

  return <section aria-label={text("Session detail reconciliation", "工作階段明細對賬")} style={{ marginTop: 20 }}>
    <h2>{text("Session detail reconciliation", "工作階段明細對賬")}</h2>
    <label>{text("Visitor session UUID", "訪客工作階段 UUID")}
      <input value={sessionId} onChange={e => {
        epoch.current++; setSessionId(e.target.value); setDetail(null); setReceipt(null); setState("idle");
      }} />
    </label>
    <button type="button" disabled={state === "loading" || !sessionId.trim()} onClick={() => void readDetail()}>
      {text("Read session details", "讀取工作階段明細")}
    </button>
    {state === "loading" && <p role="status">{text("Loading session details…", "正在讀取明細…")}</p>}
    {receipt && <p role={state === "error" ? "alert" : "status"}>
      {receipt.status === null ? text("HTTP status unavailable", "未取得 HTTP 狀態") : `HTTP ${receipt.status}`}
      {receipt.error && ` · ${receipt.error}`}
      {receipt.requestId && receipt.requestId !== "NOT_AVAILABLE" && ` · ${receipt.requestId}`}
    </p>}
    {state === "success" && detail && <>
      <p>{text("Conversations", "對話數")}: {detail.conversations.length} · {text("Messages", "訊息數")}: {detail.conversations.reduce((sum, c) => sum + c.message_count, 0)}</p>
      <table><thead><tr>{[text("Created", "建立時間"), text("Status", "狀態"), text("Messages", "訊息數"), text("Rating", "評分")].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{detail.conversations.map((c, i) => <tr key={i}>
          <td>{c.created_at ?? "—"}</td><td>{c.status}</td><td>{c.message_count}</td><td>{c.has_feedback ? c.rating ?? "—" : "—"}</td>
        </tr>)}</tbody>
      </table>
    </>}
  </section>;
}
