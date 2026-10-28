import { parseKbProductRecord, kbProductRecordPrice } from "./kb-product-record.ts";
import { type CanonicalGroundingResult, namedPriceProductLabel, exactNamedProductEvidence } from "./canonical-grounding.ts";
import type { KBFullChunk } from "./deterministic-kb-client.ts";
import { classifyProductFactualQuery } from "./natural-customer-response.ts";

export interface CanonicalKbDirectAnswer {
  kind: "product_record" | "stock_unknown" | "price" | "price_unknown" | "listed_price_unverified" | "specification" | "policy";
  reply: string;
  evidence_chunks: KBFullChunk[];
  structured_facts?: Array<{ field: string; value: string | number; model: string; document_id: string; chunk_id: string }>;
  unresolved_fact_fields?: Array<"stock">;
  price_fact?: { model: string; value: number; currency: "HKD"; document_id: string; chunk_id: string; full_content: string };
}

type Language = "zh-TW" | "zh-CN" | "en";

export function exactKbModelIds(text: string): string[] {
  return [...new Set((text.normalize("NFKC").toUpperCase().match(
    /\b(?:[A-Z][A-Z0-9]*-[A-Z0-9]+(?:-[A-Z0-9]+)*|[A-Z]{2,}[A-Z0-9]*\d{2,}[A-Z0-9]*)\b/g,
  ) ?? []).filter((id) => /\d/.test(id)))];
}

// Adjacent fields in exported product rows can omit separators altogether.
// Keep this vocabulary for that case; separated fields also use the generic
// label boundary below, so new exported columns cannot run into known values.
const ADJACENT_KB_LABELS = /商品型號|商品型号|產品型號|产品型号|商品圖片|商品图片|銷售價|销售价|售價|售价|特價|特价|成本|品牌|描述|產品描述|产品描述|附加項目|附加项目|新增日期|标签|標籤|功能|匹數|匹数|氣體|气体|風數|风数|庫存|库存|selling\s*price|list\s*price|product\s*(?:name|model)|description|brand|stock|price|dimension|weight|power|voltage|capacity|尺寸|重量|功率|電壓|电压|噪音|容量|退貨政策|退货政策|保養政策|保修政策|return\s+policy|warranty\s+policy/i;
const SEPARATED_KB_LABEL = /^([\p{Script=Han}]{1,12}(?:\s*\([^)]{1,30}\))?|[a-z][a-z ]{0,25})\s*[:=]/iu;
const ADJACENT_KB_FIELD = new RegExp(`^(?:${ADJACENT_KB_LABELS.source})\\s*[:=]`, "iu");
const KNOWN_KB_LABEL_IN_TEXT = new RegExp(ADJACENT_KB_LABELS.source, "iu");

function separatedFieldStarts(text: string): boolean {
  const match = SEPARATED_KB_LABEL.exec(text);
  if (!match) return false;
  const embedded = KNOWN_KB_LABEL_IN_TEXT.exec(match[1]);
  // "樂聲牌銷售價:" is a value followed by an adjacent known label, not
  // a new unknown field named "樂聲牌銷售價".
  return !embedded || embedded.index === 0;
}

function labelledValue(content: string, labels: RegExp, policy = false, money = false): string | null {
  const line = content.normalize("NFKC");
  let match = new RegExp(`(?:^|[\\s|;,])(?:${labels.source})\\s*[:=]\\s*`, "iu").exec(line);
  if (!match) {
    // An exported row may concatenate two labelled fields without whitespace.
    // Only accept that form after another complete, recognized field.
    const adjacent = new RegExp(`(?:${labels.source})\\s*[:=]\\s*`, "giu");
    for (const candidate of line.matchAll(adjacent)) {
      if (candidate.index > 0 &&
        new RegExp(`(?:^|[\\s|;,])(?:${ADJACENT_KB_LABELS.source})\\s*[:=]`, "iu").test(line.slice(0, candidate.index))) {
        match = candidate;
        break;
      }
    }
  }
  if (!match) return null;
  const start = match.index + match[0].length;
  if (separatedFieldStarts(line.slice(start))) return null;
  let end = Math.min(line.length, start + 500);
  for (let i = start; i < end; i++) {
    // A comma between digits belongs to the amount, including malformed
    // grouping that the strict money parser must reject rather than truncate.
    const numericComma = money && line[i] === "," && /\d/.test(line[i - 1] ?? "") && /\d/.test(line[i + 1] ?? "");
    if (!numericComma && (policy ? /[\n\r|]/u : /[\n\r|;,]/u).test(line[i])) { end = i; break; }
    if (i > start && /\s/u.test(line[i - 1]) && separatedFieldStarts(line.slice(i))) {
      end = i - 1;
      break;
    }
    // A known label immediately following the value has no punctuation or
    // whitespace boundary. Require a complete label and its delimiter.
    if (i > start && ADJACENT_KB_FIELD.test(line.slice(i))) {
      end = i;
      break;
    }
  }
  const value = line.slice(start, end).trim();
  return value && !/^(?:unknown|n\/a|未提供|待定)$/i.test(value)
    ? money ? value : value.slice(0, policy ? 500 : 90)
    : null;
}

