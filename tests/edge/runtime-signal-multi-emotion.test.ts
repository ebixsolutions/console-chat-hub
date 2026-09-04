import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRealtimeR3SentimentSignals,
  classifyCurrentTurnEmotion,
  type EmotionKind,
} from "../../supabase/functions/_shared/runtime-signal-lifecycle.ts";

function expectEmotion(text: string, kind: EmotionKind) {
  const actual = classifyCurrentTurnEmotion(text);
  assertEquals(actual.emotion_kind, kind, text);
  assert(typeof actual.emotion_confidence === "number" && actual.emotion_confidence >= 0.8, text);
}

Deno.test("Task 6.1 multi-emotion zh-TW semantic coverage", () => {
  expectEmotion("你哋服務真係太離譜，我好嬲！", "angry");
  expectEmotion("我已經試咗好多次，一直都唔得，真係好煩。", "frustrated");
  expectEmotion("我對今次服務真的很失望。", "disappointed");
  expectEmotion("搞了三次還是不行，我真的很無奈。", "helpless");
  expectEmotion("我完全看不懂你剛才說什麼。", "confused");
  expectEmotion("我不確定這款適不適合我。", "hesitant");
  expectEmotion("我很急，明天就要用。", "urgent");
  expectEmotion("這款我很喜歡，真的很好。", "positive");
  expectEmotion("好了，現在明白了。", "positive_recovery");
  expectEmotion("這款我要買，怎麼付款？", "high_intent");
});

Deno.test("Task 6.1 multi-emotion zh-CN semantic coverage", () => {
  expectEmotion("这个服务太离谱了，我很愤怒。", "angry");
  expectEmotion("我已经试了很多次，一直都不行，太烦了。", "frustrated");
  expectEmotion("这次体验让我很失望。", "disappointed");
  expectEmotion("我真的很无奈，不知道怎么办。", "helpless");
  expectEmotion("我完全看不懂刚才的说明。", "confused");
  expectEmotion("我不确定这款适不适合我。", "hesitant");
  expectEmotion("非常急，明天就要用。", "urgent");
  expectEmotion("这款我很喜欢，我很满意。", "positive");
  expectEmotion("好了，现在明白了。", "positive_recovery");
  expectEmotion("我要买这款，怎么付款？", "high_intent");
});

Deno.test("Task 6.1 multi-emotion English semantic coverage", () => {
  expectEmotion("This is ridiculous. I am furious.", "angry");
  expectEmotion("I am frustrated; I tried this five times already.", "frustrated");
  expectEmotion("I am really disappointed with this service.", "disappointed");
  expectEmotion("I feel helpless and don't know what else to do.", "helpless");
  expectEmotion("I'm confused. This doesn't make sense.", "confused");
  expectEmotion("I'm not sure this will suit me.", "hesitant");
  expectEmotion("This is urgent, I need it tomorrow.", "urgent");
  expectEmotion("I love this product. It's great.", "positive");
  expectEmotion("Got it, that makes sense now.", "positive_recovery");
  expectEmotion("I'm ready to buy. How do I pay?", "high_intent");
});

Deno.test("Task 6.1 current turn overrides historical emotion and supports recovery", () => {
  const recovered = buildRealtimeR3SentimentSignals("好了，現在明白了，謝謝。", {
    sentiment_score: -0.85,
    sentiment_trend: [-0.85],
    emotion_kind: "angry",
    provider_version: "historical-test",
  });
  assert(recovered);
  assertEquals(recovered.emotion_kind, "positive_recovery");
  assertEquals(recovered.sentiment_recovered_same_turn, true);
  assertEquals(recovered.anger_flag, undefined);
  assertEquals(recovered.sentiment_trend, [-0.85, 0.42]);

  const newTopic = buildRealtimeR3SentimentSignals("我想問一下保養期有多久？", {
    sentiment_score: -0.85,
    sentiment_trend: [-0.85],
    emotion_kind: "angry",
  });
  assertEquals(newTopic, undefined);
});

Deno.test("Task 6.1 false-positive guardrails for third-party, hypothetical and quoted emotion", () => {
  const values = [
    "我朋友很憤怒，但我只是替他問保養期。",
    "如果我很生氣的話，你會怎樣處理？",
    "客人話：『我很失望。』我想知道應該怎樣回覆。",
    "My friend is furious, but I am only asking about the warranty for them.",
    "Hypothetically, if I were angry, would you transfer me?",
    "The customer said: I am disappointed. What should I reply?",
  ];
  for (const value of values) {
    const actual = classifyCurrentTurnEmotion(value);
    assertEquals(actual.emotion_kind, undefined, value);
    assertEquals(actual.sentiment_score, undefined, value);
  }
});

Deno.test("Task 6.1 emotion dimensions stay bounded and backward-compatible anger flag remains", () => {
  const angry = buildRealtimeR3SentimentSignals("我很憤怒，這真的不可接受。", {
    sentiment_score: -0.3,
  });
  assert(angry);
  assertEquals(angry.emotion_kind, "angry");
  assertEquals(angry.anger_flag, true);
  assert(typeof angry.emotion_intensity === "number" && angry.emotion_intensity >= 0 && angry.emotion_intensity <= 1);
  assert(typeof angry.emotion_confidence === "number" && angry.emotion_confidence >= 0 && angry.emotion_confidence <= 1);
});
