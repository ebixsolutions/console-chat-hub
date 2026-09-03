import { classifyCanonicalConversationTurn, type ConversationOperation, type EvidenceAuthority } from "./conversation-semantic-contract.ts";

export type RuntimeHistoryRow = { role?: string; content?: string | null; created_at?: string | null; metadata?: unknown };
export type RuntimeLanguage = "zh-TW" | "zh-CN" | "en";
export interface ConversationRuntimeState {
  first_customer_turn: string | null;
  first_intent: string | null;
  latest_customer_turn: string | null;
  current_intent: string | null;
  current_operation: ConversationOperation;
  evidence_authority: EvidenceAuthority;
  prior_grounded_document_id: string | null;
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
const EXPLICIT_CORRECTION = /(我講錯|我说错|我說錯|我要更正|我想更正|更正一下[：:]?|更正[：:]|其實係|其实是|改返|改成|actually[,\s]+i meant|i meant|correction\s*[:：])/i;
const CONTRAST_CORRECTION = /(唔係[^，。,.!?！？]{1,80}[，,]\s*係|不是[^，。,.!?！？]{1,80}[，,]\s*(?:而)?是|not .+ but .+)/i;
function isCorrectionText(text: string): boolean {
  if (EXPLICIT_CORRECTION.test(text)) return true;
  if (/[?？]/.test(text)) return false;
  return CONTRAST_CORRECTION.test(text);
}
const CONSTRAINT = /(不要|唔好|不准|唔准|不要猜|唔好估|沒有型號|没有型号|冇型號|only|don't|do not|without|must not|no model)/i;
const FOLLOW = /^(?:咁|那|那麼|那么|所以|另外|仲有|还有|如果|再|又|而|同埋|what about|and what about|then|so|also|in that case|how about)/i;
const PRONOUN = /(這個|这个|那個|那个|它|其|上述|剛才|刚才|之前|頭先|头先|same|that|this|it|its|earlier|previous)/i;
const MEMORY = /(一開始|一开始|第一個問題|第一个问题|最初|剛才建議|刚才建议|之前建議|之前建议|剛才談過|刚才谈过|談過的內容|谈过的内容|總結我們|总结我们|first question|first thing|what did i ask|what did you suggest|earlier recommendation|what information have i already given|what have i already given|what is still missing|我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\x27s| is)?\s+(?:the\s+)?(?:current\s+)?(?:region|jurisdiction).*(?:item|product)|summari[sz]e.*(?:conversation|discussed|talked))/i;
const QUESTION = /[?？]|^(?:什麼|什么|如何|怎樣|怎样|哪|哪些|多久|幾耐|几耐|why|what|which|how|when|where)/i;
const RECOMMEND = /(建議|建议|需要我提供|請提供|请提供|可以提供|我需要知道|需要知道|仍然需要|還需要|还需要|需要以下資料|需要以下资料|recommend|suggest|provide|i need to know|we still need|still need|information.*missing)/i;
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
function jurisdictionOccurrenceIsNegated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 30), index);
  return /(?:不談|不谈|別談|别谈|不要談|不要谈|唔講|唔好講)\s*$/i.test(before) ||
    /(?:forget|ignore|drop)(?:\s+about)?\s*$/i.test(before) ||
    /not\s+(?:talk|discuss)(?:\s+about)?\s*$/i.test(before);
}

