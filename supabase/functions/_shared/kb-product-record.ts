/** A single source-owned catalogue record, never a synthesized product.
 * CSV/XLSX and JSON imports preserve their column keys. The displayed document
 * title can legitimately be "Row N"; it is not the product's identity.
 * This parser does not grant publication, tenant or current-price authority.
 */
export type KbProductField = { key: string; value: string };
export type KbProductRecord = {
  fields: KbProductField[];
  names: string[];
  models: string[];
  ambiguous: boolean;
  format: "labelled" | "json" | "markdown" | "unsupported";
};
const NAME_KEYS = new Set(["name", "title", "product", "productname", "producttitle", "itemname",
  "名稱", "名称", "標題", "标题", "商品名稱", "商品名称", "產品名稱", "产品名称", "商品名", "產品名", "产品名", "品名"]);
const MODEL_KEYS = new Set(["model", "productmodel", "itemmodel", "商品型號", "商品型号", "產品型號", "产品型号", "型號", "型号"]);
const PRICE_KEYS = new Set(["price", "sellingprice", "saleprice", "salesprice", "listprice", "retailprice", "unitprice",
  "銷售價", "销售价", "售價", "售价", "價格", "价格", "價錢", "价钱", "單價", "单价"]);
const CURRENCY_KEYS = new Set(["currency", "currencycode", "pricecurrency", "幣別", "币别", "貨幣", "货币", "貨幣代碼", "货币代码"]);
const normalized = (v: string) => v.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
export const kbProductFieldKey = (v: string) => normalized(v).replace(/_(?:[2-9]|\d{2,})$/u, "").replace(/[\s_-]/gu, "");
const empty = (): KbProductRecord => ({fields: [], names: [], models: [], ambiguous: false, format: "unsupported"});
// Multiword keys must precede the generic one-token key. Unknown columns are
// boundaries too, so a description/colour cannot become part of a product name.
const LABEL = /(?:^|[\s|;；,])((?:product|item)[ _-]*(?:name|title|model)|(?:selling|sales?|list|retail|unit|cost|special)[ _-]*price|(?:price[ _-]*)?currency(?:[ _-]*code)?|[\p{L}_][\p{L}\p{N}_-]{0,63}(?:[ \t]*\([^()\r\n]{1,40}\))?)\s*[:=]\s*/giu;