const SELLING_PRICE_LABEL = /銷售價|销售价|售價|售价|selling\s*price|list\s*price|price/i;

function kbSellingPriceFields(content: string): { has_field: boolean; price: number | null } {
  const line = content.normalize("NFKC");
  const values: number[] = [];
  let hasField = false;
  // Consume qualified non-selling labels whole so their trailing "price"
  // cannot masquerade as an ordinary price field.
  const labels = new RegExp(`(?:cost\\s*price|special\\s*price|${SELLING_PRICE_LABEL.source})\\s*[:=]\\s*`, "giu");
  for (const match of line.matchAll(labels)) {
    if (/^(?:cost|special)\s*price/i.test(match[0])) continue;
    const prefix = line.slice(0, match.index);
    if (prefix && !/[\s|;,]$/u.test(prefix) &&
      !new RegExp(`(?:^|[\\s|;,])(?:${ADJACENT_KB_LABELS.source})\\s*[:=]`, "iu").test(prefix)) continue;
    hasField = true;
    const raw = labelledValue(line.slice(match.index), SELLING_PRICE_LABEL, false, true);
    // The entire field must be one HKD-compatible amount. Do not reinterpret
    // a foreign suffix, range, malformed grouping or partial prefix as HKD.
    const amount = raw?.match(/^(?:HK\$|HKD|\$)?\s*((?:[1-9]\d{0,2}(?:,\d{3})+|(?:0|[1-9]\d{0,7}))(?:\.\d{1,2})?)\s*(?:港元|元|HKD)?$/i);
    if (!amount) return { has_field: true, price: null };
    const value = Number(amount[1].replace(/,/g, ""));
    if (!Number.isFinite(value) || value <= 0) return { has_field: true, price: null };
    values.push(value);
  }
  // Never pick the first price in a conflicting field set or a multi-model
  // chunk: there is no row-to-model price binding for either case.
  const price = new Set(values).size === 1 && exactKbModelIds(line).length <= 1 ? values[0] : null;
  return { has_field: hasField, price };
}

export function currentKbSellingPrice(content: string): number | null {
  return kbSellingPriceFields(content).price;
}

function safeProductDescription(content: string, model: string): string | null {
  const raw = labelledValue(content, /描述|產品描述|产品描述|description/i);
  if (!raw || /(?:成本|特價|特价|銷售價|售价|庫存|库存|stock|<|>)/i.test(raw)) return null;
  const afterModel = raw.toUpperCase().indexOf(model);
  const detail = (afterModel >= 0 ? raw.slice(afterModel + model.length) : raw)
    .replace(/^[\s,，:：.\-]+/, "").replace(/\s+/g, " ").trim();
  return detail && detail.length <= 80 ? detail : null;
}

// Rendering authority is deliberately smaller than evidence authority: only
// recognized source terms may be expressed in English. Unrecognized product
// prose is omitted, never passed through as mixed-language text or guessed.
function englishProductDescription(description: string | null): string | null {
  if (!description) return null;
  let rest = description.normalize("NFKC").trim();
  const terms: string[] = [];
  const horsepower = /^(\d+(?:\.\d+)?(?:\/\d+)?)\s*(?:匹|HP)\s*/iu.exec(rest);
  if (horsepower) {
    terms.push(`${horsepower[1]} HP`);
    rest = rest.slice(horsepower[0].length);
  }
  const inverter = /^Inverter\s+LITE\s*/iu.exec(rest);
  if (inverter) {
    terms.push("Inverter LITE");
    rest = rest.slice(inverter[0].length);
  }
  const variable = /^變頻式?\s*/u.exec(rest);
  if (variable) {
    if (!inverter) terms.push("inverter");
    rest = rest.slice(variable[0].length);
  }
  const cooling = /^淨冷\s*/u.exec(rest);
  if (cooling) {
    terms.push("cooling-only");
    rest = rest.slice(cooling[0].length);
  }
  const windowUnit = /^窗口(?:式)?(?:冷氣)?機\s*/u.exec(rest);
  if (windowUnit) {
    terms.push("window air conditioner");
    rest = rest.slice(windowUnit[0].length);
  }
  return !rest && terms.length ? terms.join(" ") : null;
}

