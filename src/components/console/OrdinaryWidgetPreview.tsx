import { supabase } from "@/integrations/supabase/client";
import { useEffect, useRef, useState } from "react";
import type { LiveChannelConfigRow } from "@/lib/api/config.service";
import { PUBLIC_WIDGET_PREVIEW_SHA256 } from "@/lib/public-widget-preview-asset";
import { resolveAuthoritativeSupabaseBinding } from "@/integrations/supabase/runtime-authority.mjs";

/** Existing public Widget, with an additional server-verified zero-paid preview restriction. */
export function OrdinaryWidgetPreview({ channel, actorId, lang }: { channel: LiveChannelConfigRow | null; actorId: string | null; lang: "en" | "zh" }) {
  const [widgetScript, setWidgetScript] = useState<string | null>(null);
  const [assetError, setAssetError] = useState(false);
  const [loading, setLoading] = useState(false);
  const active = useRef(true);
  const frame = useRef<HTMLIFrameElement>(null);
  const bridgeNonce = useRef(crypto.randomUUID());
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const data=event.data;
      if (!channel || !actorId || event.origin!==window.location.origin || event.source!==frame.current?.contentWindow || data?.type!=="ordinary-preview-request-v2" || data.nonce!==bridgeNonce.current || typeof data.id!=="string") return;
      const match=/^\/(create-visitor-session|receive-widget-message|widget-poll-messages)(\?[^#]*)?$/.exec(data.path ?? "");
      if (!match || !["GET","POST"].includes(data.method)) return;
      let body;try {body=data.body ? JSON.parse(data.body):undefined;} catch{return;}
      if(match[1]==="create-visitor-session" && (data.method!=="POST" || body?.channel_id!==channel.id || body?.console_preview!=="ordinary-widget-control-v2"))return;
      if(match[1]==="receive-widget-message" && data.method==="POST" && body?.console_preview!=="ordinary-widget-control-v2")return;
      if(match[1]==="receive-widget-message" && data.method==="GET" && new URLSearchParams(match[2]?.slice(1)).get("console_preview")!=="ordinary-widget-control-v2")return;
      try {
        const result=await supabase.functions.invoke(match[1]+(match[2] ?? ""),{method:data.method,body});
        if(!active.current || event.source!==frame.current?.contentWindow)return;
        let response=result.data,status=result.error ? 503:200;
        const context=result.error && "context" in result.error ? result.error.context:undefined;
        if(context instanceof Response){status=context.status;response=await context.clone().json().catch(()=>null);}
        // Only visitor API output crosses the bridge. Auth/JWT credentials never enter iframe code.
        (event.source as Window).postMessage({type:"ordinary-preview-response-v2",nonce:bridgeNonce.current,id:data.id,status,body:response},event.origin);
      } catch { if(active.current && event.source===frame.current?.contentWindow)(event.source as Window).postMessage({type:"ordinary-preview-response-v2",nonce:bridgeNonce.current,id:data.id,status:503,body:{success:false,error:"preview_request_unconfirmed"}},event.origin); }
    };
    window.addEventListener("message",onMessage);return()=>window.removeEventListener("message",onMessage);
  },[channel?.id,actorId]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const allowed = Boolean(actorId && channel?.company_id && channel.is_active && channel.channel_type === "web_widget" && channel.allowed_origins?.includes(origin));
  // A published-only Company channel must not be silently opened from the editor Preview origin.
  const publishedOrigin = "https://console-chat-hub.lovable.app";
  const publishedOnly = Boolean(!channel?.allowed_origins?.includes(origin) && channel?.allowed_origins?.includes(publishedOrigin));
  const api = resolveAuthoritativeSupabaseBinding().functionsUrl;
  const attr = (value: string) => value.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const open = async () => {
    if (!allowed || loading) return;
    setLoading(true); setAssetError(false);
    try {
      const response = await fetch("/widget/chat.js",{cache:"no-store",credentials:"same-origin"});
      if (!response.ok) throw new Error("asset_unavailable");
      const bytes = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))).map(v=>v.toString(16).padStart(2,"0")).join("");
      if (digest !== PUBLIC_WIDGET_PREVIEW_SHA256) throw new Error("asset_revision_mismatch");
      if (active.current) setWidgetScript(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    } catch { if (active.current) setAssetError(true); }
    finally { if (active.current) setLoading(false); }
  };
  const doc = allowed && channel && api && widgetScript ? `<!doctype html><html><body><p>Ordinary visitor Widget · own channel · control-only preview</p><script data-asset-sha256="${PUBLIC_WIDGET_PREVIEW_SHA256}" data-channel-id="${attr(channel.id)}" data-company-id="${attr(channel.company_id!)}" data-api-base="${attr(api)}" data-console-preview="ordinary-widget-control-v2" data-preview-actor="${attr(actorId!)}" data-preview-bridge="${attr(bridgeNonce.current)}">${widgetScript.replace(/<\/script/gi,"<\\/script")}</script></body></html>` : "";
  return <section className="rounded-lg border bg-white p-4" aria-label="Ordinary Widget Preview">
    <h2>{lang === "zh" ? "普通 Widget：目前公司的訪客流程" : "Ordinary Widget: visitor flow for the current company"}</h2>
    <p>{lang === "zh" ? "使用既有公開 Widget、Visitor Session、訊息接收及回讀 API；不使用 C3 合成測試帳戶。此預覽只開放身份確認及明確真人要求，商業 AI、KB 查詢及附件均不開放。開啟聊天可能建立真實訪客對話。" : "Uses the existing public Widget, visitor session, message and polling APIs. This is separate from the C3 synthetic test. Preview permits identity and explicit human requests only; business AI, KB queries and attachments are unavailable. Opening chat may create a real visitor conversation."}</p>
    {!allowed && <p role="alert">{lang === "zh" ? "目前帳戶／channel／網站 Origin 未符合普通 Widget 預覽條件。請使用該 channel 已允許的網站；此畫面不會更改 allowed_origins 或借用 C3 channel。" : "The current account/channel/origin is not eligible. Use an origin already allowed for this channel. This screen does not modify allowed_origins or borrow the C3 channel."}</p>}
    {!allowed && publishedOnly && <p role="status" className="mt-2 text-sm">{lang === "zh" ? "此 Channel 只允許已發布網站：" : "Use the already-authorized published origin:"} <a href="https://console-chat-hub.lovable.app/console/widget-preview" target="_blank" rel="noopener noreferrer" className="underline">https://console-chat-hub.lovable.app/console/widget-preview</a></p>}
    {allowed && <p role="note" className="my-2 text-sm">{lang === "zh" ? "僅能測試四句：你是誰？／Who are you?／請轉真人客服／Please connect me to a human.；此模式不會回答其他 AI／KB 商業問題。" : "Control-only Preview accepts: 你是誰？ / Who are you? / 請轉真人客服 / Please connect me to a human. Other business AI/KB questions are not sent here."}</p>}

    {assetError && <p role="alert">{lang === "zh" ? "普通 Widget 程式版本未能核實；不會載入舊程式或建立訪客對話。" : "The public Widget asset revision could not be verified. No older script or visitor conversation will be started."}</p>}
    {allowed && !widgetScript && <button type="button" disabled={loading} onClick={open}>{lang === "zh" ? "開啟普通 Widget 預覽" : "Open ordinary Widget preview"}</button>}
    {widgetScript && allowed && <iframe ref={frame} title="Ordinary own-company Widget" sandbox="allow-scripts allow-same-origin" srcDoc={doc} className="mt-3 h-[720px] w-full rounded-lg border" />}
  </section>;
}
