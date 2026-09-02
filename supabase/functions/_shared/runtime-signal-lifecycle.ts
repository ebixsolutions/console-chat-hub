export interface HistoricalSentimentSignal {
  sentiment_score?: number;
  sentiment_trend?: number[];
  evaluation_id?: string;
  provider_version?: string;
}
export interface RealtimeSentimentSignal extends HistoricalSentimentSignal {
  anger_flag?: true;
  sentiment_recovered_same_turn?: true;
}

const STRONG_ANGER = /(嬲|生氣|生气|好嬲|很氣|很气|憤怒|愤怒|火大|離譜|离谱|垃圾|廢物|废物|荒謬|荒谬|angry|furious|irate|rage|ridiculous|unacceptable|bullshit)/i;
const NEGATIVE = /(失望|不滿|不满|很差|太差|煩|烦|frustrated|annoyed|upset|disappointed|terrible|awful)/i;
const POSITIVE_RECOVERY = /(明白了|明白啦|好的現在|好的现在|而家明白|现在明白|謝謝|谢谢|thanks|thank you|got it|that helps|understand now)/i;

export function classifyCurrentTurnEmotion(text: string): { anger_flag?: true; sentiment_score?: number; provider_version: string } {
  const t = String(text ?? '').normalize('NFKC').trim();
  if (!t) return { provider_version: 'current-turn-emotion-v1.0' };
  if (STRONG_ANGER.test(t)) return { anger_flag: true, sentiment_score: -0.85, provider_version: 'current-turn-emotion-v1.0' };
  if (NEGATIVE.test(t)) return { sentiment_score: -0.5, provider_version: 'current-turn-emotion-v1.0' };
  if (POSITIVE_RECOVERY.test(t)) return { sentiment_score: 0.35, provider_version: 'current-turn-emotion-v1.0' };
  return { provider_version: 'current-turn-emotion-v1.0' };
}

export function buildRealtimeR3SentimentSignals(text: string, historical?: HistoricalSentimentSignal): RealtimeSentimentSignal | undefined {
  const current = classifyCurrentTurnEmotion(text);
  const currentScore = current.sentiment_score;
  if (currentScore === undefined && current.anger_flag !== true) return undefined;

  const base = Array.isArray(historical?.sentiment_trend)
    ? historical!.sentiment_trend!.filter(Number.isFinite).slice(-4)
    : (typeof historical?.sentiment_score === 'number' && Number.isFinite(historical.sentiment_score) ? [historical.sentiment_score] : []);
  const trend = currentScore === undefined ? base : [...base, currentScore].slice(-5);
  const previous = base.length ? base[base.length - 1] : undefined;
  const recovered = typeof previous === 'number' && previous < -0.2 && typeof currentScore === 'number' && currentScore >= 0.2;

  return {
    ...(current.anger_flag ? { anger_flag: true as const } : {}),
    ...(typeof currentScore === 'number' ? { sentiment_score: currentScore } : {}),
    ...(trend.length >= 2 ? { sentiment_trend: trend } : {}),
    ...(recovered ? { sentiment_recovered_same_turn: true as const } : {}),
    ...(historical?.evaluation_id ? { evaluation_id: historical.evaluation_id } : {}),
    provider_version: [current.provider_version, historical?.provider_version].filter(Boolean).join('+'),
  };
}
