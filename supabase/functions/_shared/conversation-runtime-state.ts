export type RuntimeHistoryRow = { role?: string; content?: string | null; created_at?: string | null; metadata?: unknown };
export type RuntimeLanguage = "zh-TW" | "zh-CN" | "en";
export interface ConversationRuntimeState {
  first_customer_turn: string | null;
  first_intent: string | null;
  latest_customer_turn: string | null;
  current_intent: string | null;
  current_topic: string | null;
  prior_topics: string[];
  active_referents: string[];
  unresolved_questions: string[];
  latest_corrections: string[];
  active_constraints: string[];
  jurisdiction: string | null;
  language: RuntimeLanguage;
  prior_recommendations: string[];
}
export interface CanonicalRetrievalQuery {
  query: string;
  mode: "standalone" | "contextual" | "memory";
  latest: string;
  context_turns: string[];
  state: ConversationRuntimeState;
}

const CUSTOMER = new Set(["visitor", "customer", "user"]);
const ASSISTANT = new Set(["assistant", "ai", "human_agent"]);
const CORRECTION = /(我講錯|我说错|我說錯|更正|其實係|其实是|唔係.*係|不是.*是|改返|改成|actually|i meant|correction|not .* but )/i;
const CONSTRAINT = /(不要|唔好|不准|唔准|不要猜|唔好估|沒有型號|没有型号|冇型號|only|don't|do not|without|must not|no model)/i;
const FOLLOW = /^(?:咁|那|那麼|那么|所以|另外|仲有|还有|如果|再|又|而|同埋|what about|and what about|then|so|also|in that case|how about)/i;
const PRONOUN = /(這個|这个|那個|那个|它|其|上述|剛才|刚才|之前|頭先|头先|same|that|this|it|its|earlier|previous)/i;
const MEMORY = /(一開始|一开始|第一個問題|第一个问题|最初|剛才建議|刚才建议|之前建議|之前建议|first question|first thing|what did i ask|what did you suggest|earlier recommendation)/i;
const QUESTION = /[?？]|^(?:什麼|什么|如何|怎樣|怎样|哪|哪些|多久|幾耐|几耐|why|what|which|how|when|where)/i;
const RECOMMEND = /(建議|建议|需要我提供|請提供|请提供|可以提供|recommend|suggest|provide)/i;
const JURISDICTIONS: Array<[string, RegExp]> = [
  ["mars", /(mars|火星)/i],
  ["hong_kong", /(香港|hong\s*kong|\bhk\b)/i],
  ["macau", /(澳門|澳门|macau|macao)/i],
  ["singapore", /(新加坡|singapore)/i],
  ["taiwan", /(台灣|台湾|taiwan)/i],
  ["mainland_china", /(中國大陸|中国大陆|內地|内地|mainland\s*china)/i],
];

function clean(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 800) : "";
}
function detectLanguage(text: string): RuntimeLanguage {
  if (!/[\u4e00-\u9fff]/.test(text)) return "en";
  return /[转们为这没请台]/.test(text) ? "zh-CN" : "zh-TW";
}
export function detectExplicitJurisdiction(text: string): string | null {
  for (const [id, re] of JURISDICTIONS) if (re.test(text)) return id;
  return null;
}
function normalizeTopic(text: string): string {
  return clean(text)
    .replace(/[?？!！。,.，]/g, " ")
    .replace(/^(?:咁|那|所以|另外|再|又|what about|then|so)\s*/i, "")
    .trim()
    .slice(0, 180);
}

export function projectConversationRuntimeState(newestFirst: RuntimeHistoryRow[]): ConversationRuntimeState {
  const rows = newestFirst
    .map((row) => ({
      text: clean(row.content),
      role: String(row.role ?? "").toLowerCase(),
    }))
    .filter((row) => row.text && row.text !== "__THINKING__");
  const customers = rows.filter((row) => CUSTOMER.has(row.role));
  const assistants = rows.filter((row) => ASSISTANT.has(row.role));
  const chronological = [...customers].reverse();
  const latest = customers[0]?.text ?? null;
  const first = chronological[0]?.text ?? null;
  const corrections = customers.filter((row) => CORRECTION.test(row.text)).slice(0, 6).map((row) => row.text);
  const constraints = customers.filter((row) => CONSTRAINT.test(row.text)).slice(0, 8).map((row) => row.text);
  const unresolved = customers.filter((row) => QUESTION.test(row.text)).slice(0, 8).map((row) => row.text);
  const explicitJurisdiction = latest ? detectExplicitJurisdiction(latest) : null;
  const inheritedJurisdiction = customers.map((row) => detectExplicitJurisdiction(row.text)).find(Boolean) ?? null;
  const topics: string[] = [];
  for (const row of chronological) {
    const topic = normalizeTopic(row.text);
    if (topic && !topics.includes(topic)) topics.push(topic);
  }
  const currentTopic = latest ? normalizeTopic(latest) : null;
  const refs = latest
    ? [...latest.matchAll(/(這個|这个|那個|那个|它|其|上述|剛才|刚才|之前|same|that|this|it|its)/gi)].map((m) => m[0]).slice(0, 6)
    : [];
  return {
    first_customer_turn: first,
    first_intent: first ? normalizeTopic(first) : null,
    latest_customer_turn: latest,
    current_intent: latest,
    current_topic: currentTopic,
    prior_topics: topics.slice(0, -1).slice(-12),
    active_referents: refs,
    unresolved_questions: unresolved,
    latest_corrections: corrections,
    active_constraints: constraints,
    jurisdiction: explicitJurisdiction ?? inheritedJurisdiction,
    language: detectLanguage(latest ?? first ?? ""),
    prior_recommendations: assistants.filter((row) => RECOMMEND.test(row.text)).slice(0, 6).map((row) => row.text),
  };
}

