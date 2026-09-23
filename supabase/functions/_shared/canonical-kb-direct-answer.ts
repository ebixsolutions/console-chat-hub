import type { CanonicalGroundingResult } from "./canonical-grounding.ts";
import type { KBFullChunk } from "./deterministic-kb-client.ts";

export interface CanonicalKbDirectAnswer {
  kind: "product_record" | "price" | "price_unknown" | "specification" | "policy";
  reply: string;
  evidence_chunks: KBFullChunk[];
  price_fact?: { model: string; value: number; currency: "HKD"; document_id: string; chunk_id: string; full_content: string };
}

type Language = "zh-TW" | "zh-CN" | "en";

export function exactKbModelIds(text: string): string[] {
  return [...new Set((text.normalize("NFKC").toUpperCase().match(
    /\b(?:[A-Z][A-Z0-9]*-[A-Z0-9]+(?:-[A-Z0-9]+)*|[A-Z]{2,}[A-Z0-9]*\d{2,}[A-Z0-9]*)\b/g,
  ) ?? []).filter((id) => /\d/.test(id)))];
}

function labelledValue(content: string, labels: RegExp): string | null {
  // Match a whole field label; stop before the next field on the same line.
  const line = content.normalize("NFKC");
  const match = line.match(new RegExp(
    `(?:^|[\\s|;,])(?:${labels.source})\\s*[:=]\\s*([^\\n\\r|;,]{1,100})`,
    "iu",
  ));
  if (!match) return null;
  const value = match[1].split(/\s+(?=(?:商品型號|商品型号|產品型號|产品型号|商品圖片|商品图片|成本|銷售價|销售价|售價|售价|特價|特价|品牌|描述|description|brand|stock|庫存|库存|price)\s*[:=])/iu)[0]
    .trim();
  return value && !/^(?:unknown|n\/a|未提供|待定)$/i.test(value)
    ? value.slice(0, 90)
    : null;
}

