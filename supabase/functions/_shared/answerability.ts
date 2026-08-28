/**
 * Task 3.3 — Answerability assessment, decoupled from retrieval score.
 *
 * A high retrieval score alone NEVER makes a question answerable, and a low
 * score alone never forces a human handoff. Answerability is decided by whether
 * confirmed content actually covers what was asked.
 *
 * Pure module: no IO, no env, no DB.
 */

export interface AnswerabilityEvidence {
  /** Confirmed content text (full content only; summaries are not sufficient). */
  content: string;
  score?: number;
}

export interface AnswerabilityInput {
  question: string;
  evidence: AnswerabilityEvidence[];
  /** Optional top retrieval score, recorded for observability only. */
  top_score?: number;
}

export type AnswerabilityReason =
  | "answerable_from_confirmed_content"
  | "no_confirmed_content"
  | "content_too_thin"
  | "topic_not_covered"
  | "exact_fact_not_present"
  | "question_underspecified";


export interface AnswerabilityResult {
  answerable: boolean;
  reason: AnswerabilityReason;
  /** true when the safe next step is ONE natural clarification question. */
  should_clarify: boolean;
  usable_evidence_count: number;
  /** Recorded for traces only; never used as the acceptance decision. */
  top_score: number | null;
}

const MIN_USABLE_CONTENT_CHARS = 80;

const EXACT_FACT_MARKERS = [
  "幾錢",
  "几钱",
  "價錢",
  "价钱",
  "價格",
  "价格",
  "多少",
  "幾日",
  "几日",
  "幾天",
  "几天",
  "期限",
  "時限",
  "时限",
  "幾點",
  "几点",
  "百分",
  "%",
  "how much",
  "how many",
  "how long",
  "price",
  "cost",
  "fee",
  "deadline",
  "within",
  "percent",
];

const NUMBER_PATTERN = /[0-9]|[一二三四五六七八九十百千萬万]/;

const QUESTION_STOPWORDS = new Set([
  "what", "when", "where", "which", "whose", "does", "do", "did", "is", "are",
  "was", "were", "the", "a", "an", "for", "with", "your", "you", "my", "me",
  "about", "and", "or", "to", "of", "in", "on", "at", "how", "much", "many",
  "long", "can", "could", "would", "should", "please", "there", "this", "that",
  "any", "have", "has", "had", "get", "got", "tell",
]);

/** Latin content words plus CJK bigrams that carry the question's topic. */
function questionTopicTerms(question: string): string[] {
  const raw = normalize(question).toLowerCase();
  const terms = new Set<string>();

  for (const word of raw.split(/[^a-z0-9]+/)) {
    if (word.length >= 3 && !QUESTION_STOPWORDS.has(word)) terms.add(word);
  }

  const cjk = raw.replace(/[^\u4e00-\u9fff]/g, "");
  for (let i = 0; i + 1 < cjk.length; i += 1) terms.add(cjk.slice(i, i + 2));

  return Array.from(terms);
}

function normalize(text: string): string {
  return (text ?? "").normalize("NFKC").trim();
}

function hasMarker(text: string, markers: string[]): boolean {
  const raw = normalize(text);
  const lower = raw.toLowerCase();
  return markers.some((m) => (/[a-z%]/.test(m) ? lower.includes(m) : raw.includes(m)));
}

/**
 * Topical coverage: a high retrieval score on off-topic content must never
 * authorise an answer, so the confirmed content has to actually mention what
 * the question is about.
 */
function coversQuestionTopic(question: string, contents: string[]): boolean {
  const terms = questionTopicTerms(question);
  if (terms.length === 0) return true;
  const haystack = contents.map((c) => normalize(c).toLowerCase()).join("\n");
  const hits = terms.filter((t) => haystack.includes(t));
  const required = terms.length <= 2 ? 1 : 2;
  return hits.length >= required && hits.length / terms.length >= 0.25;
}


/**
 * Decide whether the question can be answered from confirmed content.
 * `questionUnderspecified` comes from the conversational router so an incomplete
 * question is clarified rather than escalated.
 */
export function assessAnswerability(
  input: AnswerabilityInput,
  questionUnderspecified = false,
): AnswerabilityResult {
  const topScore =
    typeof input.top_score === "number" && Number.isFinite(input.top_score)
      ? input.top_score
      : null;

  const usable = (input.evidence ?? []).filter(
    (e) => normalize(e.content).length >= MIN_USABLE_CONTENT_CHARS,
  );

  if (questionUnderspecified) {
    return {
      answerable: false,
      reason: "question_underspecified",
      should_clarify: true,
      usable_evidence_count: usable.length,
      top_score: topScore,
    };
  }

  if ((input.evidence ?? []).length === 0) {
    return {
      answerable: false,
      reason: "no_confirmed_content",
      should_clarify: true,
      usable_evidence_count: 0,
      top_score: topScore,
    };
  }

  if (usable.length === 0) {
    return {
      answerable: false,
      reason: "content_too_thin",
      should_clarify: true,
      usable_evidence_count: 0,
      top_score: topScore,
    };
  }

  if (!coversQuestionTopic(input.question, usable.map((e) => e.content))) {
    return {
      answerable: false,
      reason: "topic_not_covered",
      should_clarify: true,
      usable_evidence_count: usable.length,
      top_score: topScore,
    };
  }

  if (hasMarker(input.question, EXACT_FACT_MARKERS)) {
    const hasNumeric = usable.some((e) => NUMBER_PATTERN.test(normalize(e.content)));
    if (!hasNumeric) {
      return {
        answerable: false,
        reason: "exact_fact_not_present",
        should_clarify: true,
        usable_evidence_count: usable.length,
        top_score: topScore,
      };
    }
  }

  return {
    answerable: true,
    reason: "answerable_from_confirmed_content",
    should_clarify: false,
    usable_evidence_count: usable.length,
    top_score: topScore,
  };
}
