import { supabase } from "@/integrations/supabase/client";
import { useEffect, useRef, useState } from "react";
import type { LiveChannelConfigRow } from "@/lib/api/config.service";
import { PUBLIC_WIDGET_PREVIEW_SHA256 } from "@/lib/public-widget-preview-asset";
import getAuthoritativeWidgetSource from "virtual:c3-widget-preview-source";
import { resolveAuthoritativeSupabaseBinding } from "@/integrations/supabase/runtime-authority.mjs";

/** Existing public Widget, with an additional server-verified zero-paid preview restriction. */
export function OrdinaryWidgetPreview({ channel, actorId, lang }: { channel: LiveChannelConfigRow | null; actorId: string | null; lang: "en" | "zh" }) {
  const [widgetScript, setWidgetScript] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const active = useRef(true);
  const frame = useRef<HTMLIFrameElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const bridgeNonce = useRef(crypto.randomUUID());
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let subscribed: string | null = null;
    let events: ReturnType<typeof supabase.channel> | null = null;
    const watchConversation = async (conversationId: unknown, target: Window) => {
      if (!channel || !actorId || typeof conversationId !== "string" ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(conversationId) ||
        subscribed === conversationId || disposed) return;
      const request = ++revision;
      const {data: row, error} = await supabase.from("conversations")
        .select("id,company_id,channel_config_id").eq("id", conversationId).maybeSingle();
      if (disposed || request !== revision || target !== frame.current?.contentWindow) return;
      if (error || row?.id !== conversationId || row.company_id !== channel.company_id ||
        row.channel_config_id !== channel.id) return;
      if (events) void supabase.removeChannel(events);
      subscribed = conversationId;
      const notify = () => {
        if (disposed || request !== revision || target !== frame.current?.contentWindow) return;
        // Never forward raw database rows or the staff authentication token.
        target.postMessage({type:"ordinary-preview-event-v2", nonce:bridgeNonce.current,
          conversation_id:conversationId}, window.location.origin);
      };
      events = supabase.channel(`ordinary-preview-events-${actorId}-${conversationId}`)
        .on("postgres_changes", {event:"*",schema:"public",table:"messages",
          filter:`conversation_id=eq.${conversationId}`}, notify)
        .on("postgres_changes", {event:"UPDATE",schema:"public",table:"conversations",
          filter:`id=eq.${conversationId}`}, notify)
        .subscribe(status => { if (status === "SUBSCRIBED") notify(); });
    };
    const onMessage = async (event: MessageEvent) => {
      const data=event.data;
      if (disposed || !channel || !actorId || event.origin!==window.location.origin || event.source!==frame.current?.contentWindow || data?.type!=="ordinary-preview-request-v2" || data.nonce!==bridgeNonce.current || typeof data.id!=="string") return;
      const match=/^\/(create-visitor-session|receive-widget-message|widget-poll-messages)(\?[^#]*)?$/.exec(data.path ?? "");
      if (!match || !["GET","POST"].includes(data.method)) return;
      let body;try {body=data.body ? JSON.parse(data.body):undefined;} catch{return;}
      if(match[1]==="create-visitor-session" && (data.method!=="POST" || body?.channel_id!==channel.id || body?.console_preview!=="ordinary-widget-control-v2"))return;
      if(match[1]==="receive-widget-message" && data.method==="POST" && body?.console_preview!=="ordinary-widget-control-v2")return;
      if(match[1]==="receive-widget-message" && data.method==="GET" && new URLSearchParams(match[2]?.slice(1)).get("console_preview")!=="ordinary-widget-control-v2")return;
      // Ordinary Preview uses the authenticated bridge for JSON readback;
      // staff credentials cannot be used to start a visitor streaming request.
      if (body?.subscribe_events !== undefined) return;
      try {
        const result=await supabase.functions.invoke(match[1]+(match[2] ?? ""),{method:data.method,body});
        if(disposed || !active.current || event.source!==frame.current?.contentWindow)return;
        let response=result.data,status=result.error ? 503:200;
        const context=result.error && "context" in result.error ? result.error.context:undefined;
        if(context instanceof Response){status=context.status;response=await context.clone().json().catch(()=>null);}
        if(disposed || event.source!==frame.current?.contentWindow)return;
        // Only visitor API output crosses the bridge. Auth/JWT credentials never enter iframe code.
        (event.source as Window).postMessage({type:"ordinary-preview-response-v2",nonce:bridgeNonce.current,id:data.id,status,body:response},event.origin);
        if (!result.error && response?.success === true && data.method === "POST" &&
          (match[1] === "create-visitor-session" || match[1] === "widget-poll-messages")) {
          void watchConversation(match[1] === "create-visitor-session" ? response.data?.conversation_id : body?.conversation_id,
            event.source as Window).catch(() => {});
        }
      } catch { if(!disposed && active.current && event.source===frame.current?.contentWindow)(event.source as Window).postMessage({type:"ordinary-preview-response-v2",nonce:bridgeNonce.current,id:data.id,status:503,body:{success:false,error:"preview_request_unconfirmed"}},event.origin); }
    };
    window.addEventListener("message",onMessage);
    return () => {
      disposed = true; revision++; subscribed = null;
      window.removeEventListener("message",onMessage);
      if (events) void supabase.removeChannel(events);
    };
  },[channel?.id,channel?.company_id,actorId]);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const allowed = Boolean(actorId && channel?.company_id && channel.is_active && channel.channel_type === "web_widget" && channel.allowed_origins?.includes(origin));
  // A published-only Company channel must not be silently opened from the editor Preview origin.
  const publishedOrigin = "https://console-chat-hub.lovable.app";
  const publishedOnly = Boolean(!channel?.allowed_origins?.includes(origin) && channel?.allowed_origins?.includes(publishedOrigin));
  const api = resolveAuthoritativeSupabaseBinding().functionsUrl;
  const attr = (value: string) => value.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const open = async () => {
    if (!allowed || loading || activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setAssetError(null);
    try {
      // The canonical public Widget is bundled with this exact frontend build.
      // Avoid a separate hosted static-asset version that can drift from the served app.
      const bytes = new TextEncoder().encode(getAuthoritativeWidgetSource());
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
        .map(value => value.toString(16).padStart(2, "0")).join("");
      if (digest !== PUBLIC_WIDGET_PREVIEW_SHA256) throw new Error("asset_revision_mismatch");
      const script = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!script.includes("__nexusChatLoaded")) throw new Error("asset_entrypoint_missing");
      if (active.current && !controller.signal.aborted) setWidgetScript(script);
    } catch (error) {
      if (active.current && !controller.signal.aborted) {
        setAssetError(error instanceof Error ? error.message : "asset_unavailable");
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      if (active.current && !controller.signal.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    if (allowed) void open();
    else { setWidgetScript(null); setAssetError(null); }
    return () => { activeRequest.current?.abort(); activeRequest.current = null; };
    // The route remounts this component for each account/channel; do not auto-dispatch on unrelated renders.
  }, [allowed, channel?.id, actorId]);
  const doc = allowed && channel && api && widgetScript ? `<!doctype html><html><body><p>Ordinary visitor Widget · own channel · control-only preview</p><script data-asset-sha256="${PUBLIC_WIDGET_PREVIEW_SHA256}" data-channel-id="${attr(channel.id)}" data-company-id="${attr(channel.company_id!)}" data-api-base="${attr(api)}" data-console-preview="ordinary-widget-control-v2" data-preview-actor="${attr(actorId!)}" data-preview-bridge="${attr(bridgeNonce.current)}" data-preview-parent-origin="${attr(origin)}">${widgetScript.replace(/<\/script/gi,"<\\/script")}</script><script>document.querySelector(".nx-bubble")?.click();</script></body></html>` : "";
  return <section className="rounded-lg border bg-white p-4" aria-label="Ordinary Widget Preview">
    <h2>{lang === "zh" ? "普通 Widget：目前公司的訪客流程" : "Ordinary Widget: visitor flow for the current company"}</h2>
    <p>{lang === "zh" ? "使用既有公開 Widget、Visitor Session、訊息接收及回讀 API；不使用 C3 合成測試帳戶。此預覽只開放身份確認及明確真人要求，商業 AI、KB 查詢及附件均不開放。開啟聊天可能建立真實訪客對話。" : "Uses the existing public Widget, visitor session, message and polling APIs. This is separate from the C3 synthetic test. Preview permits identity and explicit human requests only; business AI, KB queries and attachments are unavailable. Opening chat may create a real visitor conversation."}</p>
    {!allowed && <p role="alert">{lang === "zh" ? "目前帳戶／channel／網站 Origin 未符合普通 Widget 預覽條件。請使用該 channel 已允許的網站；此畫面不會更改 allowed_origins 或借用 C3 channel。" : "The current account/channel/origin is not eligible. Use an origin already allowed for this channel. This screen does not modify allowed_origins or borrow the C3 channel."}</p>}
    {!allowed && publishedOnly && <p role="status" className="mt-2 text-sm">{lang === "zh" ? "此 Channel 只允許已發布網站：" : "Use the already-authorized published origin:"} <a href="https://console-chat-hub.lovable.app/console/widget-preview" target="_blank" rel="noopener noreferrer" className="underline">https://console-chat-hub.lovable.app/console/widget-preview</a></p>}
    {allowed && <p role="note" className="my-2 text-sm">{lang === "zh" ? "僅能測試四句：你是誰？／Who are you?／請轉真人客服／Please connect me to a human.；此模式不會回答其他 AI／KB 商業問題。" : "Control-only Preview accepts: 你是誰？ / Who are you? / 請轉真人客服 / Please connect me to a human. Other business AI/KB questions are not sent here."}</p>}

    {assetError && allowed && (
      <aside role="alert" className="fixed inset-y-0 right-0 z-40 flex w-full flex-col gap-3 border-l border-amber-200 bg-white p-5 shadow-xl sm:w-[420px]" data-ordinary-preview-state="blocked">
        <h3 className="text-base font-semibold">{lang === "zh" ? "Widget 暫時無法載入" : "Widget could not be loaded"}</h3>
        <p className="text-sm">{lang === "zh" ? "已阻止未核實版本的 Widget。請重試；如仍失敗，須核對正式網站的 Widget 資產。" : "An unverified Widget asset was blocked. Retry once; if this persists, the published Widget asset needs verification."}</p>
        <code className="break-all rounded bg-slate-100 p-2 text-xs">{assetError}</code>
        <button type="button" onClick={open} disabled={loading} className="rounded-lg bg-slate-900 px-4 py-3 font-semibold text-white disabled:opacity-60">{lang === "zh" ? "重試載入 Widget" : "Retry loading Widget"}</button>
      </aside>
    )}
    {allowed && !widgetScript && !assetError && (
      <aside aria-live="polite" data-ordinary-preview-state="loading" className="fixed inset-y-0 right-0 z-40 flex w-full items-center justify-center border-l bg-white p-5 shadow-xl sm:w-[420px]">
        <p className="text-sm text-slate-600">{lang === "zh" ? "正在核實並開啟 Widget…" : "Verifying and opening Widget…"}</p>
      </aside>
    )}
    {widgetScript && allowed && (
      <iframe ref={frame} title="Ordinary own-company Widget" sandbox="allow-scripts allow-same-origin" srcDoc={doc}
        data-ordinary-preview-state="ready" className="fixed inset-y-0 right-0 z-40 h-[100dvh] w-full border-l bg-white shadow-xl sm:w-[420px]" />
    )}
  </section>;
}
