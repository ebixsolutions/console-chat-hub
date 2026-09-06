from pathlib import Path

p = Path('supabase/functions/_shared/conversation-runtime-state.ts')
s = p.read_text()

def replace_once(old: str, new: str):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'PATCH_GUARD expected 1 occurrence, got {n}: {old[:80]!r}')
    s = s.replace(old, new, 1)

replace_once(
'''export type RuntimeLanguage = "zh-TW" | "zh-CN" | "en";
export interface ConversationRuntimeState {''',
'''export type RuntimeLanguage = "zh-TW" | "zh-CN" | "en";
export interface CurrentRequirementSnapshot {
  product_count: number | null;
  staff_count: number | null;
  app_interest: boolean | null;
  desired_features: string[];
  current_market: string | null;
  future_markets: string[];
}
export interface ConversationRuntimeState {''')

replace_once(
'''  prior_recommendations: string[];
}''',
'''  prior_recommendations: string[];
  current_requirements: CurrentRequirementSnapshot;
}''')

replace_once(
'''function normalizeTopic(text: string): string {
  return clean(text)
    .replace(/[?？!！。,.，]/g, " ")
    .replace(/^(?:咁|那|所以|另外|再|又|what about|then|so)\\s*/i, "")
    .trim()
    .slice(0, 180);
}

export function projectConversationRuntimeState''',
'''function normalizeTopic(text: string): string {
  return clean(text)
    .replace(/[?？!！。,.，]/g, " ")
    .replace(/^(?:咁|那|所以|另外|再|又|what about|then|so)\\s*/i, "")
    .trim()
    .slice(0, 180);
}

function smallCount(raw: string): number | null {
  if (/^\\d{1,6}$/.test(raw)) return Number(raw);
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

    const product = text.match(/(\\d{1,6})\\s*(?:件(?:商品|產品|产品)?|sku\\b)/i);
    if (product?.[1]) productCount = Number(product[1]);
    const latestCount = text.match(/(?:最新|目前|現在|现在)\\s*(?:係|是|為|为)?\\s*(\\d{1,6})(?:\\s*(?:件|sku))?/i);
    if (productCount !== null && latestCount?.[1]) productCount = Number(latestCount[1]);

    if (/(?:得我|只有我|只係我|只是我).{0,12}(?:一個人|一个人).{0,12}(?:管理|manage)/i.test(text)) staffCount = 1;
    const staff = text.match(/(?:我有|有)\\s*([一二兩两三四五六七八九十]|\\d{1,3})\\s*(?:個|个|位)?\\s*(?:staff|員工|员工)/i);
    if (staff?.[1]) staffCount = smallCount(staff[1]);
    const addStaff = text.match(/(?:再加|增加|加多|add)\\s*([一二兩两三四五六七八九十]|\\d{1,3})\\s*(?:個|个|位)?\\s*(?:staff|員工|员工)/i);
    if (addStaff?.[1]) {
      const n = smallCount(addStaff[1]);
      if (n !== null) staffCount = (staffCount ?? 0) + n;
    }

    if (/(?:唔要|不要|不需要|唔需要)\\s*app.{0,20}(?:已經|已经)?(?:過時|过时|outdated|no longer)/i.test(text)) appInterest = true;
    else if (/(?:app).{0,16}(?:有興趣|有兴趣|想要|需要|要用|會用|会用)|(?:想要|需要|要用)\\s*app/i.test(text)) appInterest = true;
    else if (/(?:暫時|暂时)?\\s*(?:唔需要|不需要|唔要|不要)\\s*app/i.test(text)) appInterest = false;

    if (/(?:想要|要用|會用|会用|需要).{0,12}(?:push|推播|推送)|(?:push|推播|推送).{0,12}(?:想要|要用|會用|会用|需要)/i.test(text)) desired.add('Push');
    if (/(?:想用|要用|會用|会用|需要).{0,12}crm|crm.{0,12}(?:想用|要用|會用|会用|需要)/i.test(text)) desired.add('CRM');
    if (/(?:會員等級|会员等级).{0,12}(?:都)?(?:會用|会用|要用|需要)|(?:想用|要用|需要).{0,12}(?:會員等級|会员等级)/i.test(text)) desired.add('會員等級');

    const market = detectExplicitJurisdiction(text);
    if (market) {
      if (/(?:之後|之后|以後|以后|未來|未来|later|future).{0,20}(?:可能|maybe|may|plan|做|進入|进入)/i.test(text)) {
        futureMarkets.add(market);
      } else if (/(?:目前|而家|現在|现在|主要市場|主要市场|仍然|只做|currently|current|main market)/i.test(text)) {
        currentMarket = market;
      }
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
  if (lang === 'en') {
    if (snapshot.product_count !== null) out.push(`Product count: about ${snapshot.product_count}`);
    if (snapshot.staff_count !== null) out.push(`Management staff: ${snapshot.staff_count}`);
    if (snapshot.app_interest === true) out.push('App: interested / include in plan');
    if (snapshot.app_interest === false) out.push('App: not currently needed');
    if (snapshot.desired_features.length) out.push(`Desired features: ${snapshot.desired_features.join(', ')}`);
    if (snapshot.current_market) out.push(`Current main market: ${marketLabel(snapshot.current_market, lang)}`);
    if (snapshot.future_markets.length) out.push(`Possible future markets: ${snapshot.future_markets.map((x) => marketLabel(x, lang)).join(', ')} (not the current main market)`);
    return out;
  }
  if (snapshot.product_count !== null) out.push(`商品數量：約 ${snapshot.product_count} 件`);
  if (snapshot.staff_count !== null) out.push(`管理人手：${snapshot.staff_count} 位 staff`);
  if (snapshot.app_interest === true) out.push('App：有興趣／需要納入方案');
  if (snapshot.app_interest === false) out.push('App：目前不需要');
  if (snapshot.desired_features.length) out.push(`需要功能：${snapshot.desired_features.join('、')}`);
  if (snapshot.current_market) out.push(`目前主要市場：${marketLabel(snapshot.current_market, lang)}`);
  if (snapshot.future_markets.length) out.push(`未來可能市場：${snapshot.future_markets.map((x) => marketLabel(x, lang)).join('、')}（不是目前主要市場）`);
  return out;
}

export function projectConversationRuntimeState''')

