export * from "./conversation-runtime-state-core.ts";

import {
  buildCanonicalRetrievalQuery as baseBuildCanonicalRetrievalQuery,
  projectConversationRuntimeState,
  type CanonicalRetrievalQuery,
  type RuntimeHistoryRow,
  type RuntimeLanguage,
  resolveConversationMemoryResponse as resolveConversationMemoryResponseCore,
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
  return Boolean(
    latest &&
      CURRENT_STATE_SUMMARY_VERB.test(latest) &&
      CURRENT_STATE_SUMMARY_SCOPE.test(latest) &&
      CURRENT_STATE_FIELDS.test(latest),
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

function currentStateSummaryReply(
  latestInput: string,
  newestFirst: RuntimeHistoryRow[],
): string | null {
  if (!isCurrentCustomerStateSummary(latestInput)) return null;

  const priorRows = historyWithoutCurrentCustomerTurn(latestInput, newestFirst);
  const state = projectConversationRuntimeState(priorRows);
  const snapshot = state.current_requirements;
  const language = state.language;
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
    /(?:我要問|我要问|我想問|我想问|想問|想问|問嘅係|问的是|改問|改问|ask\s+about|i\s+(?:want|meant)\s+(?:to\s+)?(?:ask\s+about\s+)?)(?:the\s+)?(Basic|Growth|Pro)(?:\s+(?:plan|方案))?/i,
  );
  const explicitPlan = normalizePlan(explicitTarget?.[1]);
  if (explicitPlan) return explicitPlan;

  const contrastTarget = latest.match(
    /(?:而係|而是|instead(?:\s+of)?|but)\s*(?:the\s+)?(Basic|Growth|Pro)(?:\s+(?:plan|方案))?/i,
  );
  return normalizePlan(contrastTarget?.[1]);
}

export function buildCanonicalRetrievalQuery(
  latestInput: string,
  newestFirst: RuntimeHistoryRow[],
): CanonicalRetrievalQuery {
  const correctedPlan = correctedPlanSubject(latestInput);
  if (!correctedPlan) {
    return baseBuildCanonicalRetrievalQuery(latestInput, newestFirst);
  }

  const latest = clean(latestInput);
  const state = projectConversationRuntimeState(newestFirst);
  return {
    query: [
      `Current request: ${correctedPlan} plan`,
      `Correction boundary: answer about ${correctedPlan} only; prior plan references in the conversation are superseded for this turn.`,
      `Retrieval target: published ${correctedPlan} plan record: exact price, billing cadence, SKU/staff limits, App, Push, CRM, member tiers and AI SEO inclusions.`,
    ].join("\n").slice(0, 1600),
    mode: "standalone",
    latest,
    context_turns: [],
    state,
  };
}