export function buildCanonicalContinuityBlock(newestFirst: RuntimeHistoryRow[]): string {
  const state = projectConversationRuntimeState(newestFirst);
  if (!state.latest_customer_turn) return "";
  const lines = [
    "Canonical conversation state (internal; never quote this block):",
    `First customer turn: ${state.first_customer_turn ?? "—"}`,
    `Current customer turn: ${state.latest_customer_turn}`,
    `Current topic: ${state.current_topic ?? "—"}`,
    `Jurisdiction: ${state.jurisdiction ?? "unspecified"}`,
  ];
  if (state.latest_corrections.length) {
    lines.push("Newest corrections / superseding facts:");
    state.latest_corrections.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  if (state.active_constraints.length) {
    lines.push("Active customer constraints:");
    state.active_constraints.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  if (state.unresolved_questions.length) {
    lines.push("Recent unresolved customer questions:");
    state.unresolved_questions.slice(0, 5).forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  if (state.prior_recommendations.length) {
    lines.push("Recent assistant recommendations (context only, not customer facts):");
    state.prior_recommendations.slice(0, 3).forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  return lines.join("\n").slice(0, 6000);
}

export function buildCanonicalRetrievalQuery(
  latestInput: string,
  newestFirst: RuntimeHistoryRow[],
): CanonicalRetrievalQuery {
  const latest = clean(latestInput);
  const state = projectConversationRuntimeState(newestFirst);
  if (!latest) return { query: "", mode: "standalone", latest: "", context_turns: [], state };

  if (MEMORY.test(latest)) {
    const parts = [`Conversation-memory request: ${latest}`];
    if (state.first_customer_turn) parts.push(`First customer turn: ${state.first_customer_turn}`);
    if (state.prior_recommendations.length) {
      parts.push(`Relevant prior recommendations: ${state.prior_recommendations.join(" / ")}`);
    }
    return { query: parts.join("\n").slice(0, 1200), mode: "memory", latest, context_turns: [], state };
  }

  const explicitJurisdiction = detectExplicitJurisdiction(latest);
  const previous = newestFirst
    .filter((row) => CUSTOMER.has(String(row.role ?? "").toLowerCase()))
    .map((row) => clean(row.content))
    .filter((x) => x && x !== latest && x !== "__THINKING__");
  const needsContext =
    FOLLOW.test(latest) ||
    PRONOUN.test(latest) ||
    (latest.length <= 28 && QUESTION.test(latest)) ||
    CORRECTION.test(latest);

  // An explicit jurisdiction is a hard topic boundary. Do not contaminate it
  // with prior-jurisdiction context; applicability is enforced downstream.
  if (!needsContext || explicitJurisdiction) {
    return {
      query: latest,
      mode: "standalone",
      latest,
      context_turns: [],
      state: { ...state, jurisdiction: explicitJurisdiction ?? state.jurisdiction },
    };
  }

  const contextTurns = previous.filter((x) => !MEMORY.test(x)).slice(0, 5);
  if (!contextTurns.length) return { query: latest, mode: "standalone", latest, context_turns: [], state };
  return {
    query: [
      `Current request: ${latest}`,
      `Relevant prior customer context: ${contextTurns.join(" / ")}`,
    ].join("\n").slice(0, 1200),
    mode: "contextual",
    latest,
    context_turns: contextTurns,
    state,
  };
}

export function buildCanonicalAssistRetrievalQuery(
  assistanceInput: string,
  newestFirst: RuntimeHistoryRow[],
): CanonicalRetrievalQuery {
  const latest = clean(assistanceInput);
  const state = projectConversationRuntimeState(newestFirst);
  const customerTurns = newestFirst
    .filter((row) => CUSTOMER.has(String(row.role ?? "").toLowerCase()))
    .map((row) => clean(row.content))
    .filter(Boolean)
    .slice(0, 12);
  const chronological = [...customerTurns].reverse();
  return {
    query: [
      `Assistance input: ${latest}`,
      `Canonical customer context: ${chronological.join(" / ")}`,
      `Jurisdiction: ${state.jurisdiction ?? "unspecified"}`,
    ].join("\n").slice(0, 1600),
    mode: "contextual",
    latest,
    context_turns: customerTurns,
    state,
  };
}