function englishProductFeatures(features: string | null): string | null {
  if (!features) return null;
  const tokens = features.normalize("NFKC").trim().split(/[\s,，、;；]+/u);
  const vocabulary: Record<string, string> = { "變頻": "inverter", "變頻式": "inverter", "淨冷": "cooling-only" };
  return tokens.length && tokens.every((token) => token in vocabulary)
    ? [...new Set(tokens.map((token) => vocabulary[token]))].join(" and ")
    : null;
}

// A mixed-language brand field can contain a grounded Latin brand followed by
// a local-market alias. English output may retain that exact Latin identity;
// it must not translate or transliterate the alias. If no unambiguous Latin
// prefix exists, the verified model alone is the safe product identity.
function customerProductIdentity(brand: string | null, model: string, language: Language): string {
  const safeBrand = brand && !/[\d$<>]/.test(brand) && brand.length <= 40 ? brand : null;
  if (language !== "en") return [safeBrand, model].filter(Boolean).join(" ");
  const latin = safeBrand?.normalize("NFKC").trim().match(
    /^([A-Za-z][A-Za-z0-9&.'-]*(?:\s+(?:&\s+)?[A-Za-z][A-Za-z0-9&.'-]*)*)(?=\s*[\p{Script=Han}]|$)/u,
  )?.[1] ?? null;
  return [latin, model].filter(Boolean).join(" ");
}

