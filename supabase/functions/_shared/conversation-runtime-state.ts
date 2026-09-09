export * from "./conversation-runtime-state-core.ts";

import {
  buildCanonicalRetrievalQuery as baseBuildCanonicalRetrievalQuery,
  projectConversationRuntimeState,
  type CanonicalRetrievalQuery,
  type RuntimeHistoryRow,
  type RuntimeLanguage,
  resolveConversationMemoryResponse as resolveConversationMemoryResponseCore,
  resolveWorkflow5ConversationLanguage,
} from "./conversation-runtime-state-core.ts";

const CUSTOMER_ROLES = new Set(["visitor", "customer", "user"]);
const CURRENT_STATE_SUMMARY_VERB =
  /(?:總結|总结|整理|列出|概括|歸納|归纳|summari[sz]e|list)/i;
const CURRENT_STATE_SUMMARY_SCOPE =
  /(?:(?:根據|根据|按|依照|基於|基于|based\s+on|according\s+to).{0,80}(?:我|my).{0,50}(?:最新|目前|現在|现在|current|latest).{0,50}(?:提供|資料|资料|資訊|信息|details|information)|(?:我|my).{0,40}(?:最新|目前|現在|现在|current|latest).{0,40}(?:提供|資料|资料|資訊|信息|details|information|需求|要求|requirements?))/i;
const CURRENT_STATE_FIELDS =
  /(?:商品|產品|产品|sku|staff|員工|员工|人手|市場|市场|market|app|push|crm|會員等級|会员等级|功能|features?)/i;

function clean(value: unknown, max = 1600): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function isCurrentCustomerStateSummary(text: string): boolean {
  const latest = clean(text);
  const explicitLatestRequirements =
    /(?:最新|目前|現在|现在|而家|current|latest).{0,24}(?:需求|要求|需要|requirements?|needs?)/i.test(latest);
  return Boolean(
    latest &&
      CURRENT_STATE_SUMMARY_VERB.test(latest) &&
      (CURRENT_STATE_SUMMARY_SCOPE.test(latest) || explicitLatestRequirements),
  );
}

function historyWithoutCurrentCustomerTurn(
  latestInput: string,
  newestFirst: RuntimeHistoryRow[],
): RuntimeHistoryRow[] {
  const latest = clean(latestInput);
  let removed = false;
  return newestFirst.filter((row) => {
    const role = String(row.role ?? "").toLowerCase();
    const content = clean(row.content);
    if (!removed && CUSTOMER_ROLES.has(role) && content === latest) {
      removed = true;
      return false;
    }
    return true;
  });
}

function marketLabel(id: string, language: RuntimeLanguage): string {
  const labels: Record<string, Record<RuntimeLanguage, string>> = {
    hong_kong: { "zh-TW": "香港", "zh-CN": "香港", en: "Hong Kong" },
    macau: { "zh-TW": "澳門", "zh-CN": "澳门", en: "Macau" },
    singapore: { "zh-TW": "新加坡", "zh-CN": "新加坡", en: "Singapore" },
    taiwan: { "zh-TW": "台灣", "zh-CN": "台湾", en: "Taiwan" },
    mainland_china: {
      "zh-TW": "中國大陸",
      "zh-CN": "中国大陆",
      en: "Mainland China",
    },
    mars: { "zh-TW": "火星", "zh-CN": "火星", en: "Mars" },
  };
  return labels[id]?.[language] ?? id;
}

function augmentState6RequirementSnapshot(
  newestFirst: RuntimeHistoryRow[],
  snapshot: ReturnType<typeof projectConversationRuntimeState>["current_requirements"],
) {
  const customerText = newestFirst
    .filter((row) => CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase()))
    .map((row) => clean(row.content, 1200))
    .filter(Boolean)
    .reverse()
    .join(" / ");

  let staffCount = snapshot.staff_count;
  if (staffCount === null) {
    const staff = customerText.match(/([一二兩两三四五六七八九十]|\d{1,3})\s*(?:個|个|位)?\s*(?:staff|員工|员工)/i);
    if (staff?.[1]) {
      const map: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
      staffCount = /^\d+$/.test(staff[1]) ? Number(staff[1]) : (map[staff[1]] ?? null);
    }
  }

  let currentMarket = snapshot.current_market;
  const current = customerText.match(/(?:目前|而家|現在|现在|currently|current|main\s+market)[^，。,.!?！？/]{0,30}?(香港|台灣|台湾|澳門|澳门|Hong\s+Kong|Taiwan|Macau)/i);
  const raw = current?.[1]?.toLowerCase() ?? "";
  if (/香港|hong\s+kong/.test(raw)) currentMarket = "hong_kong";
  else if (/台灣|台湾|taiwan/.test(raw)) currentMarket = "taiwan";
  else if (/澳門|澳门|macau/.test(raw)) currentMarket = "macau";

  const futureMarkets = new Set(snapshot.future_markets);
  const future = customerText.match(/(香港|台灣|台湾|澳門|澳门|Hong\s+Kong|Taiwan|Macau)\s*(?:之後|之后|以後|以后|未來|未来|later|future)/i);
  const futureRaw = future?.[1]?.toLowerCase() ?? "";
  if (/香港|hong\s+kong/.test(futureRaw)) futureMarkets.add("hong_kong");
  else if (/台灣|台湾|taiwan/.test(futureRaw)) futureMarkets.add("taiwan");
  else if (/澳門|澳门|macau/.test(futureRaw)) futureMarkets.add("macau");
  if (currentMarket) futureMarkets.delete(currentMarket);

  const desiredFeatures = new Set(snapshot.desired_features);
  if (
    /(?:會員功能|会员功能|membership(?:\s+(?:feature|features|function|functions))?)/i.test(customerText) &&
    /(?:想要|想用|要用|會用|会用|需要|need|want|use)/i.test(customerText)
  ) {
    desiredFeatures.add("會員功能");
  }

  return {
    ...snapshot,
    staff_count: staffCount,
    current_market: currentMarket,
    future_markets: [...futureMarkets],
    desired_features: [...desiredFeatures],
  };
}

