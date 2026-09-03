from pathlib import Path

# Workflow 5 final customer-facing R1 queue/ETA wording closure.
TARGET = Path("supabase/functions/generate-reply/index.ts")
text = TARGET.read_text(encoding="utf-8")

old_block = '''const SAFE_HANDOFF_WORDING: Record<string, string> = {
  "zh-TW": "我們已將你的對話記錄，客服接手後會在此對話中回覆你。目前未啟用即時輪候時間顯示。",
  "zh-CN": "我们已将你的对话记录，客服接手后会在此对话中回复你。目前未启用实时排队位置和预计等待时间显示。",
  en: "We have recorded your conversation. A human agent will reply in this same chat after taking over. Real-time queue position and estimated wait time are not currently enabled.",
};'''

new_block = '''const SAFE_HANDOFF_WORDING: Record<string, string> = {
  "zh-TW": "我們已將你的對話轉交真人客服。客服接手後會在此對話中回覆你；如目前有可用的輪候資料，系統會在此顯示輪候位置及預計等候時間。",
  "zh-CN": "我们已将你的对话转交人工客服。客服接手后会在此对话中回复你；如目前有可用的排队资料，系统会在此显示排队位置及预计等待时间。",
  en: "I’ve handed this conversation to a human support agent. They will reply in this same chat after taking over; if live queue data is available, your queue position and estimated wait will be shown here.",
};'''

legacy_old = 'When the customer explicitly requests a human agent, or when you transfer to a human agent, include a short safe handoff status message in the same language and script as the customer. The message must state that the conversation has been recorded and that a human agent will reply in this same chat after taking over. If the customer is using Traditional Chinese, use: "我們已將你的對話記錄，客服接手後會在此對話中回覆你。目前未啟用即時輪候時間顯示。" If the customer is using Simplified Chinese, use: "我们已将你的对话记录，客服接手后会在此对话中回复你。目前未启用实时排队位置和预计等待时间显示。" If the customer is using English, use: "We have recorded your conversation. A human agent will reply in this same chat after taking over. Real-time queue position and estimated wait time are not currently enabled." Do NOT invent estimated wait times, response-time promises, or queue positions.'

legacy_new = 'When the customer explicitly requests a human agent, or when you transfer to a human agent, include a short safe handoff status message in the same language and script as the customer. Confirm only that the conversation has been handed to human support and that the agent will reply in this same chat. Queue position, customers-ahead counts, and estimated wait time are dynamic widget runtime data: never invent or hard-code them. If live queue data is available, the widget will display it separately; if it is unavailable, do not promise an estimate.'

if text.count(old_block) != 1:
    raise SystemExit(f"expected exactly one stale SAFE_HANDOFF_WORDING block, found {text.count(old_block)}")
if text.count(legacy_old) != 1:
    raise SystemExit(f"expected exactly one stale legacy handoff prompt, found {text.count(legacy_old)}")

patched = text.replace(old_block, new_block, 1).replace(legacy_old, legacy_new, 1)

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
    "Queue position, customers-ahead counts, and estimated wait time are dynamic widget runtime data",
    'p_safe_reply_content: SAFE_HANDOFF_WORDING[handoffLang]',
    'p_safe_reply_content: SAFE_HANDOFF_WORDING[classified.language]',
):
    if required not in patched:
        raise SystemExit(f"required source assertion missing: {required}")

TARGET.write_text(patched, encoding="utf-8")
print("WORKFLOW5_R1_QUEUE_WORDING_PATCH=PASS")