replace_once(
'''  const refs = latest
    ? [...latest.matchAll(/(這個|这个|那個|那个|它|其|上述|剛才|刚才|之前|same|that|this|it|its)/gi)].map((m) => m[0]).slice(0, 6)
    : [];
  return {''',
'''  const refs = latest
    ? [...latest.matchAll(/(這個|这个|那個|那个|它|其|上述|剛才|刚才|之前|same|that|this|it|its)/gi)].map((m) => m[0]).slice(0, 6)
    : [];
  const currentRequirements = deriveCurrentRequirementSnapshot(chronological.map((row) => row.text));
  return {''')

replace_once(
'''    prior_recommendations: assistants.filter((row) => RECOMMEND.test(row.text)).slice(0, 6).map((row) => row.text),
  };''',
'''    prior_recommendations: assistants.filter((row) => RECOMMEND.test(row.text)).slice(0, 6).map((row) => row.text),
    current_requirements: currentRequirements,
  };''')

replace_once(
'''    `Current item: ${state.current_item ?? "unspecified"}`,
  ];''',
'''    `Current item: ${state.current_item ?? "unspecified"}`,
  ];
  const requirementLines = currentRequirementLines(state.current_requirements, state.language);
  if (requirementLines.length) {
    lines.push("Current customer-authored requirements (latest state wins; assistant statements are not authority):");
    requirementLines.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }''')

replace_once(
'''  const currentContextRequest = currentContextPattern.test(latest) || memoryLanguageContinuation;
  if (!(firstRequest || correctionRequest || constraintRequest || summaryRequest || recommendationRequest || providedMissingRequest || generalSummaryRequest || mainlyAskedRequest || nameRequest || locationRequest || currentContextRequest)) return null;

  const zh = lang !== "en";''',
'''  const currentContextRequest = currentContextPattern.test(latest) || memoryLanguageContinuation;
  const latestRequirementsRequest = /(?:列出|整理|總結|总结|講出|说出|tell me|list|summari[sz]e).{0,30}(?:最新|目前|現在|现在|current).{0,20}(?:需求|要求|條件|条件|requirements?)|(?:最新|目前|現在|现在|current).{0,20}(?:需求|要求|條件|条件|requirements?).{0,30}(?:是什麼|是什么|有哪些|係咩|what are)/i.test(latest);
  if (!(firstRequest || correctionRequest || constraintRequest || summaryRequest || recommendationRequest || providedMissingRequest || generalSummaryRequest || mainlyAskedRequest || nameRequest || locationRequest || currentContextRequest || latestRequirementsRequest)) return null;

  const zh = lang !== "en";''')

replace_once(
'''  const list = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\\n");
  if (mainlyAskedRequest) {''',
'''  const list = (xs: string[]) => xs.map((x, i) => `${i + 1}. ${x}`).join("\\n");
  if (latestRequirementsRequest) {
    const lines = currentRequirementLines(state.current_requirements, lang);
    if (!lines.length) return lang === "en" ? en.none : q.none;
    const heading = lang === "en" ? "Your latest confirmed requirements are:" : "你目前最新的需求是：";
    return `${heading}\\n${list(lines)}`.slice(0, 1800);
  }
  if (mainlyAskedRequest) {''')

replace_once(
'''  const needsContext = semantic.needs_history;

  // An explicit jurisdiction is a hard topic boundary.''',
'''  const referencesCurrentRequirements = /(?:基於|基于|根據|根据|按|依照|based on|according to).{0,30}(?:最新|目前|現在|现在|current).{0,20}(?:需求|要求|條件|条件|requirements?)/i.test(latest);
  const needsContext = semantic.needs_history || referencesCurrentRequirements;

  // An explicit jurisdiction is a hard topic boundary.''')

replace_once(
'''    query: [
      `Current request: ${latest}`,
      `Relevant prior customer context: ${contextTurns.join(" / ")}`,
    ].join("\\n").slice(0, 1200),''',
'''    query: [
      `Current request: ${latest}`,
      ...(currentRequirementLines(state.current_requirements, state.language).length
        ? [`Current customer requirement snapshot (latest wins): ${currentRequirementLines(state.current_requirements, state.language).join(" / ")}`]
        : []),
      `Relevant prior customer context: ${contextTurns.join(" / ")}`,
    ].join("\\n").slice(0, 1600),''')

p.write_text(s)
print('WORKFLOW4_PATCH=PASS')