function currentStateSummaryReply(
  latestInput: string,
  newestFirst: RuntimeHistoryRow[],
): string | null {
  if (!isCurrentCustomerStateSummary(latestInput)) return null;

  const priorRows = historyWithoutCurrentCustomerTurn(latestInput, newestFirst);
  const state = projectConversationRuntimeState(priorRows);
  const snapshot = augmentState6RequirementSnapshot(priorRows, state.current_requirements);
  const language = resolveWorkflow5ConversationLanguage(latestInput, priorRows);
  const lines: string[] = [];

  if (language === "en") {
    if (snapshot.product_count !== null) {
      lines.push(`Product count: about ${snapshot.product_count}`);
    }
    if (snapshot.staff_count !== null) {
      lines.push(`Management staff: ${snapshot.staff_count}`);
    }
    if (snapshot.current_market) {
      lines.push(`Current main market: ${marketLabel(snapshot.current_market, language)}`);
    }
    if (snapshot.future_markets.length) {
      lines.push(
        `Possible future markets: ${
          snapshot.future_markets.map((x) => marketLabel(x, language)).join(", ")
        } (not the current main market)`,
      );
    }
    if (snapshot.app_interest === true) lines.push("App: interested / include in plan");
    if (snapshot.app_interest === false) lines.push("App: not currently needed");
    if (snapshot.desired_features.length) {
      lines.push(`Desired features: ${snapshot.desired_features.join(", ")}`);
    }
    return lines.length
      ? `Your latest confirmed requirements are:\n${
        lines.map((line, index) => `${index + 1}. ${line}`).join("\n")
      }`
      : null;
  }

  if (snapshot.product_count !== null) {
    lines.push(`商品數量：約 ${snapshot.product_count} 件（${snapshot.product_count} SKU）`);
  }
  if (snapshot.staff_count !== null) {
    lines.push(`管理人手：${snapshot.staff_count} 位 staff`);
  }
  if (snapshot.current_market) {
    lines.push(`目前主要市場：${marketLabel(snapshot.current_market, language)}`);
  }
  if (snapshot.future_markets.length) {
    lines.push(
      `未來可能市場：${
        snapshot.future_markets.map((x) => marketLabel(x, language)).join("、")
      }（不是目前主要市場）`,
    );
  }
  if (snapshot.app_interest === true) lines.push("App：有興趣／需要納入方案");
  if (snapshot.app_interest === false) lines.push("App：目前不需要");
  if (snapshot.desired_features.length) {
    lines.push(`需要功能：${snapshot.desired_features.join("、")}`);
  }
  const heading = language === "zh-CN"
    ? "你目前最新的需求是："
    : "你目前最新的需求是：";
  return lines.length
    ? `${heading}\n${lines.map((line, index) => `${index + 1}. ${line}`).join("\n")}`
    : null;
}

export function resolveConversationMemoryResponse(
  latestInput: string,
  newestFirst: RuntimeHistoryRow[],
): string | null {
  const currentState = currentStateSummaryReply(latestInput, newestFirst);
  if (currentState) return currentState;
  return resolveConversationMemoryResponseCore(latestInput, newestFirst);
}

type PublishedPlan = "Basic" | "Growth" | "Pro";

function normalizePlan(raw: string | undefined): PublishedPlan | null {
  const value = clean(raw, 40).toLowerCase();
  if (value === "basic") return "Basic";
  if (value === "growth") return "Growth";
  if (value === "pro") return "Pro";
  return null;
}

