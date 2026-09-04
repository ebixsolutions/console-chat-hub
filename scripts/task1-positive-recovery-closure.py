#!/usr/bin/env python3
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
GENERATE_REPLY = REPO / "supabase/functions/generate-reply/index.ts"


def patch_source() -> None:
    s = GENERATE_REPLY.read_text()
    old = 'import { buildEmotionReplyStrategyContext } from "../_shared/emotion-reply-strategy.ts";'
    new = 'import { buildEmotionReplyStrategyContext, resolvePositiveRecoveryAcknowledgement } from "../_shared/emotion-reply-strategy.ts";'
    assert old in s or new in s, "emotion strategy import anchor missing"
    if old in s:
        s = s.replace(old, new, 1)

    anchor = '  const _conversationMemoryReply = resolveConversationMemoryResponse(_h1LastMsg, _pr5HistoryRows ?? []);'
    marker = 'response_route: "positive_recovery_acknowledgement"'
    insert = "\n".join([
        '  // Pure positive-recovery acknowledgements are non-factual and must not enter KB/LLM grounding.',
        '  const _positiveRecoveryAcknowledgement = _pr5R3Sentiment?.emotion_kind === "positive_recovery"',
        '    ? resolvePositiveRecoveryAcknowledgement(_h1LastMsg, _visitorLang)',
        '    : null;',
        '  if (_positiveRecoveryAcknowledgement) {',
        '    const committed = await commitAiReplyWithControlGate(',
        '      supabaseAdmin,',
        '      conversation_id,',
        '      source_message_id,',
        '      _positiveRecoveryAcknowledgement,',
        '      {',
        '        response_route: "positive_recovery_acknowledgement",',
        '        handoff_required: false,',
        '        factual_grounding_required: false,',
        '      },',
        '    );',
        '    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);',
        '    if (!committed.ok) {',
        '      if (committed.result === "human_control" || committed.result === "resolved" || committed.result === "superseded_source") {',
        '        return new Response(JSON.stringify({ success: true, skipped: committed.result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });',
        '      }',
        '      return new Response(JSON.stringify({ success: false, error: `positive_recovery_commit_${committed.result}` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });',
        '    }',
        '    return new Response(JSON.stringify({ success: true, response_route: "positive_recovery_acknowledgement", handoff_required: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });',
        '  }',
        '',
    ])
    assert marker in s or anchor in s, "positive recovery insertion anchor missing"
    if marker not in s:
        s = s.replace(anchor, insert + anchor, 1)
    GENERATE_REPLY.write_text(s)
    updated = GENERATE_REPLY.read_text()
    assert marker in updated
    assert updated.index(marker) < updated.index(anchor)
    print("TASK1_POSITIVE_RECOVERY_SOURCE_ASSERTIONS=PASS")