/** Source-bound Full Content; only verified currentness can produce price proof. */
export function resolveCanonicalKbDirectAnswer(input: {
  request: string;
  selection: CanonicalGroundingResult;
  language: Language;
  customer_context?: { model: string; sunlight?: unknown };
}): CanonicalKbDirectAnswer | null {
  const { selection, language } = input;
  // The authenticated Singapore RAG service may return a published source with
  // unknown price currentness. Keep the original current-price proof gate:
  // an unknown source can only support an explicitly qualified *recorded*
  // price reference, never a current selling-price or merchant quotation.
  const decision = selection.ok ? selection.authority_decision : null;
  const currentVerified = decision?.provenance.currentness === "current";
  const publishedReferenceOnly = decision?.decision === "USE_CURRENT_KB" &&
    decision.provenance.currentness === "unknown" &&
    decision.selected_authority_class === "PUBLISHED_KB_SERVICE";
  if (!selection.ok || !selection.document ||
    decision?.decision !== "USE_CURRENT_KB" ||
    (!currentVerified && !publishedReferenceOnly) ||
    decision.conflict_source_ids.length ||
    decision.selected_source_id !== selection.document.document_id) return null;

  const request = input.request.normalize("NFKC");
  const requested = classifyProductFactualQuery(request);
  const ids = exactKbModelIds(request);
  const nameTarget = ids.length === 0 ? namedPriceProductLabel(request) : null;
  if (publishedReferenceOnly && !nameTarget && (!requested || requested.facts.length !== 1 ||
    requested.facts[0] !== "price")) return null;
  // A model or an exact source-owned name, never multiple competing products.
  if (ids.length !== 1 && !nameTarget) return null;
  const model = nameTarget ?? ids[0];
  const chunks = selection.chunks.filter((chunk) =>
    chunk.chunk_type === "full_content" &&
    // Authenticated RAG service binds its own published/live selection even
    // when its public payload omits a publication-status field. Never convert
    // unknown currentness into a verified current price or allow a historical
    // document. The out-of-band service authority is required above.
    (chunk.status === "published" || publishedReferenceOnly && chunk.status === "unknown") &&
    chunk.document_id === selection.document!.document_id &&
    Boolean(chunk.chunk_id) &&
    (nameTarget ? exactNamedProductEvidence(nameTarget, selection.document!, chunk) :
      exactKbModelIds(chunk.content).includes(model)) &&
    selection.evidence.some((e) =>
      e.document_id === chunk.document_id && e.chunk_id === chunk.chunk_id &&
      e.content === chunk.content
    )
  );
  if (!chunks.length) return null;
  const productRecord = /product|商品|產品|产品/i.test(selection.document.source_type) ||
    chunks.some((chunk) => /(?:商品型號|商品型号|產品型號|产品型号|product\s*(?:name|model|entry))/i.test(chunk.content));
  const identityVerified = nameTarget ? chunks.some(chunk =>
    exactNamedProductEvidence(nameTarget, selection.document!, chunk)) :
    exactKbModelIds(selection.document.title).includes(model) ||
    chunks.some((chunk) => {
      const field = labelledValue(chunk.content,
        /商品型號|商品型号|產品型號|产品型号|product\s*(?:name|model)/i);
      return field !== null && exactKbModelIds(field).includes(model);
    });
  if (!identityVerified) return null;
  const stockRequested = /(?:現貨|现货|庫存|库存|in stock)/i.test(request);
  const stockNote = language === "en"
    ? "The current product record does not establish live stock; availability still needs merchant confirmation."
    : language === "zh-CN" ? "现行产品资料未确认实时库存；现货仍需商家核实。"
    : "現行產品資料未確認即時庫存；現貨仍需商家核實。";
  const evidence = (kind: CanonicalKbDirectAnswer["kind"], reply: string, chunk: KBFullChunk, requestedFields: Array<[string, string]> = []): CanonicalKbDirectAnswer => {
    if (stockRequested && kind !== "stock_unknown") reply += ` ${stockNote}`;
    if (input.customer_context?.model === model && input.customer_context.sunlight === "strong_afternoon_sun" &&
      classifyProductFactualQuery(request)?.facts.includes("suitability")) {
      reply = language === "en"
        ? reply.replace("Suitability needs the manufacturer’s applicable area guidance and a site assessment.", "You have already described strong afternoon sun. That cooling load needs to be considered with the manufacturer's applicable room area and a site assessment; horsepower alone cannot guarantee suitability.")
        : reply.replace(/需要廠方適用面積資料同現場評估。|需要厂方适用面积资料和现场评估。/u, language === "zh-CN"
          ? "你已说明下午日晒较强；下一步是结合厂方适用面积和现场评估，不能只按匹数保证够用。"
          : "你已提到下午日照強；下一步係連同廠方適用面積及現場評估，唔會單靠匹數保證夠用。");
    }
    const fields: Array<[string, string | number | null]> = [
      ["model", model],
      ["horsepower", labelledValue(chunk.content, /匹數|匹数|horsepower/i)],
      ["features", labelledValue(chunk.content, /功能|features?/i)],
      ["policy", labelledValue(chunk.content, /billing\s+policy|booking\s+policy|cancellation\s+policy|付款政策|預約政策|预约政策|取消政策/i, true)],
      ...requestedFields,
    ];
    return { kind, reply, evidence_chunks: [chunk], unresolved_fact_fields: stockRequested ? ["stock"] : [], structured_facts: chunk.chunk_id
      ? fields.filter(([, value]) => value !== null).map(([field, value]) => ({
        field, value: value!, model, document_id: chunk.document_id, chunk_id: chunk.chunk_id!,
      })) : [] };
  };
  if (nameTarget) {
    const values = chunks.map(chunk => ({chunk, value:kbProductRecordPrice(parseKbProductRecord(chunk.content))}));
    const present = values.filter(row => row.value.has_field);
    const usable = present.filter(row => row.value.reason === "ok" && row.value.amount !== null);
    const consistent = usable.length > 0 && usable.length === present.length &&
      new Set(usable.map(row=>`${row.value.amount}:${row.value.currency}`)).size === 1;
    if (consistent) {
      const chosen = usable[0], value = chosen.value;
      const amount = value.amount!.toLocaleString("en-US", {maximumFractionDigits:2});
      const display = value.currency === "HKD" ? `HK$${amount}` : amount;
      const currencyNote = value.currency ? "" : language === "en" ? " (currency not specified by the source)"
        : language === "zh-CN" ? "（来源未注明币别）" : "（來源未註明幣別）";
      const reply = language === "en"
        ? `The published product record for ${model} contains a selling-price field recording ${display}${currencyNote}. This source-recorded amount is not a formal quotation. The current price is unverified; the checkout price still needs merchant verification.`
        : language === "zh-CN"
        ? `${model} 的已发布商品资料中，价格栏位记录 ${display}${currencyNote}。这只是来源记录，尚未核实现价，并非正式报价；实际结算价仍待商家核实。`
        : `${model} 嘅已發布商品資料中，價格欄位記錄 ${display}${currencyNote}。呢個只係來源記錄，未核實係現價，並非正式報價；實際結帳價仍待商家核實。`;
      return evidence("listed_price_unverified", reply, chosen.chunk);
    }
    return evidence("price_unknown", language === "en"
      ? `I found a published product record for ${model}, but its price/currency fields are missing, conflicting or unsupported. The current price remains unverified.`
      : language === "zh-CN" ? `我找到 ${model} 的已发布商品记录，但价格或币别缺漏、冲突或未能核实；暂时不能当作现价。`
      : `我搵到 ${model} 嘅已發布商品記錄，但價格或幣別缺漏、衝突或未能核實；暫時唔會當成現價。`, chunks[0]);
  }

  const priceFields = chunks.map((chunk) => ({ chunk, ...kbSellingPriceFields(chunk.content) }));
  const priceCandidates = priceFields
    .filter((value): value is { chunk: KBFullChunk; has_field: boolean; price: number } => value.price !== null);
  // Conflicting selling-price fields in one selected published document are
  // unresolved; rank/first-hit ordering is never a price authority.
  const consistentPrice = !priceFields.some(item => item.has_field && item.price === null) &&
    new Set(priceCandidates.map(item => item.price)).size === 1;
  const priceEvidence = consistentPrice ? priceCandidates[0] : undefined;
  const priceFact = currentVerified && !nameTarget && priceEvidence &&
      selection.authority_decision.provenance.region === "hong_kong" && priceEvidence.chunk.chunk_id
    ? { model, value: priceEvidence.price, currency: "HKD" as const,
      document_id: priceEvidence.chunk.document_id, chunk_id: priceEvidence.chunk.chunk_id,
      full_content: priceEvidence.chunk.content }
    : null;
  const displayPrice = priceFact ? `HK$${priceFact.value.toLocaleString("en-US")}` : null;

  // No new remote query or model dispatch: the chosen published Full Content
  // already binds tenant, document, chunk, requested model and exact field.
  // This branch neither creates B2 current-price proof nor asserts stock,
  // checkout/quotation status, version, or present-day validity.
  if (publishedReferenceOnly || nameTarget) {
    // A name-only match remains a source-recorded reference, even when the
    // source says current. B2's exact-model current-price proof is not widened.
    if (!productRecord) return null;
    if (priceEvidence && selection.authority_decision.provenance.region === "hong_kong") {
      const recordedPrice = `HK$${priceEvidence.price.toLocaleString("en-US")}`;
      const reply = language === "en"
        ? `The published product record for ${model} contains a selling-price field recording ${recordedPrice}. This source-recorded amount is not a formal quotation. The current price is unverified; the checkout price still needs merchant verification.`
        : language === "zh-CN"
        ? `${model} 的已发布商品资料中，「销售价」栏位记录 ${recordedPrice}。这只是来源记录，尚未核实现价，并非正式报价；实际结算价仍待商家核实。`
        : `${model} 嘅已發布商品資料中，「銷售價」欄位記錄 ${recordedPrice}。呢個只係來源記錄，未核實係現價，並非正式報價；實際結帳價仍待商家核實。`;
      return evidence("listed_price_unverified", reply, priceEvidence.chunk);
    }
    return evidence("price_unknown", language === "en"
      ? `I found a published product record for ${model}, but a reliable price/currency could not be established from its source fields. The current selling price is unknown pending merchant verification.`
      : language === "zh-CN"
      ? `我找到 ${model} 的已发布商品记录，但价格、币别或来源记录有待核实；暂时不能当作现价，实际结算价仍待商家核实。`
      : `我搵到 ${model} 嘅已發布商品記錄，但價格、幣別或來源紀錄未能可靠核實；暫時唔會當成現價，實際結帳價仍待商家核實。`, chunks[0]);
  }

  if (stockRequested && !classifyProductFactualQuery(request)) {
    if (!productRecord) return null;
    const reply = language === "en"
      ? `I found a product record for ${model}, but it does not establish the live stock quantity. The current stock needs to be checked before purchase.`
      : language === "zh-CN"
      ? `我找到 ${model} 的产品记录，但现有资料未确认实时库存数量；购买前需要再核实现货。`
      : `我搵到 ${model} 嘅產品記錄，但現有資料未確認即時庫存數量；購買前需要再核實現貨。`;
    return evidence("stock_unknown", reply, chunks[0]);
  }

  if (classifyProductFactualQuery(request)?.facts.includes("price") && (classifyProductFactualQuery(request)?.facts.length ?? 1) <= 1) {
    if (!productRecord) return null;
    if (priceFact && displayPrice && priceEvidence) {
      return { ...evidence("price", language === "en"
        ? `The current product record lists ${model} at ${displayPrice}. Please confirm the checkout price before purchase.`
        : language === "zh-CN"
        ? `目前产品资料列出 ${model} 售价为 ${displayPrice}；实际结算价请再确认。`
        : `目前產品資料列出 ${model} 售價為 ${displayPrice}；實際結帳價請再確認。`, priceEvidence.chunk), price_fact: priceFact };
    }
    return evidence("price_unknown", language === "en"
      ? `I found a product record for ${model}, but it does not state a verifiable selling price.`
      : language === "zh-CN"
      ? `我找到 ${model} 的产品记录，但资料没有可核实的售价。`
      : `我搵到 ${model} 嘅產品記錄，但資料冇可核實嘅售價。`, chunks[0]);
  }

  if (/(?:有沒有|有没有|有冇|有無|有无|do\s+you\s+(?:have|carry)|available)/i.test(request) && !classifyProductFactualQuery(request)) {
    if (!productRecord) return null;
    const selected = priceEvidence?.chunk ?? chunks[0];
    const brand = labelledValue(selected.content, /品牌|brand/i);
    const description = safeProductDescription(selected.content, model);
    const product = customerProductIdentity(brand, model, language);
    const detail = description ? `，${description}` : "";
    const englishDescription = englishProductDescription(description);
    const pricePhrase = displayPrice ? (language === "en" ? ` The listed selling price is ${displayPrice}.` : `產品資料售價為 ${displayPrice}。`) : "";
    const reply = language === "en"
      ? `Yes, ${product} is listed in our product records.${englishDescription ? ` It is described as a ${englishDescription}.` : ""}${pricePhrase} Live stock has not been confirmed.`
      : language === "zh-CN"
      ? `有，${product}${detail}。${pricePhrase}现有资料未确认实时库存。`
      : `有，${product}${detail}。${pricePhrase}現有資料未確認即時庫存。`;
    return { ...evidence(priceFact ? "price" : "product_record", reply, selected),
      ...(priceFact ? { price_fact: priceFact } : {}) };
  }

  const factual = classifyProductFactualQuery(request);
  if (factual && productRecord && factual.product === model) {
    // Only the selected Full Content may supply a product description, brand
    // or selling price. Do not infer recommended room area from horsepower.
    const selected = priceEvidence?.chunk ?? chunks[0];
    const brand = labelledValue(selected.content, /品牌|brand/i);
    const description = safeProductDescription(selected.content, model);
    const summary = description?.split(/[，,。]/u)[0]?.trim() || null;
    const englishSummary = englishProductDescription(summary);
    const featureField = labelledValue(selected.content, /功能|features?/i);
    const safeFeatures = featureField && featureField.length <= 50 &&
      !/(?:成本|特價|特价|售價|售价|庫存|库存|stock|[$<>])/i.test(featureField)
      ? featureField : null;
    const horsepower = summary?.match(/(?:^|[^\d])(\d+(?:\.\d+)?(?:\/\d+)?)\s*(?:匹|HP)/iu)?.[1] ?? null;
    const product = customerProductIdentity(brand, model, language);
    const requestedFacts = new Set(factual.facts);

    if (requestedFacts.size > 1) {
      const rawRoom = request.match(/\b\d{1,4}\s*(?:平方[呎尺]|[呎尺]|sq\.?\s*ft|square\s*feet)/iu)?.[0] ?? null;
      const room = language === "en" ? rawRoom?.replace(/平方[呎尺]|[呎尺]/u, " sq ft") ?? null : rawRoom;
      const includeProductDetail = requestedFacts.has("features") || requestedFacts.has("model_info");
      const includePrice = requestedFacts.has("price");
      const detailSummary = requestedFacts.has("horsepower") && horsepower
        ? summary?.replace(new RegExp(`${horsepower.replace("/", "\\/")}\\s*(?:匹|HP)\\s*`, "iu"), "").trim() ?? null : summary;
      const detailEnglish = englishProductDescription(detailSummary);
      const parts: string[] = [];
      if (language === "en") {
        if (includeProductDetail) {
          if (detailEnglish || englishProductFeatures(safeFeatures)) {
            const translatedFeatures = englishProductFeatures(safeFeatures);
            parts.push(`The current product record describes ${product}${detailEnglish ? ` as ${detailEnglish}` : ""}${translatedFeatures ? `; its listed features are ${translatedFeatures}` : ""}.`);
          } else parts.push(`The current product record does not provide verifiable English feature details for ${product}.`);
        }
        if (requestedFacts.has("horsepower")) {
          parts.push(horsepower
            ? `${product} is listed as ${horsepower} HP.`
            : `The current product information does not state verifiable horsepower for ${product}.`);
        }
        if (includePrice) {
          parts.push(displayPrice
            ? `The product record lists a selling price of ${displayPrice}.`
            : `The current product information does not state a verifiable selling price.`);
        }
        if (requestedFacts.has("suitability")) {
          parts.push(`The current product information does not directly state a suitable room area, so I cannot confirm whether it is sufficient${room ? ` for ${room}` : " for that room"}. Suitability needs the manufacturer’s applicable area guidance and a site assessment.`);
        }
      } else if (language === "zh-CN") {
        if (includeProductDetail) {
          parts.push(detailSummary || safeFeatures
            ? `现行产品资料列出 ${product}${detailSummary ? `：${detailSummary}` : ""}${safeFeatures ? `；功能：${safeFeatures}` : ""}。`
            : `现有产品资料未有列出 ${product} 的可核实功能。`);
        }
        if (requestedFacts.has("horsepower")) parts.push(horsepower
          ? `${product} 的匹数为 ${horsepower}匹。`
          : `现有产品资料未有列出 ${product} 的可核实匹数。`);
        if (includePrice) parts.push(displayPrice
          ? `产品资料售价为 ${displayPrice}。`
          : "现有产品资料未有列出可核实售价。");
        if (requestedFacts.has("suitability")) parts.push(`现有产品资料未直接列出适用面积，所以不能确认${room ? `${room}房间` : "这个房间"}是否够用；需要厂方适用面积资料和现场评估。`);
      } else {
        if (includeProductDetail) {
          parts.push(detailSummary || safeFeatures
            ? `現行產品資料列出 ${product}${detailSummary ? `：${detailSummary}` : ""}${safeFeatures ? `；功能：${safeFeatures}` : ""}。`
            : `現有產品資料未有列出 ${product} 嘅可核實功能。`);
        }
        if (requestedFacts.has("horsepower")) parts.push(horsepower
          ? `${product} 嘅匹數係 ${horsepower}匹。`
          : `現有產品資料未有列出 ${product} 嘅可核實匹數。`);
        if (includePrice) parts.push(displayPrice
          ? `產品資料售價為 ${displayPrice}。`
          : "現有產品資料未有列出可核實售價。");
        if (requestedFacts.has("suitability")) parts.push(`現有產品資料未有直接列出適用面積，所以未能確認${room ? `${room}房` : "呢間房"}夠唔夠用；需要廠方適用面積資料同現場評估。`);
      }
      if (!parts.length) return null;
      const kind: CanonicalKbDirectAnswer["kind"] = includePrice && priceFact
        ? "price"
        : requestedFacts.has("horsepower")
        ? "specification"
        : "product_record";
      return {
        ...evidence(kind, parts.join(" "), selected),
        ...(includePrice && priceFact ? { price_fact: priceFact } : {}),
      };
    }

    if (factual.fact === "horsepower") {
      if (!horsepower) return null;
      return evidence("specification", language === "en"
        ? `${product} is listed as ${horsepower} HP in the current product description.`
        : language === "zh-CN"
        ? `现行产品描述列出 ${product} 为 ${horsepower}匹。`
        : `現行產品描述列出 ${product} 係 ${horsepower}匹。`, selected);
    }
    if (factual.fact === "features" || factual.fact === "model_info" ||
      (factual.fact === "specification" && /(?:規格|规格|specs?)/iu.test(request))) {
      if (!summary) return null;
      const detail = factual.fact === "features" && safeFeatures
        ? `${summary}；${language === "en" ? "features" : "功能"}：${safeFeatures}`
        : summary;
      const englishFeatures = factual.fact === "features" ? englishProductFeatures(safeFeatures) : null;
      if (language === "en" && !englishSummary && !englishFeatures) return null;
      return evidence("product_record", language === "en"
        ? `The current product record describes ${product}${englishSummary ? ` as ${englishSummary}` : ""}${englishFeatures ? `; its listed features are ${englishFeatures}` : ""}.`
        : language === "zh-CN"
        ? `现行产品资料列出 ${product}：${detail}。`
        : `現行產品資料列出 ${product}：${detail}。`, selected);
    }
    if (factual.fact === "suitability") {
      if (!summary && language !== "en") return null;
      const rawRoom = request.match(/\b\d{1,4}\s*(?:平方[呎尺]|[呎尺]|sq\.?\s*ft|square\s*feet)/iu)?.[0] ?? null;
      const room = language === "en" ? rawRoom?.replace(/平方[呎尺]|[呎尺]/u, " sq ft") ?? null : rawRoom;
      const reply = language === "en"
        ? `${product}${englishSummary ? ` is listed as a ${englishSummary}` : " has a current product record"}. The current product information does not directly state a suitable room area, so I cannot confirm whether it is sufficient${room ? ` for ${room}` : " for that room"}. Suitability needs the manufacturer’s applicable area guidance and a site assessment.`
        : language === "zh-CN"
        ? `${product} 是${summary}。现有产品资料未直接列出适用面积，所以不能确认${room ? `${room}房间` : "这个房间"}是否够用；需要厂方适用面积资料和现场评估。`
        : `${product} 係${summary}。現有產品資料未有直接列出適用面積，所以未能確認${room ? `${room}房` : "呢間房"}夠唔夠用；需要廠方適用面積資料同現場評估。`;
      return evidence("product_record", reply, selected);
    }
  }

  // Exact field questions must have an explicit matching label and value in
  // the selected evidence. Broad requests for all specifications stay on the
  // existing route rather than synthesizing a product sheet.
  const specField = request.match(/(?:的|嘅|\s)(尺寸|重量|功率|電壓|电压|噪音|容量|dimension|weight|power|voltage|capacity)(?:\s|係|是|幾|几|多少|\?|？|$)/i)?.[1];
  if (specField) {
    const fields: Record<string, [string, string]> = {
      尺寸: ["dimension", "尺寸"], dimension: ["dimension", "尺寸"],
      重量: ["weight", "重量"], weight: ["weight", "重量"],
      功率: ["power", "功率"], power: ["power", "功率"],
      電壓: ["voltage", "電壓"], 电压: ["voltage", "電壓"], voltage: ["voltage", "電壓"],
      噪音: ["noise", "噪音"], 容量: ["capacity", "容量"], capacity: ["capacity", "容量"],
    };
    const [field, display] = fields[specField.toLowerCase()];
    for (const chunk of chunks) {
      const value = labelledValue(chunk.content, new RegExp(specField, "i"));
      if (value) return evidence("specification", language === "en"
        ? `${model}: ${field} ${value} (current product record).`
        : `${model} 嘅${display}：${value}（現行產品資料）。`, chunk, [[field, value]]);
    }
  }

  const policyField = request.match(/(?:退貨政策|退货政策|保養政策|保修政策|付款政策|預約政策|预约政策|取消政策|(?:billing|booking|cancellation|return|warranty)\s+policy)/i)?.[0];
  if (policyField) {
    for (const chunk of chunks) {
      if (!/policy|政策|條款|条款/i.test(chunk.source_type)) continue;
      const value = labelledValue(chunk.content, new RegExp(policyField.replace(/\s+/g, "\\s+"), "i"), true);
      if (value) return evidence("policy", language === "en"
        ? `The current policy for ${model} states: ${value}.`
        : `現行資料列出 ${model} 嘅${policyField}：${value}。`, chunk, [["policy", value]]);
    }
  }
  return null;
}
