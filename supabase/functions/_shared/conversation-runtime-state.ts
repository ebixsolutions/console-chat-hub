import { classifyCanonicalConversationTurn, type ConversationOperation, type EvidenceAuthority } from "./conversation-semantic-contract.ts";

export type RuntimeHistoryRow = { role?: string; content?: string | null; created_at?: string | null; metadata?: unknown };
export type RuntimeLanguage = "zh-TW" | "zh-CN" | "en";

export interface CurrentRequirementSnapshot {
  product_count: number | null;
  staff_count: number | null;
  app_interest: boolean | null;
  desired_features: string[];
  current_market: string | null;
  future_markets: string[];
}

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
  current_item: string | null;
  language: RuntimeLanguage;
  prior_recommendations: string[];
  current_requirements: CurrentRequirementSnapshot;
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
const LATEST_VALUE_CORRECTION = /(?:記住|记住)?\s*(?:最新|目前|現在|现在)\s*(?:係|是|為|为)?\s*[^，。,.!?！？]{1,50}(?:，|,)\s*(?:唔係|不是|而不是|not)\s*[^，。,.!?！？]{1,50}/i;

function isCorrectionText(text: string): boolean {
  if (EXPLICIT_CORRECTION.test(text) || LATEST_VALUE_CORRECTION.test(text)) return true;
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

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasGroundedLineage(metadata: unknown): boolean {
  const meta = metadataRecord(metadata);
  const lineage = metadataRecord(meta?.citation_lineage);
  return typeof lineage?.selected_document_id === "string" &&
    Array.isArray(lineage?.evidence_chunk_ids) &&
    lineage.evidence_chunk_ids.some((x) => typeof x === "string" && x.length > 0);
}

function detectFocusedItem(text: string): string | null {
  const t = clean(text);
  const focus = t.match(/(?:只(?:說|说|講|讲)|只要|聚焦|focus(?: only)? on)\s*([^，。,.!?！？]{1,40}?)(?:相關|相关|部分|內容|内容|\s+only|$)/i);
  const raw = focus?.[1]?.trim().replace(/^(?:在|關於|关于|the)\s*/i, "") ?? "";
  return raw && raw.length <= 40 ? raw : null;
}

function detectCorrectedItem(text: string): string | null {
  const m = clean(text).match(/(?:問的是|問嘅係|问的是|其實係|其实是|改成)\s*([^，。,.!?！？]{1,40})/i);
  if (!m?.[1]) return null;
  return m[1].replace(/(?:，|,)?\s*(?:不是|唔係|not)\s+.*$/i, "").trim() || null;
}

function localizedCurrentItem(item: string, lang: RuntimeLanguage): string {
  const normalized = clean(item).toLowerCase();
  const airConditioner = /(?:冷氣機|冷气机|空調機|空调机|air[- ]?conditioner|aircon)/i.test(normalized);
  if (!airConditioner) return item;
  if (lang === "en") return "air conditioner";
  if (lang === "zh-CN") return "空调机";
  return "冷氣機";
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
    if (!jurisdictionOccurrenceIsNegated(t, match.index)) candidates.push({ id, index: match.index });
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

function smallCount(raw: string): number | null {
  if (/^\d{1,6}$/.test(raw)) return Number(raw);
  const map: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return map[raw] ?? null;
}

function marketLabel(id: string, lang: RuntimeLanguage): string {
  const labels: Record<string, Record<RuntimeLanguage, string>> = {
    hong_kong: { "zh-TW": "香港", "zh-CN": "香港", en: "Hong Kong" },
    macau: { "zh-TW": "澳門", "zh-CN": "澳门", en: "Macau" },
    singapore: { "zh-TW": "新加坡", "zh-CN": "新加坡", en: "Singapore" },
    taiwan: { "zh-TW": "台灣", "zh-CN": "台湾", en: "Taiwan" },
    mainland_china: { "zh-TW": "中國大陸", "zh-CN": "中国大陆", en: "Mainland China" },
    mars: { "zh-TW": "火星", "zh-CN": "火星", en: "Mars" },
  };
  return labels[id]?.[lang] ?? id;
}

export function deriveCurrentRequirementSnapshot(chronologicalCustomerTurns: string[]): CurrentRequirementSnapshot {
  let productCount: number | null = null;
  let staffCount: number | null = null;
  let appInterest: boolean | null = null;
  const desired = new Set<string>();
  let currentMarket: string | null = null;
  const futureMarkets = new Set<string>();

  for (const raw of chronologicalCustomerTurns) {
    const text = clean(raw);
    if (!text || /[?？]/.test(text)) continue;

    const product = text.match(/(\d{1,6})\s*(?:件(?:商品|產品|产品)?|sku\b)/i);
    if (product?.[1]) productCount = Number(product[1]);
    const latestCount = text.match(/(?:最新|目前|現在|现在)\s*(?:係|是|為|为)?\s*(\d{1,6})(?:\s*(?:件|sku))?/i);
    if (productCount !== null && latestCount?.[1]) productCount = Number(latestCount[1]);

    if (/(?:得我|只有我|只係我|只是我).{0,12}(?:一個人|一个人).{0,12}(?:管理|manage)/i.test(text)) staffCount = 1;
    const staff = text.match(/(?:我有|有)\s*([一二兩两三四五六七八九十]|\d{1,3})\s*(?:個|个|位)?\s*(?:staff|員工|员工)/i);
    if (staff?.[1]) staffCount = smallCount(staff[1]);
    const addStaff = text.match(/(?:再加|增加|加多|add)\s*([一二兩两三四五六七八九十]|\d{1,3})\s*(?:個|个|位)?\s*(?:staff|員工|员工)/i);
    if (addStaff?.[1]) {
      const n = smallCount(addStaff[1]);
      if (n !== null) staffCount = (staffCount ?? 0) + n;
    }

    if (/(?:唔要|不要|不需要|唔需要)\s*app.{0,20}(?:已經|已经)?(?:過時|过时|outdated|no longer)/i.test(text)) appInterest = true;
    else if (/(?:app).{0,16}(?:有興趣|有兴趣|想要|需要|要用|會用|会用)|(?:想要|需要|要用)\s*app/i.test(text)) appInterest = true;
    else if (/(?:暫時|暂时)?\s*(?:唔需要|不需要|唔要|不要)\s*app/i.test(text)) appInterest = false;

    if (/(?:想要|要用|會用|会用|需要).{0,12}(?:push|推播|推送)|(?:push|推播|推送).{0,12}(?:想要|要用|會用|会用|需要)/i.test(text)) desired.add("Push");
    if (/(?:想用|要用|會用|会用|需要).{0,12}crm|crm.{0,12}(?:想用|要用|會用|会用|需要)/i.test(text)) desired.add("CRM");
    if (/(?:會員等級|会员等级).{0,12}(?:都)?(?:會用|会用|要用|需要)|(?:想用|要用|需要).{0,12}(?:會員等級|会员等级)/i.test(text)) desired.add("會員等級");

    const market = detectExplicitJurisdiction(text);
    if (market) {
      if (/(?:之後|之后|以後|以后|未來|未来|later|future).{0,20}(?:可能|maybe|may|plan|做|進入|进入)/i.test(text)) futureMarkets.add(market);
      else if (/(?:目前|而家|現在|现在|主要市場|主要市场|仍然|只做|currently|current|main market)/i.test(text)) currentMarket = market;
    }
  }

  if (currentMarket) futureMarkets.delete(currentMarket);
  return {
    product_count: productCount,
    staff_count: staffCount,
    app_interest: appInterest,
    desired_features: [...desired],
    current_market: currentMarket,
    future_markets: [...futureMarkets],
  };
}

function currentRequirementLines(snapshot: CurrentRequirementSnapshot, lang: RuntimeLanguage): string[] {
  const out: string[] = [];
  if (lang === "en") {
    if (snapshot.product_count !== null) out.push(`Product count: about ${snapshot.product_count}`);
    if (snapshot.staff_count !== null) out.push(`Management staff: ${snapshot.staff_count}`);
    if (snapshot.app_interest === true) out.push("App: interested / include in plan");
    if (snapshot.app_interest === false) out.push("App: not currently needed");
    if (snapshot.desired_features.length) out.push(`Desired features: ${snapshot.desired_features.join(", ")}`);
    if (snapshot.current_market) out.push(`Current main market: ${marketLabel(snapshot.current_market, lang)}`);
    if (snapshot.future_markets.length) out.push(`Possible future markets: ${snapshot.future_markets.map((x) => marketLabel(x, lang)).join(", ")} (not the current main market)`);
    return out;
  }
  if (snapshot.product_count !== null) out.push(`商品數量：約 ${snapshot.product_count} 件`);
  if (snapshot.staff_count !== null) out.push(`管理人手：${snapshot.staff_count} 位 staff`);
  if (snapshot.app_interest === true) out.push("App：有興趣／需要納入方案");
  if (snapshot.app_interest === false) out.push("App：目前不需要");
  if (snapshot.desired_features.length) out.push(`需要功能：${snapshot.desired_features.join("、")}`);
  if (snapshot.current_market) out.push(`目前主要市場：${marketLabel(snapshot.current_market, lang)}`);
  if (snapshot.future_markets.length) out.push(`未來可能市場：${snapshot.future_markets.map((x) => marketLabel(x, lang)).join("、")}（不是目前主要市場）`);
  return out;
}

export function projectConversationRuntimeState(newestFirst: RuntimeHistoryRow[]): ConversationRuntimeState {
  const rows = newestFirst
    .map((row) => ({ text: clean(row.content), role: String(row.role ?? "").toLowerCase(), metadata: row.metadata }))
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
  const groundedAssistantJurisdiction = assistants.filter((row) => hasGroundedLineage(row.metadata)).map((row) => detectExplicitJurisdiction(row.text)).find(Boolean) ?? null;
  const correctedItem = corrections.map((text) => detectCorrectedItem(text)).find(Boolean) ?? null;
  const focusedItem = customers.map((row) => detectFocusedItem(row.text)).find(Boolean) ?? null;
  const topics: string[] = [];
  for (const row of chronological) {
    const topic = normalizeTopic(row.text);
    if (topic && !topics.includes(topic)) topics.push(topic);
  }
  const currentTopic = latest ? normalizeTopic(latest) : null;
  const refs = latest ? [...latest.matchAll(/(這個|这个|那個|那个|它|其|上述|剛才|刚才|之前|same|that|this|it|its)/gi)].map((m) => m[0]).slice(0, 6) : [];
  const currentRequirements = deriveCurrentRequirementSnapshot(chronological.map((row) => row.text));
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
    jurisdiction: explicitJurisdiction ?? inheritedJurisdiction ?? groundedAssistantJurisdiction,
    current_item: correctedItem ?? focusedItem,
    language: detectLanguage(latest ?? first ?? ""),
    prior_recommendations: assistants.filter((row) => RECOMMEND.test(row.text)).slice(0, 6).map((row) => row.text),
    current_requirements: currentRequirements,
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
    `Current item: ${state.current_item ?? "unspecified"}`,
  ];
  const requirementLines = currentRequirementLines(state.current_requirements, state.language);
  if (requirementLines.length) {
    lines.push("Current customer-authored requirements (latest state wins; assistant statements are not authority):");
    requirementLines.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
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

export function resolveConversationMemoryResponse(latestInput: string, newestFirst: RuntimeHistoryRow[]): string | null {
  const latest = clean(latestInput);
  if (!latest) return null;
  if (/(請記住|请记住|please\s+remember|remember\s+that)/i.test(latest)) return null;

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
  const mainlyAskedRequest = /(?:剛才|刚才).*(?:主要)?(?:問|问).*(?:什麼|什么|咩)|(?:主要)(?:問|问).*(?:什麼|什么|咩)|what\s+(?:was|is)\s+(?:my\s+)?(?:main|mainly|primary).*(?:question|asking|ask)/i.test(latest);
  const nameRequest = /(我叫什麼|我叫什么|我的名字|我個名|我个名|what(?:'s| is)\s+my\s+name|do\s+you\s+remember\s+my\s+name)/i.test(latest);
  const locationRequest = /(我(?:現在|现在|目前).*(?:哪裡|哪里)|我.*(?:在哪|喺邊)|where\s+am\s+i|my\s+(?:current\s+)?location|更正後.*(?:地點|地点)|更正后.*(?:地點|地点))/i.test(latest);
  const currentContextPattern = /(我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\x27s| is)?\s+(?:the\s+)?(?:current\s+)?(?:region|jurisdiction).*(?:item|product))/i;
  const languageContinuationPattern = /(?:answer|say|repeat).*(?:same|that).*(?:english|chinese|cantonese)|(?:same|that).*(?:in|into)\s+(?:english|chinese|cantonese)|(?:回到|改用|用)\s*(?:繁體中文|繁体中文|簡體中文|简体中文|英文|廣東話|广东话)/i;
  const recentPriorCustomerTurns = priorRows.filter((row) => CUSTOMER.has(String(row.role ?? "").toLowerCase())).map((row) => clean(row.content)).filter(Boolean).slice(0, 2);
  const hasRecentCurrentContextQuestion = recentPriorCustomerTurns.some((text) => currentContextPattern.test(text));
  const hasChainedLanguageContinuation = recentPriorCustomerTurns.length >= 2 && languageContinuationPattern.test(recentPriorCustomerTurns[0]) && currentContextPattern.test(recentPriorCustomerTurns[1]);
  const memoryLanguageContinuation = languageContinuationPattern.test(latest) && (hasRecentCurrentContextQuestion || hasChainedLanguageContinuation);
  const currentContextRequest = currentContextPattern.test(latest) || memoryLanguageContinuation;
  const latestRequirementsRequest = /(?:列出|整理|總結|总结|講出|说出|tell me|list|summari[sz]e).{0,30}(?:最新|目前|現在|现在|current).{0,20}(?:需求|要求|條件|条件|requirements?)|(?:最新|目前|現在|现在|current).{0,20}(?:需求|要求|條件|条件|requirements?).{0,30}(?:是什麼|是什么|有哪些|係咩|what are)/i.test(latest);
  if (!(firstRequest || correctionRequest || constraintRequest || summaryRequest || recommendationRequest || providedMissingRequest || generalSummaryRequest || mainlyAskedRequest || nameRequest || locationRequest || currentContextRequest || latestRequirementsRequest)) return null;

  const zh = lang !== "en";
  const q = lang === "zh-CN"
    ? { first: "你一开始问的是", correction: "你之前最新的更正是", constraint: "你之前明确提出的限制包括", recommendation: "我之前的相关建议包括", name: "你之前告诉我你的名字是", location: "你之前更正后的地点是", none: "这段对话里没有足够资料可以确认。" }
    : { first: "你一開始問的是", correction: "你之前最新的更正是", constraint: "你之前明確提出的限制包括", recommendation: "我之前的相關建議包括", name: "你之前告訴我你的名字是", location: "你之前更正後的地點是", none: "這段對話裡沒有足夠資料可以確認。" };
  const en = { first: "Your first question was", correction: "Your latest correction was", constraint: "The constraints you explicitly gave me include", recommendation: "My relevant earlier recommendations include", name: "You told me your name is", location: "The location from your latest correction is", none: "There is not enough information in this conversation to confirm that." };
  const t = zh ? q : en;
  const quote = (v: string) => zh ? `「${v}」` : `“${v}”`;
  const list = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\n");

  if (latestRequirementsRequest) {
    const lines = currentRequirementLines(state.current_requirements, lang);
    if (!lines.length) return lang === "en" ? en.none : q.none;
    const heading = lang === "en" ? "Your latest confirmed requirements are:" : "你目前最新的需求是：";
    return `${heading}\n${list(lines)}`.slice(0, 1800);
  }
  if (mainlyAskedRequest) {
    const label: Record<string, Record<RuntimeLanguage, string>> = {
      hong_kong: { "zh-TW": "香港", "zh-CN": "香港", en: "Hong Kong" }, macau: { "zh-TW": "澳門", "zh-CN": "澳门", en: "Macau" }, singapore: { "zh-TW": "新加坡", "zh-CN": "新加坡", en: "Singapore" }, taiwan: { "zh-TW": "台灣", "zh-CN": "台湾", en: "Taiwan" }, mainland_china: { "zh-TW": "中國大陸", "zh-CN": "中国大陆", en: "Mainland China" }, mars: { "zh-TW": "火星", "zh-CN": "火星", en: "Mars" },
    };
    const region = state.jurisdiction ? label[state.jurisdiction]?.[lang] : undefined;
    const item = state.current_item ? localizedCurrentItem(state.current_item, lang) : "";
    if (region && item) {
      if (lang === "en") return `You were mainly asking about ${item} in ${region}.`;
      if (lang === "zh-CN") return `你刚才主要问的是${region}的${item}相关问题。`;
      return `你剛才主要問的是${region}的${item}相關問題。`;
    }
    if (state.first_customer_turn) {
      if (lang === "en") return `You were mainly asking about: ${state.first_customer_turn}`;
      if (lang === "zh-CN") return `你刚才主要问的是：${state.first_customer_turn}`;
      return `你剛才主要問的是：${state.first_customer_turn}`;
    }
    return lang === "en" ? en.none : q.none;
  }
  if (providedMissingRequest) {
    const priorCustomer = priorRows.filter((r) => CUSTOMER.has(String(r.role ?? "").toLowerCase())).map((r) => clean(r.content)).filter(Boolean).reverse().slice(-8);
    const supplied = priorCustomer.filter((x) => !QUESTION.test(x) && !MEMORY.test(x)).slice(-5);
    const requested = state.prior_recommendations.slice(0, 4);
    if (lang === "en") {
      const parts: string[] = [];
      if (supplied.length) parts.push(`You have already told me:\n${list(supplied)}`);
      if (requested.length) parts.push(`The information I previously asked for / that may still be missing:\n${list(requested)}`);
      return parts.length ? parts.join("\n\n").slice(0, 1800) : en.none;
    }
    const parts: string[] = [];
    if (supplied.length) parts.push(`你已經提供：\n${list(supplied)}`);
    if (requested.length) parts.push(`我之前要求／仍可能欠缺的資料：\n${list(requested)}`);
    return parts.length ? parts.join("\n\n").slice(0, 1800) : q.none;
  }
  if (generalSummaryRequest) {
    const chronological = priorRows.filter((r) => CUSTOMER.has(String(r.role ?? "").toLowerCase())).map((r) => clean(r.content)).filter(Boolean).reverse();
    const anchors = [state.first_customer_turn, ...chronological.slice(-6)].filter((x): x is string => Boolean(x)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 7);
    if (!anchors.length) return zh ? q.none : en.none;
    const heading = lang === "en" ? "Here is a concise summary of what we discussed:" : "我們剛才主要談到：";
    return `${heading}\n${list(anchors.slice(0, 3))}`.slice(0, 1800);
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
    return m?.[1] ? `${t.name} ${quote(m[1].replace(/(?:請|请)?記住.*$/, "").trim())}` : t.none;
  }
  if (currentContextRequest) {
    const label: Record<string, Record<RuntimeLanguage, string>> = {
      hong_kong: { "zh-TW": "香港", "zh-CN": "香港", en: "Hong Kong" }, macau: { "zh-TW": "澳門", "zh-CN": "澳门", en: "Macau" }, singapore: { "zh-TW": "新加坡", "zh-CN": "新加坡", en: "Singapore" }, taiwan: { "zh-TW": "台灣", "zh-CN": "台湾", en: "Taiwan" }, mainland_china: { "zh-TW": "中國大陸", "zh-CN": "中国大陆", en: "Mainland China" }, mars: { "zh-TW": "火星", "zh-CN": "火星", en: "Mars" },
    };
    const region = state.jurisdiction ? label[state.jurisdiction]?.[lang] : undefined;
    const item = state.current_item ? localizedCurrentItem(state.current_item, lang) : "";
    if (!region || !item) return t.none;
    if (lang === "en") return `Your current region is ${region}, and the current item is ${item}.`;
    if (lang === "zh-CN") return `你现在问的是${region}的${item}。`;
    return `你現在問的是${region}的${item}。`;
  }
  if (locationRequest) {
    const corrected = state.latest_corrections.map((x) => detectExplicitJurisdiction(x)).find(Boolean) ?? null;
    const label: Record<string, Record<RuntimeLanguage, string>> = {
      hong_kong: { "zh-TW": "香港", "zh-CN": "香港", en: "Hong Kong" }, macau: { "zh-TW": "澳門", "zh-CN": "澳门", en: "Macau" }, singapore: { "zh-TW": "新加坡", "zh-CN": "新加坡", en: "Singapore" }, taiwan: { "zh-TW": "台灣", "zh-CN": "台湾", en: "Taiwan" }, mainland_china: { "zh-TW": "中國大陸", "zh-CN": "中国大陆", en: "Mainland China" }, mars: { "zh-TW": "火星", "zh-CN": "火星", en: "Mars" },
    };
    const value = corrected ? label[corrected]?.[lang] : undefined;
    return value ? `${t.location} ${value}` : t.none;
  }
  return null;
}

export function buildCanonicalRetrievalQuery(latestInput: string, newestFirst: RuntimeHistoryRow[]): CanonicalRetrievalQuery {
  const latest = clean(latestInput);
  const state = projectConversationRuntimeState(newestFirst);
  const semantic = classifyCanonicalConversationTurn(latest, newestFirst);
  if (!latest) return { query: "", mode: "standalone", latest: "", context_turns: [], state };

  if (semantic.operation === "CONVERSATION_MEMORY") {
    const parts = [`Conversation-memory request: ${latest}`];
    if (state.first_customer_turn) parts.push(`First customer turn: ${state.first_customer_turn}`);
    if (state.prior_recommendations.length) parts.push(`Relevant prior recommendations: ${state.prior_recommendations.join(" / ")}`);
    return { query: parts.join("\n").slice(0, 1200), mode: "memory", latest, context_turns: [], state };
  }

  const explicitJurisdiction = detectExplicitJurisdiction(latest);
  const previous = newestFirst.filter((row) => CUSTOMER.has(String(row.role ?? "").toLowerCase())).map((row) => clean(row.content)).filter((x) => x && x !== latest && x !== "__THINKING__");
  const referencesCurrentRequirements = /(?:基於|基于|根據|根据|按|依照|based on|according to).{0,30}(?:最新|目前|現在|现在|current).{0,20}(?:需求|要求|條件|条件|requirements?)/i.test(latest);
  const needsContext = semantic.needs_history || referencesCurrentRequirements;

  const explicitBoundary = Boolean(explicitJurisdiction) && semantic.operation !== "RETURN_TO_PRIOR_TOPIC" && semantic.operation !== "CORRECTION";
  if (!needsContext || explicitBoundary) {
    return { query: latest, mode: "standalone", latest, context_turns: [], state: { ...state, jurisdiction: explicitJurisdiction ?? state.jurisdiction } };
  }

  const contextTurns = previous.filter((x) => !MEMORY.test(x) && !/^(不要猜|唔好估|不要估|do not guess|don.t guess|不要真人|不需要真人)/i.test(x)).slice(0, 5);
  if (state.first_customer_turn && !contextTurns.includes(state.first_customer_turn) && /(回收|政策|規則|规则|安排|official|policy|recycling)/i.test(latest)) contextTurns.push(state.first_customer_turn);
  if (!contextTurns.length) return { query: latest, mode: "standalone", latest, context_turns: [], state };
  const requirementLines = currentRequirementLines(state.current_requirements, state.language);
  return {
    query: [
      `Current request: ${latest}`,
      ...(requirementLines.length ? [`Current customer requirement snapshot (latest wins): ${requirementLines.join(" / ")}`] : []),
      `Relevant prior customer context: ${contextTurns.join(" / ")}`,
    ].join("\n").slice(0, 1600),
    mode: "contextual",
    latest,
    context_turns: contextTurns,
    state,
  };
}

export function buildCanonicalAssistRetrievalQuery(assistanceInput: string, newestFirst: RuntimeHistoryRow[]): CanonicalRetrievalQuery {
  const latest = clean(assistanceInput);
  const state = projectConversationRuntimeState(newestFirst);
  const customerTurns = newestFirst.filter((row) => CUSTOMER.has(String(row.role ?? "").toLowerCase())).map((row) => clean(row.content)).filter(Boolean).slice(0, 12);
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
