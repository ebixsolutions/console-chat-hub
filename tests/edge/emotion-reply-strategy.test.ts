import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildEmotionReplyStrategyContext, resolvePositiveRecoveryAcknowledgement } from "../../supabase/functions/_shared/emotion-reply-strategy.ts";

Deno.test("all governed emotion kinds produce distinct human-like strategy guidance", () => {
  const kinds = [
    "angry","frustrated","disappointed","helpless","confused","hesitant","urgent","positive","positive_recovery","high_intent",
  ] as const;
  const outputs = kinds.map((emotion_kind) => buildEmotionReplyStrategyContext({ emotion_kind }));
  for (let i = 0; i < outputs.length; i++) {
    assertStringIncludes(outputs[i], `Current customer state: ${kinds[i]}.`);
    assertStringIncludes(outputs[i], "Preserve all authoritative/grounded facts exactly");
    assertStringIncludes(outputs[i], "Emotion alone never authorizes");
  }
  assertEquals(new Set(outputs).size, kinds.length);
});

Deno.test("strategy semantics match customer-service contract", () => {
  assertStringIncludes(buildEmotionReplyStrategyContext({ emotion_kind: "angry" }), "calm and non-defensive");
  assertStringIncludes(buildEmotionReplyStrategyContext({ emotion_kind: "frustrated" }), "already spent effort");
  assertStringIncludes(buildEmotionReplyStrategyContext({ emotion_kind: "disappointed" }), "gap between what the customer expected");
  assertStringIncludes(buildEmotionReplyStrategyContext({ emotion_kind: "helpless" }), "Reduce customer effort");
  assertStringIncludes(buildEmotionReplyStrategyContext({ emotion_kind: "confused" }), "Simplify the answer");
  assertStringIncludes(buildEmotionReplyStrategyContext({ emotion_kind: "hesitant" }), "low-pressure");
  assertStringIncludes(buildEmotionReplyStrategyContext({ emotion_kind: "urgent" }), "never invent an SLA");
  assertStringIncludes(buildEmotionReplyStrategyContext({ emotion_kind: "positive" }), "positive reaction naturally");
  assertStringIncludes(buildEmotionReplyStrategyContext({ emotion_kind: "positive_recovery" }), "return to a normal friendly tone");
  assertStringIncludes(buildEmotionReplyStrategyContext({ emotion_kind: "high_intent" }), "purchase readiness");
});

Deno.test("no emotion signal creates no prompt pollution", () => {
  assertEquals(buildEmotionReplyStrategyContext({}), "");
});

Deno.test("recovery guard explicitly prevents stale negative tone", () => {
  const output = buildEmotionReplyStrategyContext({ emotion_kind: "positive", sentiment_recovered_same_turn: true });
  assertStringIncludes(output, "avoid carrying stale negative tone forward");
});

Deno.test("pure positive-recovery acknowledgements are deterministic in all supported languages", () => {
  assertEquals(
    resolvePositiveRecoveryAcknowledgement("明白了，這樣清楚多了，謝謝。", "zh-TW"),
    "不用客氣，很高興這次說清楚了。如果還有其他問題，直接告訴我就可以。",
  );
  assertEquals(
    resolvePositiveRecoveryAcknowledgement("明白了，这样清楚多了，谢谢。", "zh-CN"),
    "不客气，很高兴这次说明白了。如果还有其他问题，直接告诉我就可以。",
  );
  assertEquals(
    resolvePositiveRecoveryAcknowledgement("That makes sense now, thank you.", "en"),
    "You're welcome. I'm glad that makes sense now. If you have another question, just let me know.",
  );
});

Deno.test("positive-recovery shortcut rejects questions and mixed factual requests", () => {
  assertEquals(resolvePositiveRecoveryAcknowledgement("明白了，退款政策是什麼？", "zh-TW"), null);
  assertEquals(resolvePositiveRecoveryAcknowledgement("明白了，但請幫我查訂單", "zh-TW"), null);
  assertEquals(resolvePositiveRecoveryAcknowledgement("That makes sense now. What is the refund policy?", "en"), null);
  assertEquals(resolvePositiveRecoveryAcknowledgement("Thanks, please cancel my order", "en"), null);
});
