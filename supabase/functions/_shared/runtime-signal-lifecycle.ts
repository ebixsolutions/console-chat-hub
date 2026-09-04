export type EmotionKind =
  | "angry"
  | "frustrated"
  | "disappointed"
  | "helpless"
  | "confused"
  | "hesitant"
  | "urgent"
  | "positive"
  | "positive_recovery"
  | "high_intent";

export interface HistoricalSentimentSignal {
  sentiment_score?: number;
  sentiment_trend?: number[];
  evaluation_id?: string;
  provider_version?: string;
  emotion_kind?: EmotionKind;
  emotion_intensity?: number;
  emotion_confidence?: number;
}

export interface RealtimeSentimentSignal extends HistoricalSentimentSignal {
  anger_flag?: true;
  sentiment_recovered_same_turn?: true;
}

export interface CurrentTurnEmotion {
  emotion_kind?: EmotionKind;
  emotion_intensity?: number;
  emotion_confidence?: number;
  anger_flag?: true;
  sentiment_score?: number;
  provider_version: string;
}

const PROVIDER_VERSION = "current-turn-emotion-v2.0";

const STRONG_ANGER = /(嬲|憤怒|愤怒|火大|離譜|离谱|垃圾|廢物|废物|荒謬|荒谬|angry|furious|irate|rage|ridiculous|unacceptable|bullshit)/i;
const FRUSTRATED = /(煩死|烦死|煩透|烦透|搞咗好多次|搞了很多次|試咗好多次|试了很多次|一直都唔得|一直都不行|frustrated|annoyed|fed up with this|keeps? failing|tried .* times)/i;
const DISAPPOINTED = /(失望|很差|太差|不滿意|不满意|辜負|辜负|disappointed|let down|terrible experience|awful experience)/i;
const HELPLESS = /(無奈|无奈|冇辦法|沒辦法|没有办法|唔知可以點|不知道怎麼辦|不知道怎么办|心累|算了|放棄|放弃|helpless|exhausted|don'?t know what else to do|give up|at a loss)/i;
const CONFUSED = /(睇唔明|看不懂|唔明|不明白|搞唔清|搞不清|不清楚你(?:講|说)乜|confused|don'?t understand|doesn'?t make sense|not clear to me)/i;
const HESITANT = /(不確定|不确定|猶豫|犹豫|怕.*不適合|怕.*不适合|唔知.*適唔適合|不知道.*适不适合|unsure|hesitant|not sure|worried .*won'?t (fit|work|suit)|can'?t decide)/i;
const URGENT = /(好急|很急|非常急|趕住|赶着|今天一定|今日一定|明天就要|聽日就要|马上要|馬上要|立即要|urgent|asap|right away|today for sure|need it (today|tomorrow))/i;
const HIGH_INTENT = /(我要買|我要买|想下單|想下单|直接下單|直接下单|怎麼付款|怎么付款|如何付款|立即購買|立即购买|ready to buy|i'?ll take it|want to buy|place (the )?order|how do i pay|checkout now)/i;
const POSITIVE_RECOVERY = /(明白了|明白啦|而家明白|現在明白|现在明白|解決了|解决了|搞掂|好了現在|好了现在|got it|that helps|understand now|makes sense now|resolved now|working now)/i;
const POSITIVE = /(喜歡|喜欢|滿意|满意|開心|开心|好正|真係好|真的很好|非常好|太好了|很棒|好棒|love (it|this)|like (it|this)|great|excellent|amazing|happy|satisfied|thank you|thanks|謝謝|谢谢)/i;

// Suppress emotion inference when the message is clearly describing somebody else's
// emotion or a hypothetical/quoted example rather than the current customer's state.
const THIRD_PARTY_EMOTION = /(?:朋友|同事|另一個客人|另一个客人|客戶|客户|他|她|佢|my friend|my colleague|another customer|he|she|they).{0,24}(?:嬲|憤怒|愤怒|失望|無奈|无奈|煩|烦|angry|furious|frustrated|disappointed|helpless|confused|happy|satisfied)/i;
const HYPOTHETICAL_EMOTION = /(?:如果|假如|假設|假设|例如|譬如|假如我|如果我|suppose|hypothetically|for example|what if).{0,40}(?:嬲|憤怒|愤怒|失望|無奈|无奈|煩|烦|angry|furious|frustrated|disappointed|helpless|confused|happy|satisfied)/i;
const QUOTED_EMOTION = /(?:佢話|他說|他说|她說|她说|客人話|客人说|customer said|they said|he said|she said)[：:\s“\"]{0,4}.{0,40}(?:嬲|憤怒|愤怒|失望|無奈|无奈|煩|烦|angry|furious|frustrated|disappointed|helpless|confused|happy|satisfied)/i;

function bounded(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function result(
  emotion_kind: EmotionKind,
  sentiment_score: number,
  emotion_intensity: number,
  emotion_confidence: number,
  anger_flag = false,
): CurrentTurnEmotion {
  return {
    emotion_kind,
    sentiment_score,
    emotion_intensity: bounded(emotion_intensity),
    emotion_confidence: bounded(emotion_confidence),
    ...(anger_flag ? { anger_flag: true as const } : {}),
    provider_version: PROVIDER_VERSION,
  };
}

export function classifyCurrentTurnEmotion(text: string): CurrentTurnEmotion {
  const t = String(text ?? "").normalize("NFKC").trim();
  if (!t) return { provider_version: PROVIDER_VERSION };

  if (THIRD_PARTY_EMOTION.test(t) || HYPOTHETICAL_EMOTION.test(t) || QUOTED_EMOTION.test(t)) {
    return { provider_version: PROVIDER_VERSION };
  }

  // Priority matters: high-intent/urgency are distinct semantic states and should
  // not be collapsed into generic positive or negative sentiment.
  if (STRONG_ANGER.test(t)) return result("angry", -0.9, 0.95, 0.96, true);
  if (HELPLESS.test(t)) return result("helpless", -0.72, 0.82, 0.92);
  if (FRUSTRATED.test(t)) return result("frustrated", -0.66, 0.76, 0.91);
  if (DISAPPOINTED.test(t)) return result("disappointed", -0.6, 0.7, 0.91);
  if (CONFUSED.test(t)) return result("confused", -0.28, 0.52, 0.9);
  if (HESITANT.test(t)) return result("hesitant", -0.12, 0.42, 0.88);
  if (URGENT.test(t)) return result("urgent", -0.08, 0.75, 0.9);
  if (HIGH_INTENT.test(t)) return result("high_intent", 0.48, 0.78, 0.91);
  if (POSITIVE_RECOVERY.test(t)) return result("positive_recovery", 0.42, 0.58, 0.9);
  if (POSITIVE.test(t)) return result("positive", 0.68, 0.68, 0.91);

  return { provider_version: PROVIDER_VERSION };
}

/**
 * Legacy public function name retained because generate-reply/escalation already use it.
 * v2 expands the signal without changing the existing anger/sentiment contract.
 * Current-turn emotion always wins; historical emotion is used only for trend/recovery.
 */
export function buildRealtimeR3SentimentSignals(
  text: string,
  historical?: HistoricalSentimentSignal,
): RealtimeSentimentSignal | undefined {
  const current = classifyCurrentTurnEmotion(text);
  const currentScore = current.sentiment_score;

  // Do not leak stale historical emotion into a new/current turn that has no
  // emotion signal. This is the new-topic/stale-emotion isolation guard.
  if (currentScore === undefined && current.anger_flag !== true && !current.emotion_kind) return undefined;

  const base = Array.isArray(historical?.sentiment_trend)
    ? historical.sentiment_trend.filter(Number.isFinite).slice(-4)
    : (typeof historical?.sentiment_score === "number" && Number.isFinite(historical.sentiment_score)
      ? [historical.sentiment_score]
      : []);
  const trend = currentScore === undefined ? base : [...base, currentScore].slice(-5);
  const previous = base.length ? base[base.length - 1] : undefined;
  const recovered =
    typeof previous === "number" && previous < -0.2 &&
    typeof currentScore === "number" && currentScore >= 0.2;

  return {
    ...(current.anger_flag ? { anger_flag: true as const } : {}),
    ...(current.emotion_kind ? { emotion_kind: current.emotion_kind } : {}),
    ...(typeof current.emotion_intensity === "number" ? { emotion_intensity: current.emotion_intensity } : {}),
    ...(typeof current.emotion_confidence === "number" ? { emotion_confidence: current.emotion_confidence } : {}),
    ...(typeof currentScore === "number" ? { sentiment_score: currentScore } : {}),
    ...(trend.length >= 2 ? { sentiment_trend: trend } : {}),
    ...(recovered ? { sentiment_recovered_same_turn: true as const } : {}),
    ...(historical?.evaluation_id ? { evaluation_id: historical.evaluation_id } : {}),
    provider_version: [current.provider_version, historical?.provider_version].filter(Boolean).join("+"),
  };
}
