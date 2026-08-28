/**
 * Task 3.3 — Conversation continuity signals.
 *
 * Deterministic, bounded, non-LLM derivation of within-conversation memory so the
 * assistant honours the customer's latest correction, resolves follow-up
 * references, and never re-asks something already answered.
 *
 * Pure module: no IO, no env, no DB.
 */

export interface ContinuityTurn {
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
}

export interface ContinuitySignals {
  /** Latest visitor turn that corrects/overrides an earlier statement. */
  latest_correction: string | null;
  /** Latest visitor turn is a follow-up referring to the previous topic. */
  follow_up_reference: boolean;
  /** Details the customer already supplied (do not re-ask). */
  already_provided_details: string[];
  /** Number of clarifications already asked for the CURRENT intent. */
  clarification_attempts_for_current_intent: number;
}

const CORRECTION_MARKERS = [
  "唔係",
  "不是",
  "不對",
  "不对",
  "更正",
  "改為",
  "改为",
  "應該係",
  "应该是",
  "我意思係",
  "我意思是",
  "講錯",
  "讲错",
  "打錯",
  "打错",
  "actually",
  "correction",
  "i meant",
  "sorry, i mean",
  "not that",
];

const FOLLOW_UP_MARKERS = [
  "咁",
  "那",
  "那個",
  "那个",
  "嗰個",
  "嗰样",
  "嗰樣",
  "同一個",
  "同一个",
  "剛才那個",
  "刚才那个",
  "仲有",
  "还有",
  "另外",
  "that one",
  "the same one",
  "and also",
  "what about",
  "then what",
];

const DETAIL_PATTERNS: Array<{ key: string; re: RegExp }> = [
  { key: "order_number", re: /\b[A-Z]{2,}[- ]?\d{3,}\b|\b\d{6,}\b/ },
  { key: "email", re: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { key: "phone", re: /\b(?:\+?\d[\d\s-]{6,})\b/ },
  { key: "date", re: /\d{1,4}[-/年]\d{1,2}[-/月]?\d{0,2}/ },
  { key: "amount", re: /(?:\$|HK\$|USD|港幣|港币)\s?\d+/i },
];

function normalize(text: string): string {
  return (text ?? "").normalize("NFKC").trim();
}

function hasMarker(text: string, markers: string[]): boolean {
  const raw = normalize(text);
  const lower = raw.toLowerCase();
  return markers.some((m) => (/[a-z]/.test(m) ? lower.includes(m) : raw.includes(m)));
}

/**
 * @param history chronological turns, oldest first. Bounded by the caller.
 */
export function deriveContinuitySignals(history: ContinuityTurn[]): ContinuitySignals {
  const turns = (history ?? []).slice(-20);
  const visitorTurns = turns.filter((t) => t.role === "visitor" || t.role === "user");
  const latest = visitorTurns.length > 0 ? visitorTurns[visitorTurns.length - 1] : null;

  const details = new Set<string>();
  for (const turn of visitorTurns) {
    const raw = normalize(turn.content);
    for (const pattern of DETAIL_PATTERNS) {
      if (pattern.re.test(raw)) details.add(pattern.key);
    }
  }

  let clarifications = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.role === "visitor" || turn.role === "user") {
      if (i < turns.length - 1) break;
      continue;
    }
    const metadata = (turn.metadata ?? {}) as Record<string, unknown>;
    if (metadata["escalation_action"] === "clarification") clarifications += 1;
  }

  return {
    latest_correction:
      latest && hasMarker(latest.content, CORRECTION_MARKERS) ? normalize(latest.content) : null,
    follow_up_reference: Boolean(
      latest && visitorTurns.length > 1 && hasMarker(latest.content, FOLLOW_UP_MARKERS),
    ),
    already_provided_details: Array.from(details),
    clarification_attempts_for_current_intent: clarifications,
  };
}

/** Compact, customer-safe continuity brief injected into the generation prompt. */
export function buildContinuityBrief(signals: ContinuitySignals): string {
  const lines: string[] = [];
  if (signals.latest_correction) {
    lines.push(`Customer's latest correction (authoritative): ${signals.latest_correction}`);
  }
  if (signals.follow_up_reference) {
    lines.push("The newest message is a follow-up about the topic already under discussion.");
  }
  if (signals.already_provided_details.length > 0) {
    lines.push(
      `Already provided by the customer — never ask again: ${signals.already_provided_details.join(", ")}`,
    );
  }
  return lines.length > 0 ? `Conversation continuity:\n${lines.join("\n")}` : "";
}