export function parseKbProductRecord(content: string): KbProductRecord {
  if (typeof content !== "string" || !content.trim() || content.length > 65536) return empty();
  const text = content.normalize("NFKC").trim();
  let fields: KbProductField[] = [];
  let format: KbProductRecord["format"] = "labelled";
  if (text.startsWith("{") || text.startsWith("[")) {
    // Only a flat object is one record. Arrays/nested related products are not.
    try {
      const obj: unknown = JSON.parse(text);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {...empty(), ambiguous: true};
      const entries = Object.entries(obj);
      if (entries.some(([, v]) => v !== null && typeof v === "object")) return {...empty(), ambiguous: true};
      // Reject duplicate raw JSON property keys; JSON.parse alone erases them.
      const keys = [...text.matchAll(/(?:^\s*\{|,)\s*("(?:[^"\\]|\\.)*")\s*:/gu)];
      if (keys.length !== entries.length) return {...empty(), ambiguous: true};
      fields = entries.filter(([, v]) => typeof v === "string" || typeof v === "number")
        .map(([key, value]) => ({key, value: String(value).trim()}));
      format = "json";
    } catch { return {...empty(), ambiguous: true}; }
  } else {
    const lines = text.split(/\r?\n/u).map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2 && /^\|?[\s:|-]+\|[\s:|-]*\|?$/u.test(lines[1])) {
      if (lines.length !== 3) return {...empty(), ambiguous: true};
      const cells = (l: string) => l.replace(/^\||\|$/gu, "").split("|").map(v => v.trim());
      const keys = cells(lines[0]), values = cells(lines[2]);
      if (keys.length !== values.length || keys.some(k => !k)) return {...empty(), ambiguous: true};
      fields = keys.map((key, i) => ({key, value: values[i]}));
      format = "markdown";
    } else {
      const matches = [...text.matchAll(LABEL)];
      if (!matches.length || text.slice(0, matches[0].index).trim()) return empty();
      let insideProse = false;
      fields = matches.flatMap((m, i) => {
        const strongBoundary = m.index === 0 || /^[\r\n|;；]/u.test(m[0]);
        if (strongBoundary) insideProse = false;
        if (insideProse) return [];
        const key = m[1].trim();
        insideProse = /^(?:description|details|notes?|remark|描述|商品描述|產品描述|产品描述|說明|说明|備註|备注)$/iu.test(key);
        return [{key, value: text.slice(m.index! + m[0].length, matches[i + 1]?.index ?? text.length)
          .replace(/[\s|;；]+$/gu, "").trim()}];
      });
    }
  }
  if (fields.length > 128) return {...empty(), ambiguous: true};
  const names: string[] = [], models: string[] = [];
  const seenIdentityKeys = new Set<string>();
  let ambiguous = false;
  for (const field of fields) {
    const key = kbProductFieldKey(field.key);
    if (!NAME_KEYS.has(key) && !MODEL_KEYS.has(key)) continue;
    if (seenIdentityKeys.has(key)) ambiguous = true;
    seenIdentityKeys.add(key);
    const value = normalized(field.value);
    if (!value || value.length > 160 || /^(?:unknown|n\/a|未提供|待定)$/iu.test(value)) continue;
    (NAME_KEYS.has(key) ? names : models).push(value);
  }
  const unique = (v: string[]) => [...new Set(v)];
  return {fields, names: unique(names), models: unique(models),
    ambiguous: ambiguous || unique(names).length > 1 || unique(models).length > 1, format};
}

export function kbProductRecordNames(record: KbProductRecord): string[] {
  // A non-model product can be stored in the merchant's model column. Exact
  // equality is still required; descriptions, generated synonyms and partial
  // names never establish identity.
  return record.ambiguous ? [] : record.names.length ? record.names : record.models;
}

export function kbProductRecordPrice(record: KbProductRecord): {
  has_field: boolean; amount: number | null; currency: "HKD" | null;
  field: string | null; reason: "ok" | "missing" | "ambiguous" | "invalid_or_unsupported_currency";
} {
  const prices = record.fields.filter(f => PRICE_KEYS.has(kbProductFieldKey(f.key)));
  const absent = {has_field: prices.length > 0, amount: null, currency: null, field: null} as const;
  if (record.ambiguous) return {...absent, reason: "ambiguous"};
  if (!prices.length) return {...absent, reason: "missing"};
  const declared = record.fields.filter(f => CURRENCY_KEYS.has(kbProductFieldKey(f.key)))
    .map(f => f.value.trim().toUpperCase());
  if (declared.some(v => !["HKD", "HK$", "港元", "港幣", "港币"].includes(v)))
    return {...absent, reason: "invalid_or_unsupported_currency"};
  const parsed = prices.map(f => {
    const m = /^(HK\$|HKD|\$)?\s*((?:[1-9]\d{0,2}(?:,\d{3})+|(?:0|[1-9]\d{0,7}))(?:\.\d{1,2})?)\s*(港元|港幣|港币|HKD)?$/iu.exec(f.value);
    if (!m) return null;
    const amount = Number(m[2].replace(/,/gu, ""));
    const explicit = declared.length > 0 || /^(?:HK\$|HKD)$/iu.test(m[1] ?? "") || Boolean(m[3]);
    // "$" without a source currency is ambiguous, not implicitly HKD.
    if (!Number.isFinite(amount) || amount <= 0 || amount > 99999999.99 ||
      !Number.isSafeInteger(Math.round(amount * 100)) || m[1] === "$" && !explicit) return null;
    return {amount, currency: explicit ? "HKD" as const : null};
  });
  if (parsed.some(p => p === null)) return {...absent, reason: "invalid_or_unsupported_currency"};
  const valid = parsed.filter((p): p is NonNullable<typeof p> => p !== null);
  if (new Set(valid.map(p => `${p.amount}:${p.currency}`)).size !== 1) return {...absent, reason: "ambiguous"};
  return {has_field: true, ...valid[0], field: prices[0].key.slice(0,64), reason: "ok"};
}
