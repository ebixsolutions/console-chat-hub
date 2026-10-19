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
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const allowed = Boolean(actorId && channel?.company_id && channel.is_active && channel.channel_type === "web_widget" && channel.allowed_origins?.includes(origin));
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
  const doc = allowed && channel && api && widgetScript ? `<!doctype html><html><body><p>Ordinary visitor Widget · own channel · control-only preview</p><script data-asset-sha256="${PUBLIC_WIDGET_PREVIEW_SHA256}" data-channel-id="${attr(channel.id)}" data-company-id="${attr(channel.company_id!)}" data-api-base="${attr(api)}" data-console-preview="ordinary-widget-control-v1" data-preview-actor="${attr(actorId!)}">${widgetScript.replace(/<\/script/gi,"<\\/script")}</script></body></html>` : "";
  return <section className="rounded-lg border bg-white p-4" aria-label="Ordinary Widget Preview">
    <h2>{lang === "zh" ? "普通 Widget：目前公司的訪客流程" : "Ordinary Widget: visitor flow for the current company"}</h2>
    <p>{lang === "zh" ? "使用既有公開 Widget、Visitor Session、訊息接收及回讀 API；不使用 C3 合成測試帳戶。此預覽只開放身份確認及明確真人要求，商業 AI、KB 查詢及附件均不開放。開啟聊天可能建立真實訪客對話。" : "Uses the existing public Widget, visitor session, message and polling APIs. This is separate from the C3 synthetic test. Preview permits identity and explicit human requests only; business AI, KB queries and attachments are unavailable. Opening chat may create a real visitor conversation."}</p>
    {!allowed && <p role="alert">{lang === "zh" ? "目前帳戶／channel／網站 Origin 未符合普通 Widget 預覽條件。請使用該 channel 已允許的網站；此畫面不會更改 allowed_origins 或借用 C3 channel。" : "The current account/channel/origin is not eligible. Use an origin already allowed for this channel. This screen does not modify allowed_origins or borrow the C3 channel."}</p>}
    {assetError && <p role="alert">{lang === "zh" ? "普通 Widget 程式版本未能核實；不會載入舊程式或建立訪客對話。" : "The public Widget asset revision could not be verified. No older script or visitor conversation will be started."}</p>}
    {allowed && !widgetScript && <button type="button" disabled={loading} onClick={open}>{lang === "zh" ? "開啟普通 Widget 預覽" : "Open ordinary Widget preview"}</button>}
    {widgetScript && allowed && <iframe title="Ordinary own-company Widget" sandbox="allow-scripts allow-same-origin" srcDoc={doc} className="mt-3 h-[720px] w-full rounded-lg border" />}
  </section>;
}