export function detectExplicitJurisdiction(text: string): string | null {
  const t = clean(text);
  const candidates: Array<{ id: string; index: number }> = [];
  for (const [id, re] of JURISDICTIONS) {
    const match = t.match(re);
    if (!match || typeof match.index !== "number") continue;
    if (!jurisdictionOccurrenceIsNegated(t, match.index)) {
      candidates.push({ id, index: match.index });
    }
  }
  candidates.sort((x, y) => y.index - x.index);
  return candidates[0]?.id ?? null;
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
  const semantic = latest ? classifyCanonicalConversationTurn(latest, newestFirst) : null;
  const corrections = customers.filter((row) => isCorrectionText(row.text)).slice(0, 6).map((row) => row.text);
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
    current_operation: semantic?.operation ?? "TRIVIAL",
    evidence_authority: semantic?.evidence_authority ?? "NONE",
    prior_grounded_document_id: semantic?.prior_grounded_answer?.document_id ?? null,
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
    `Current operation: ${state.current_operation}`,
    `Evidence authority: ${state.evidence_authority}`,
    `Prior grounded document: ${state.prior_grounded_document_id ?? "—"}`,
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

export function resolveConversationMemoryResponse(
  latestInput: string,
  newestFirst: RuntimeHistoryRow[],
): string | null {
  const latest = clean(latestInput);
  if (!latest) return null;
  if (/(請記住|请记住|please\s+remember|remember\s+that)/i.test(latest)) return null;

  // Memory answers are derived from PRIOR turns only. The current
  // recall request must never become its own correction/constraint/name.
  let currentRemoved = false;
  const priorRows = newestFirst.filter((row) => {
    const role = String(row.role ?? "").toLowerCase();
    const text = clean(row.content);
    if (!currentRemoved && CUSTOMER.has(role) && text === latest) {
      currentRemoved = true;
      return false;
    }
    return true;
  });
  const state = projectConversationRuntimeState(priorRows);
  const lang = detectLanguage(latest);
  const firstRequest = /(一開始|一开始|第一個問題|第一个问题|最初).*(問|問題|问题)|what\s+(?:did\s+i\s+ask|was\s+(?:my\s+)?first)|first\s+(?:question|thing\s+i\s+asked)/i.test(latest);
  const correctionRequest = /(之前|先前|剛才|刚才|earlier|previous).*(更正|改正|correct)|更正後|更正后|what\s+did\s+i\s+correct|latest\s+correction/i.test(latest);
  const constraintRequest = /(限制|約束|约束|不要猜|唔好估|constraint|restriction|what.*(?:told|asked).*(?:not|don.?t))/i.test(latest) && /(記得|记得|總結|总结|告訴|告诉|什麼|什么|what|recall|remember|summari)/i.test(latest);
  const summaryRequest = /(總結|总结|summari[sz]e).*(記得|记得|更正|限制|constraint|correction|remember)/i.test(latest);
  const recommendationRequest = /(之前|先前|剛才|刚才|earlier|previous).*(建議|建议|要我提供|需要.*資料|需要.*资料|recommend|suggest)|what\s+did\s+you\s+(?:recommend|suggest)|what\s+information.*(?:missing|need)/i.test(latest);
  const providedMissingRequest = /(我已經提供|我已经提供|我提供過|我提供过|已提供.*哪些|還缺|还缺|仍缺|what\s+information\s+have\s+i\s+already\s+given|what\s+have\s+i\s+already\s+given|what.*still\s+missing)/i.test(latest);
  const generalSummaryRequest = /(最後|最后|請|请)?\s*(?:用.{0,8})?(?:三點|三点|幾點|几点)?\s*(?:總結|总结).*(?:剛才|刚才|我們|我们|談過|谈过|內容|内容)|summari[sz]e.*(?:conversation|discussed|talked|so far)/i.test(latest);
  const nameRequest = /(我叫什麼|我叫什么|我的名字|我個名|我个名|what(?:'s| is)\s+my\s+name|do\s+you\s+remember\s+my\s+name)/i.test(latest);
  const locationRequest = /(我(?:現在|现在|目前).*(?:哪裡|哪里)|我.*(?:在哪|喺邊)|where\s+am\s+i|my\s+(?:current\s+)?location|更正後.*(?:地點|地点)|更正后.*(?:地點|地点))/i.test(latest);
  const currentContextRequest = /(我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\x27s| is)?\s+(?:the\s+)?(?:current\s+)?(?:region|jurisdiction).*(?:item|product))/i.test(latest);
  if (!(firstRequest || correctionRequest || constraintRequest || summaryRequest || recommendationRequest || providedMissingRequest || generalSummaryRequest || nameRequest || locationRequest || currentContextRequest)) return null;

  const zh = lang !== "en";
  const q = lang === "zh-CN" ? { first:"你一开始问的是", correction:"你之前最新的更正是", constraint:"你之前明确提出的限制包括", recommendation:"我之前的相关建议包括", name:"你之前告诉我你的名字是", location:"你之前更正后的地点是", none:"这段对话里没有足够资料可以确认。" } : { first:"你一開始問的是", correction:"你之前最新的更正是", constraint:"你之前明確提出的限制包括", recommendation:"我之前的相關建議包括", name:"你之前告訴我你的名字是", location:"你之前更正後的地點是", none:"這段對話裡沒有足夠資料可以確認。" };
  const en = { first:"Your first question was", correction:"Your latest correction was", constraint:"The constraints you explicitly gave me include", recommendation:"My relevant earlier recommendations include", name:"You told me your name is", location:"The location from your latest correction is", none:"There is not enough information in this conversation to confirm that." };
  const t = zh ? q : en;
  const quote = (v: string) => zh ? `「${v}」` : `“${v}”`;
  const list = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\n");
  if (providedMissingRequest) {
    const priorCustomer = priorRows
      .filter((r) => CUSTOMER.has(String(r.role ?? "").toLowerCase()))
      .map((r) => clean(r.content))
      .filter(Boolean)
      .reverse()
      .slice(-8);
    const supplied = priorCustomer.filter((x) => !QUESTION.test(x) && !MEMORY.test(x)).slice(-5);
    const requested = state.prior_recommendations.slice(0, 4);
    if (lang === "en") {
      const parts: string[] = [];
      if (supplied.length) parts.push(`You have already told me:
${list(supplied)}`);
      if (requested.length) parts.push(`The information I previously asked for / that may still be missing:
${list(requested)}`);
      return parts.length ? parts.join("\n\n").slice(0, 1800) : en.none;
    }
    const parts: string[] = [];
    if (supplied.length) parts.push(`你已經提供：
${list(supplied)}`);
    if (requested.length) parts.push(`我之前要求／仍可能欠缺的資料：
${list(requested)}`);
    return parts.length ? parts.join("\n\n").slice(0, 1800) : q.none;
  }
  if (generalSummaryRequest) {
    const chronological = priorRows
      .filter((r) => CUSTOMER.has(String(r.role ?? "").toLowerCase()))
      .map((r) => clean(r.content))
      .filter(Boolean)
      .reverse();
    const anchors = [state.first_customer_turn, ...chronological.slice(-6)]
      .filter((x): x is string => Boolean(x))
      .filter((x, i, a) => a.indexOf(x) === i)
      .slice(0, 7);
    if (!anchors.length) return zh ? q.none : en.none;
    const heading = lang === "en" ? "Here is a concise summary of what we discussed:" : "我們剛才主要談到：";
    return `${heading}
${list(anchors.slice(0, 3))}`.slice(0, 1800);
  }
  if (summaryRequest) {
    const parts: string[] = [];
    if (state.latest_corrections.length) parts.push(`${t.correction}：\n${list(state.latest_corrections.slice(0, 3))}`);
    if (state.active_constraints.length) parts.push(`${t.constraint}：\n${list(state.active_constraints.slice(0, 5))}`);
    return parts.length ? parts.join("\n\n").slice(0, 1800) : t.none;
  }
  if (firstRequest) return state.first_customer_turn ? `${t.first} ${quote(state.first_customer_turn)}` : t.none;
  if (correctionRequest) return state.latest_corrections[0] ? `${t.correction} ${quote(state.latest_corrections[0])}` : t.none;
  if (constraintRequest) return state.active_constraints.length ? `${t.constraint}：\n${list(state.active_constraints.slice(0, 5))}` : t.none;
  if (recommendationRequest) return state.prior_recommendations.length ? `${t.recommendation}：\n${list(state.prior_recommendations.slice(0, 3))}` : t.none;
  if (nameRequest) {
    const customerTexts = priorRows.filter((r) => CUSTOMER.has(String(r.role ?? "").toLowerCase())).map((r) => clean(r.content));
    const named = customerTexts.find((x) => /^我叫\s*[^，。,.!?！？]{1,40}/.test(x));
    const m = named?.match(/^我叫\s*([^，。,.!?！？]{1,40})/);
    return m?.[1] ? `${t.name} ${quote(m[1].replace(/(?:請|请)?記住.*$/,'').trim())}` : t.none;
  }
  if (currentContextRequest) {
    const label: Record<string, Record<RuntimeLanguage,string>> = {
      hong_kong:{"zh-TW":"香港","zh-CN":"香港",en:"Hong Kong"}, macau:{"zh-TW":"澳門","zh-CN":"澳门",en:"Macau"}, singapore:{"zh-TW":"新加坡","zh-CN":"新加坡",en:"Singapore"}, taiwan:{"zh-TW":"台灣","zh-CN":"台湾",en:"Taiwan"}, mainland_china:{"zh-TW":"中國大陸","zh-CN":"中国大陆",en:"Mainland China"}, mars:{"zh-TW":"火星","zh-CN":"火星",en:"Mars"}
    };
    const region = state.jurisdiction ? label[state.jurisdiction]?.[lang] : undefined;
    const correction = state.latest_corrections[0] ?? "";
    const itemMatch = correction.match(/(?:問的是|問嘅係|问的是|其實係|其实是|改成)\s*([^，。,.!?！？]{1,40})/i);
    const item = itemMatch?.[1]?.trim() ?? "";
    if (!region || !item) return t.none;
    if (lang === "en") return `Your current region is ${region}, and the current item is ${item}.`;
    if (lang === "zh-CN") return `你现在问的是${region}的${item}。`;
    return `你現在問的是${region}的${item}。`;
  }
  if (locationRequest) {
    const corrected = state.latest_corrections.map((x) => detectExplicitJurisdiction(x)).find(Boolean) ?? null;
    const label: Record<string, Record<RuntimeLanguage,string>> = {
      hong_kong:{"zh-TW":"香港","zh-CN":"香港",en:"Hong Kong"}, macau:{"zh-TW":"澳門","zh-CN":"澳门",en:"Macau"}, singapore:{"zh-TW":"新加坡","zh-CN":"新加坡",en:"Singapore"}, taiwan:{"zh-TW":"台灣","zh-CN":"台湾",en:"Taiwan"}, mainland_china:{"zh-TW":"中國大陸","zh-CN":"中国大陆",en:"Mainland China"}, mars:{"zh-TW":"火星","zh-CN":"火星",en:"Mars"}
    };
    const value = corrected ? label[corrected]?.[lang] : undefined;
    return value ? `${t.location} ${value}` : t.none;
  }
  return null;
}

export function buildCanonicalRetrievalQuery(
  latestInput: string,
  newestFirst: RuntimeHistoryRow[],
): CanonicalRetrievalQuery {
  const latest = clean(latestInput);
  const state = projectConversationRuntimeState(newestFirst);
  const semantic = classifyCanonicalConversationTurn(latest, newestFirst);
  if (!latest) return { query: "", mode: "standalone", latest: "", context_turns: [], state };

  if (semantic.operation === "CONVERSATION_MEMORY") {
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
  const needsContext = semantic.needs_history;

  // An explicit jurisdiction is a hard topic boundary. Do not contaminate it
  // with prior-jurisdiction context; applicability is enforced downstream.
  const explicitBoundary = Boolean(explicitJurisdiction) &&
    semantic.operation !== "RETURN_TO_PRIOR_TOPIC" &&
    semantic.operation !== "CORRECTION";
  if (!needsContext || explicitBoundary) {
    return {
      query: latest,
      mode: "standalone",
      latest,
      context_turns: [],
      state: { ...state, jurisdiction: explicitJurisdiction ?? state.jurisdiction },
    };
  }

  const contextTurns = previous.filter((x) => !MEMORY.test(x) && !/^(不要猜|唔好估|不要估|do not guess|don.t guess|不要真人|不需要真人)/i.test(x)).slice(0, 5);
  if (state.first_customer_turn && !contextTurns.includes(state.first_customer_turn) && /(回收|政策|規則|规则|安排|official|policy|recycling)/i.test(latest)) {
    contextTurns.push(state.first_customer_turn);
  }
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