export function currentKbSellingPrice(content: string): number | null {
  const raw = labelledValue(content, /銷售價|销售价|售價|售价|selling\s*price|list\s*price|price/i);
  if (!raw) return null;
  if (/^(?:USD|US\$|SGD|S\$|NT\$|TWD)/i.test(raw)) return null;
  const amount = raw.match(/(?:HK\$|HKD\s*|\$)?\s*\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|(?:HK\$|HKD\s*|\$)?\s*\d{3,8}(?:\.\d{1,2})?/i);
  if (!amount || !/^\s*(?:HK\$|HKD\s*|\$)?\s*\d/i.test(raw)) return null;
  const remainder = raw.slice(amount[0].length).trim();
  if (remainder && !/^(?:元|港元|新幣|SGD|HKD)$/i.test(remainder)) return null;
  const value = Number(amount[0].replace(/[^\d.]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function safeProductDescription(content: string, model: string): string | null {
  const raw = labelledValue(content, /描述|產品描述|产品描述|description/i);
  if (!raw || /(?:成本|特價|特价|銷售價|售价|庫存|库存|stock|<|>)/i.test(raw)) return null;
  const afterModel = raw.toUpperCase().indexOf(model);
  const detail = (afterModel >= 0 ? raw.slice(afterModel + model.length) : raw)
    .replace(/^[\s,，:：.\-]+/, "").replace(/\s+/g, " ").trim();
  return detail && detail.length <= 80 ? detail : null;
}

/** A bounded fact from selected, published, current Full Content Evidence only. */
export function resolveCanonicalKbDirectAnswer(input: {
  request: string;
  selection: CanonicalGroundingResult;
  language: Language;
}): CanonicalKbDirectAnswer | null {
  const { selection, language } = input;
  if (!selection.ok || !selection.document ||
    selection.authority_decision.decision !== "USE_CURRENT_KB" ||
    selection.authority_decision.provenance.currentness !== "current" ||
    selection.authority_decision.conflict_source_ids.length ||
    selection.authority_decision.selected_source_id !== selection.document.document_id) return null;

  const request = input.request.normalize("NFKC");
  const ids = exactKbModelIds(request);
  // Never infer which of several models the customer meant.
  if (ids.length !== 1) return null;
  const model = ids[0];
  const chunks = selection.chunks.filter((chunk) =>
    chunk.chunk_type === "full_content" && chunk.status === "published" &&
    chunk.document_id === selection.document!.document_id &&
    Boolean(chunk.chunk_id) && exactKbModelIds(chunk.content).includes(model) &&
    selection.evidence.some((e) =>
      e.document_id === chunk.document_id && e.chunk_id === chunk.chunk_id &&
      e.content === chunk.content
    )
  );
  if (!chunks.length) return null;
  const productRecord = /product|商品|產品|产品/i.test(selection.document.source_type) ||
    chunks.some((chunk) => /(?:商品型號|商品型号|產品型號|产品型号|product\s*(?:name|model|entry))/i.test(chunk.content));
  const identityVerified = exactKbModelIds(selection.document.title).includes(model) ||
    chunks.some((chunk) => {
      const field = labelledValue(chunk.content,
        /商品型號|商品型号|產品型號|产品型号|product\s*(?:name|model)/i);
      return field !== null && exactKbModelIds(field).includes(model);
    });
  if (!identityVerified) return null;
  const evidence = (kind: CanonicalKbDirectAnswer["kind"], reply: string, chunk: KBFullChunk): CanonicalKbDirectAnswer =>
    ({ kind, reply, evidence_chunks: [chunk] });
  const priceEvidence = chunks.map((chunk) => ({ chunk, price: currentKbSellingPrice(chunk.content) }))
    .find(({ price }) => price !== null);
  const priceFact = priceEvidence?.price !== null && priceEvidence?.price !== undefined &&
      selection.authority_decision.provenance.region === "hong_kong" && priceEvidence.chunk.chunk_id
    ? { model, value: priceEvidence.price, currency: "HKD" as const,
      document_id: priceEvidence.chunk.document_id, chunk_id: priceEvidence.chunk.chunk_id,
      full_content: priceEvidence.chunk.content }
    : null;
  const displayPrice = priceFact ? `HK$${priceFact.value.toLocaleString("en-US")}` : null;

  if (/(?:售價|售价|賣幾錢|卖几钱|價錢|价钱|price|how\s+much)/i.test(request)) {
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

  if (/(?:有沒有|有没有|有冇|有無|有无|do\s+you\s+(?:have|carry)|available)/i.test(request)) {
    if (!productRecord) return null;
    const selected = priceEvidence?.chunk ?? chunks[0];
    const brand = labelledValue(selected.content, /品牌|brand/i);
    const safeBrand = brand && !/[\d$<>]/.test(brand) && brand.length <= 40 ? brand : null;
    const description = safeProductDescription(selected.content, model);
    const product = [safeBrand, model].filter(Boolean).join(" ");
    const detail = description ? `，${description}` : "";
    const pricePhrase = displayPrice ? (language === "en" ? ` The listed selling price is ${displayPrice}.` : `產品資料售價為 ${displayPrice}。`) : "";
    const reply = language === "en"
      ? `Yes, ${product}${description ? `: ${description}` : ""} is listed in our product records.${pricePhrase} Live stock has not been confirmed.`
      : language === "zh-CN"
      ? `有，${product}${detail}。${pricePhrase}现有资料未确认实时库存。`
      : `有，${product}${detail}。${pricePhrase}現有資料未確認即時庫存。`;
    return { ...evidence(priceFact ? "price" : "product_record", reply, selected),
      ...(priceFact ? { price_fact: priceFact } : {}) };
  }

  // Exact field questions must have an explicit matching label and value in
  // the selected evidence. Broad requests for all specifications stay on the
  // existing route rather than synthesizing a product sheet.
  const specField = request.match(/(?:的|嘅|\s)(尺寸|重量|功率|電壓|电压|噪音|容量|dimension|weight|power|voltage|capacity)(?:\s|係|是|幾|几|多少|\?|？|$)/i)?.[1];
  if (specField) {
    for (const chunk of chunks) {
      const value = labelledValue(chunk.content, new RegExp(specField, "i"));
      if (value) return evidence("specification", language === "en"
        ? `${model}: ${specField} ${value} (current product record).`
        : `${model} 嘅${specField}：${value}（現行產品資料）。`, chunk);
    }
  }

  const policyField = request.match(/(?:退貨政策|退货政策|保養政策|保修政策|return\s+policy|warranty\s+policy)/i)?.[0];
  if (policyField) {
    for (const chunk of chunks) {
      if (!/policy|政策|條款|条款/i.test(chunk.source_type)) continue;
      const value = labelledValue(chunk.content, new RegExp(policyField.replace(/\s+/g, "\\s+"), "i"));
      if (value) return evidence("policy", language === "en"
        ? `The current policy for ${model} states: ${value}.`
        : `現行資料列出 ${model} 嘅${policyField}：${value}。`, chunk);
    }
  }
  return null;
}