def post(base: str, origin: str, path: str, body: dict):
    req = urllib.request.Request(
        base.rstrip("/") + "/" + path,
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={"Origin": origin, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {"raw": raw.decode(errors="replace")}
        return e.code, payload


def assert_language(label: str, text: str) -> None:
    cjk = len(re.findall(r"[\u3400-\u9fff]", text))
    if label in ("ZH_TW", "ZH_CN"):
        assert cjk >= 2, (label, "expected CJK", text)
    else:
        assert len(re.findall(r"[A-Za-z]+", text)) >= 3, (label, "expected English", text)
        assert cjk <= max(10, len(text) // 12), (label, "predominantly CJK", text)


def smoke() -> None:
    base = os.environ["VITE_SUPABASE_FUNCTIONS_URL"]
    origin = os.environ["PROD_ORIGIN"]
    channel = os.environ["CHANNEL_ID"]
    human = {"pending", "transferred", "human_needed", "human_control"}
    cases = {
        "ZH_TW": [
            "我已經看了好幾次還是不明白，真的很煩。四電一腦到底包括哪些種類？請直接講重點。",
            "我還是有點搞不清楚，也不確定自己理解得對不對。四電一腦可以再簡單解釋一次嗎？",
            "我現在就要弄清楚四電一腦，請用最簡單的方式列出包括哪些種類。",
            "明白了，這樣清楚多了，謝謝。",
        ],
        "ZH_CN": [
            "我已经看了很多次还是不明白，真的有点失望。四电一脑到底包括哪些种类？请直接讲重点。",
            "我还是有点搞不清楚，也不确定自己理解得对不对。四电一脑可以再简单解释一次吗？",
            "我现在就要弄清楚四电一脑，请用最简单的方式列出包括哪些种类。",
            "明白了，这样清楚多了，谢谢。",
        ],
        "EN": [
            "I've read about 四電一腦 several times and still don't understand it. I'm frustrated and disappointed. What categories does it include? Please keep it direct.",
            "I'm still confused and not sure I've understood 四電一腦 correctly. Can you explain it more simply?",
            "I want to understand 四電一腦 now. Please list the included categories as simply as possible.",
            "That makes sense now, thank you.",
        ],
    }
    category_terms = ["電視", "电视", "雪櫃", "冰箱", "洗衣", "冷氣", "空调", "電腦", "电脑", "television", "refrigerator", "washing", "air conditioner", "computer"]
    forbidden = ["退款已批准", "已批准退款", "退款已安排", "已經安排退款", "已经安排退款", "訂單已出貨", "订单已发货", "客服已接手", "人工客服已接入", "人工客服已经接入", "human agent has joined", "refund has been approved", "your order has shipped", "guaranteed compensation", "一定賠償", "一定赔偿"]
    all_answers = []

    for label, turns in cases.items():
        st, created = post(base, origin, "create-visitor-session", {
            "channel_id": channel,
            "visitor_metadata": {
                "task1_multilingual_emotion_smoke": True,
                "language": label,
                "fixture": "published_kb_four_appliances_one_computer",
                "exclude_training": True,
            },
        })
        assert st == 200 and created.get("success") is True, (label, "create", st, created)
        cid = created["data"]["conversation_id"]
        token = created["data"]["session_token"]
        prior = 0
        answers = []
        print(f"TASK1_{label}_CONVERSATION_ID={cid}")

        for turn, msg in enumerate(turns, 1):
            st, sent = post(base, origin, "receive-widget-message", {"conversation_id": cid, "session_token": token, "content": msg})
            assert st == 200 and sent.get("success") is True, (label, turn, "send", st, sent)
            deadline = time.time() + 55
            data = None
            while time.time() < deadline:
                st, polled = post(base, origin, "widget-poll-messages", {"conversation_id": cid, "session_token": token})
                assert st == 200 and polled.get("success") is True, (label, turn, "poll", st, polled)
                data = polled["data"]
                assistants = [m for m in (data.get("messages") or []) if m.get("role") == "assistant"]
                if len(assistants) > prior:
                    break
                time.sleep(1)
            assert data is not None, (label, turn, "missing poll")
            assistants = [m for m in (data.get("messages") or []) if m.get("role") == "assistant"]
            assert len(assistants) > prior, (label, turn, "no reply", data)
            ans = assistants[-1].get("content", "")
            status = data.get("conversation_status")
            assert ans.strip(), (label, turn, "empty reply")
            assert status not in human, (label, turn, "unexpected handoff", status, ans)
            assert_language(label, ans)
            low = ans.lower()
            for phrase in forbidden:
                assert phrase.lower() not in low, (label, turn, "fabricated action", phrase, ans)
            if turn == 4:
                stale = ["空調機", "洗衣機", "雪櫃", "電視機", "電腦", "空调机", "洗衣机", "冰箱", "电视机", "电脑"]
                assert not any(term in ans for term in stale), (label, "stale factual replay", ans)
            answers.append(ans)
            all_answers.append(ans)
            prior = len(assistants)
            print(json.dumps({"language": label, "turn": turn, "status": status, "answer": ans[:1000]}, ensure_ascii=False))

        joined = " ".join(answers[:3]).lower()
        assert any(term.lower() in joined for term in category_terms), (label, "known KB grounding absent", joined[:2000])
        print(f"TASK1_{label}_EMOTION_SMOKE=PASS")

    assert len(all_answers) == 12, len(all_answers)
    print("TASK1_NO_UNEXPECTED_HANDOFF=PASS")
    print("TASK1_NO_FABRICATED_ACTIONS=PASS")
    print("TASK1_SAME_LANGUAGE_BEHAVIOR=PASS")
    print("TASK1_KB_GROUNDING_PRESERVED=PASS")
    print("TASK1_POSITIVE_RECOVERY_NO_STALE_REPLAY=PASS")
    print("TASK1_MULTILINGUAL_EMOTION_PROD_SMOKE=PASS")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in {"patch", "smoke"}:
        raise SystemExit("usage: task1-positive-recovery-closure.py patch|smoke")
    if sys.argv[1] == "patch":
        patch_source()
    else:
        smoke()
