from pathlib import Path

TARGET = Path("supabase/functions/generate-reply/index.ts")
text = TARGET.read_text(encoding="utf-8")

old = '''const SAFE_HANDOFF_WORDING: Record<string, string> = {
  "zh-TW": "我們已將你的對話記錄，客服接手後會在此對話中回覆你。目前未啟用即時輪候時間顯示。",
  "zh-CN": "我们已将你的对话记录，客服接手后会在此对话中回复你。目前未启用实时排队位置和预计等待时间显示。",
  en: "We have recorded your conversation. A human agent will reply in this same chat after taking over. Real-time queue position and estimated wait time are not currently enabled.",
};'''

new = '''const SAFE_HANDOFF_WORDING: Record<string, string> = {
  "zh-TW": "我們已將你的對話轉交真人客服。客服接手後會在此對話中回覆你；如目前有可用的輪候資料，系統會在此顯示輪候位置及預計等候時間。",
  "zh-CN": "我们已将你的对话转交人工客服。客服接手后会在此对话中回复你；如目前有可用的排队资料，系统会在此显示排队位置及预计等待时间。",
  en: "I’ve handed this conversation to a human support agent. They will reply in this same chat after taking over; if live queue data is available, your queue position and estimated wait will be shown here.",
};'''

if text.count(old) != 1:
    raise SystemExit(f"expected exactly one stale SAFE_HANDOFF_WORDING block, found {text.count(old)}")

patched = text.replace(old, new, 1)

for forbidden in (
    "目前未啟用即時輪候時間顯示",
    "目前未启用实时排队位置和预计等待时间显示",
    "Real-time queue position and estimated wait time are not currently enabled",
):
    if forbidden in patched:
        raise SystemExit(f"stale wording remains: {forbidden}")

for required in (
    "如目前有可用的輪候資料",
    "如目前有可用的排队资料",
    "if live queue data is available",
    'p_safe_reply_content: SAFE_HANDOFF_WORDING[handoffLang]',
    'p_safe_reply_content: SAFE_HANDOFF_WORDING[classified.language]',
):
    if required not in patched:
        raise SystemExit(f"required source assertion missing: {required}")

TARGET.write_text(patched, encoding="utf-8")
print("WORKFLOW5_R1_QUEUE_WORDING_PATCH=PASS")
