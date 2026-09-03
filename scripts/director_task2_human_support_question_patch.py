from pathlib import Path

p = Path('supabase/functions/generate-reply/index.ts')
s = p.read_text()

anchor1 = '''const SAFE_HANDOFF_WORDING: Record<string, string> = {
  "zh-TW": "我們已將你的對話記錄，客服接手後會在此對話中回覆你。目前未啟用即時輪候時間顯示。",
  "zh-CN": "我们已将你的对话记录，客服接手后会在此对话中回复你。目前未启用实时排队位置和预计等待时间显示。",
  en: "We have recorded your conversation. A human agent will reply in this same chat after taking over. Real-time queue position and estimated wait time are not currently enabled.",
};
'''
insert1 = anchor1 + '''\nconst HUMAN_SUPPORT_INFO_WORDING: Record<"zh-TW" | "zh-CN" | "en", string> = {
  "zh-TW": "我目前沒有已確認的真人客服服務時間資料。如果你現在要轉真人客服，可以直接告訴我。",
  "zh-CN": "我目前没有已确认的人工客服服务时间资料。如果你现在要转人工客服，可以直接告诉我。",
  en: "I don't currently have confirmed human-support service hours. If you want a human agent now, you can tell me directly.",
};
'''
assert s.count(anchor1) == 1, f'anchor1 count={s.count(anchor1)}'
s = s.replace(anchor1, insert1, 1)

anchor2 = '''  if (!_deferR1ForE1) {
    const r1Response = await persistExplicitR1IfRequested(
      supabaseAdmin, conversation_id, source_message_id, _h1LastMsg,
    );
    if (r1Response) return r1Response;
  }

  const _conversationMemoryReply = resolveConversationMemoryResponse(_h1LastMsg, _pr5HistoryRows ?? []);
'''
insert2 = '''  if (!_deferR1ForE1) {
    const r1Response = await persistExplicitR1IfRequested(
      supabaseAdmin, conversation_id, source_message_id, _h1LastMsg,
    );
    if (r1Response) return r1Response;
  }

  // Asking about human-support availability/contact is informational, not an
  // explicit R1 request. Keep AI control and answer deterministically rather
  // than routing the question through KB/LLM grounding, where absence of an
  // authoritative schedule could incorrectly become S0.
  const _humanSupportIntent = classifyHandoffIntent(_h1LastMsg);
  if (_humanSupportIntent.kind === "question_about_human_support") {
    const infoReply = HUMAN_SUPPORT_INFO_WORDING[_humanSupportIntent.language];
    const committed = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      infoReply,
      {
        response_route: "human_support_information",
        handoff_required: false,
        escalation_rule: null,
        handoff_intent_kind: _humanSupportIntent.kind,
      },
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (!committed.ok) {
      if (committed.result === "human_control" || committed.result === "resolved" || committed.result === "superseded_source") {
        return new Response(JSON.stringify({ success: true, skipped: committed.result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ success: false, error: `human_support_info_commit_${committed.result}` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: true, response_route: "human_support_information", handoff_required: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const _conversationMemoryReply = resolveConversationMemoryResponse(_h1LastMsg, _pr5HistoryRows ?? []);
'''
assert s.count(anchor2) == 1, f'anchor2 count={s.count(anchor2)}'
s = s.replace(anchor2, insert2, 1)
p.write_text(s)
print('DIRECTOR_TASK2_HUMAN_SUPPORT_QUESTION_PATCH=PASS')