function correctedPlanSubject(text: string): PublishedPlan | null {
  const latest = clean(text);
  if (!latest) return null;
  const correctionCue =
    /(?:其實|其实|唔係|不是|並非|并非|改問|改问|更正|instead|not\b|i\s+meant)/i;
  if (!correctionCue.test(latest)) return null;

  const explicitTarget = latest.match(
    /(?:我要問|我要问|我想問|我想问|想問|想问|問嘅係|问的是|改問|改问|ask\s+about|i\s+(?:want|meant)\s+(?:to\s+)?(?:ask\s+about\s+)?)\s*(?:the\s+)?(Basic|Growth|Pro)(?:\s+(?:plan|方案))?/i,
  );
  const explicitPlan = normalizePlan(explicitTarget?.[1]);
  if (explicitPlan) return explicitPlan;

  const contrastTarget = latest.match(
    /(?:而係|而是|instead(?:\s+of)?|but)\s*(?:the\s+)?(Basic|Growth|Pro)(?:\s+(?:plan|方案))?/i,
  );
  return normalizePlan(contrastTarget?.[1]);
}

function correctedPlanFactDimension(newestFirst: RuntimeHistoryRow[]): string | null {
  const previousCustomerTurns = newestFirst
    .filter((row) => CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase()))
    .map((row) => clean(row.content, 500))
    .filter(Boolean);
  const prior = previousCustomerTurns.find((text) =>
    /(?:sku|staff|員工|员工|人手|app|push|crm|會員|会员|ai\s*seo|價錢|价钱|價格|价格|price|費用|费用|limit|上限)/i.test(text)
  );
  if (!prior) return null;
  if (/(?:sku|商品.*上限|產品.*上限|产品.*上限)/i.test(prior)) return "SKU limit";
  if (/(?:staff|員工|员工|人手)/i.test(prior)) return "staff/admin-seat limit";
  if (/(?:價錢|价钱|價格|价格|price|費用|费用)/i.test(prior)) return "price and billing cadence";
  if (/(?:app|push|crm|會員|会员|ai\s*seo)/i.test(prior)) return "included features and limits";
  return null;
}

function explicitPlanFactQuery(text: string): { plan: PublishedPlan; fact: string } | null {
  const latest = clean(text);
  if (!latest) return null;
  const planMatch = latest.match(/\b(Basic|Growth|Pro)\b/i);
  const plan = normalizePlan(planMatch?.[1]);
  if (!plan) return null;
  let fact: string | null = null;
  if (/(?:sku|商品.*(?:上限|limit)|產品.*(?:上限|limit)|产品.*(?:上限|limit))/i.test(latest)) fact = "SKU limit";
  else if (/(?:staff|員工|员工|人手|admin(?:[- ]?seat)?)/i.test(latest)) fact = "staff/admin-seat limit";
  else if (/(?:價錢|价钱|價格|价格|price|費用|费用|monthly|yearly|每月|每年)/i.test(latest)) fact = "price and billing cadence";
  else if (/(?:app|push|crm|會員|会员|ai\s*seo|feature|功能|included|包括|包含)/i.test(latest)) fact = "included features and limits";
  if (!fact) return null;
  return { plan, fact };
}

export function buildCanonicalRetrievalQuery(
  latestInput: string,
  newestFirst: RuntimeHistoryRow[],
): CanonicalRetrievalQuery {
  const correctedPlan = correctedPlanSubject(latestInput);
  const explicitPlanFact = explicitPlanFactQuery(latestInput);
  if (!correctedPlan && explicitPlanFact) {
    const latest = clean(latestInput);
    const state = projectConversationRuntimeState(newestFirst);
    const currentRequirements = augmentState6RequirementSnapshot(
      newestFirst,
      state.current_requirements,
    );
    return {
      query: `${explicitPlanFact.plan} ${explicitPlanFact.fact}`,
      mode: "standalone",
      latest,
      context_turns: [],
      state: {
        ...state,
        current_topic: explicitPlanFact.plan,
        jurisdiction: currentRequirements.current_market ?? state.jurisdiction,
        current_requirements: currentRequirements,
      },
    };
  }
  if (!correctedPlan) {
    return baseBuildCanonicalRetrievalQuery(latestInput, newestFirst);
  }

  const latest = clean(latestInput);
  const state = projectConversationRuntimeState(newestFirst);
  const factDimension = correctedPlanFactDimension(newestFirst);
  const currentRequirements = augmentState6RequirementSnapshot(
    newestFirst,
    state.current_requirements,
  );
  return {
    query: [
      `Current factual target: ${correctedPlan}`,
      ...(factDimension ? [`Requested fact: ${factDimension}`] : []),
      `Correction boundary: answer about ${correctedPlan} only; prior plan references are superseded for this turn and must not appear in retrieval context or evidence.`,
      `Retrieval target: published ${correctedPlan} plan record: exact price, billing cadence, SKU/staff limits, App, Push, CRM, member tiers and AI SEO inclusions.`,
    ].join("\n").slice(0, 1600),
    mode: "standalone",
    latest,
    context_turns: [],
    state: {
      ...state,
      current_topic: correctedPlan,
      jurisdiction: currentRequirements.current_market ?? state.jurisdiction,
      current_requirements: currentRequirements,
    },
  };
}
