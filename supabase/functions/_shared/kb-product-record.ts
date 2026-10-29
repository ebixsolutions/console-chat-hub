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
  spu_codes: string[];
  sku_codes: string[];
  variants: Record<string, string>;
  display_name: string | null;
  ambiguous: boolean;
  format: "labelled" | "json" | "markdown" | "unsupported";
};
const NAME_KEYS = new Set(["name", "title", "product", "productname", "producttitle", "itemname", "spuname", "skuname", "variantname",
  "名稱", "名称", "標題", "标题", "商品名稱", "商品名称", "產品名稱", "产品名称", "商品名", "產品名", "产品名", "品名"]);
const MODEL_KEYS = new Set(["model", "productmodel", "itemmodel", "商品型號", "商品型号", "產品型號", "产品型号", "型號", "型号"]);
const SPU_KEYS = new Set(["spu", "spucode", "spuid", "productcode", "parentcode", "商品主碼", "商品主码"]);
const SKU_KEYS = new Set(["sku", "skucode", "skuid", "variantcode", "variantid", "貨號", "货号", "商品編號", "商品编号"]);
const VARIANT_KEYS: Record<string, string> = {
  speccolor:"color", speccolour:"color", color:"color", colour:"color", 顏色:"color", 颜色:"color",
  specsize:"size", size:"size", 尺碼:"size", 尺码:"size", 尺寸:"size",
  specmaterial:"material", material:"material", 材質:"material", 材质:"material",
  speccapacity:"capacity", capacity:"capacity", 容量:"capacity",
};
const STOCK_KEYS = new Set(["stock", "stockqty", "stockquantity", "inventory", "inventoryqty", "inventoryquantity",
  "quantityavailable", "availablequantity", "availableqty", "庫存", "库存", "庫存量", "库存量", "庫存數量", "库存数量"]);
const PRICE_KEYS = new Set(["price", "sellingprice", "saleprice", "salesprice", "listprice", "retailprice", "unitprice",
  "銷售價", "销售价", "售價", "售价", "價格", "价格", "價錢", "价钱", "單價", "单价"]);
const CURRENCY_KEYS = new Set(["currency", "currencycode", "pricecurrency", "幣別", "币别", "貨幣", "货币", "貨幣代碼", "货币代码"]);
const normalized = (v: string) => v.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
export const kbProductFieldKey = (v: string) => normalized(v).replace(/_(?:[2-9]|\d{2,})$/u, "").replace(/[\s_-]/gu, "");
const empty = (): KbProductRecord => ({fields: [], names: [], models: [], spu_codes: [], sku_codes: [], variants: {}, display_name: null, ambiguous: false, format: "unsupported"});
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
        const strongBoundary = m.index === 0 || /^[\r\n|;；]/u.test(m[0]) ||
          /(?:^|[\r\n|;；])[ \t]*$/u.test(text.slice(0, m.index!));
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
  const names: string[] = [], models: string[] = [], spu: string[] = [], sku: string[] = [];
  const variants: Record<string,string> = {};
  const seenIdentityKeys = new Set<string>();
  let ambiguous = false, displayName: string | null = null;
  const primaryNames = fields.filter(f => kbProductFieldKey(f.key) === "spuname");
  for (const field of fields) {
    const key = kbProductFieldKey(field.key), dimension = Object.hasOwn(VARIANT_KEYS,key) ? VARIANT_KEYS[key] : undefined;
    if (!NAME_KEYS.has(key) && !MODEL_KEYS.has(key) && !SPU_KEYS.has(key) && !SKU_KEYS.has(key) && !dimension) continue;
    if (seenIdentityKeys.has(key)) ambiguous = true;
    seenIdentityKeys.add(key);
    const value = normalized(field.value);
    if (!value || value.length > 160 || /^(?:unknown|n\/a|未提供|待定)$/iu.test(value)) continue;
    // Plain values only: source markup, instructions and delimited identities
    // cannot be displayed as a product or become a cross-record join key.
    if (/[<>\r\n|;；]/u.test(value)) { ambiguous = true; continue; }
    if (dimension) {
      if (variants[dimension] && normalized(variants[dimension]) !== value) ambiguous = true;
      variants[dimension] = field.value;
    } else if (SPU_KEYS.has(key)) spu.push(normalizeCatalogueCode(value));
    else if (SKU_KEYS.has(key)) sku.push(normalizeCatalogueCode(value));
    else if (MODEL_KEYS.has(key)) models.push(value);
    else {
      if (!primaryNames.length || key === "spuname") {
        names.push(value);
        displayName ??= field.value;
      }
    }
  }
  const unique = (v: string[]) => [...new Set(v)];
  return {fields, names: unique(names), models: unique(models), spu_codes:unique(spu), sku_codes:unique(sku),
    variants, display_name:displayName,
    ambiguous: ambiguous || unique(names).length > 1 || unique(models).length > 1 || unique(spu).length > 1 || unique(sku).length > 1, format};
}

/** Punctuation/case normalization only; no removal of SKU dimensions. */
export function normalizeCatalogueCode(value: string): string {
  return value.normalize("NFKC").replace(/[‐‑‒–—−]/gu,"-").trim().toUpperCase();
}

export function kbProductRecordNames(record: KbProductRecord): string[] {
  // A non-model product can be stored in the merchant's model column. Exact
  // equality is still required; descriptions, generated synonyms and partial
  // names never establish identity.
  return record.ambiguous ? [] : record.names.length ? record.names : record.models;
}

export type KbRecordedPrice = {
  has_field: boolean; amount: number | null; currency: string | null;
  field: string | null; reason: "ok" | "missing" | "ambiguous" | "invalid_or_unsupported_currency";
};
// Explicit source currency only. Symbols with multiple currencies ($/¥/元)
// require an unambiguous ISO code or declaration; no FX conversion occurs.
const ISO_CURRENCIES = new Set(("HKD CNY USD TWD SGD EUR GBP JPY AUD CAD NZD KRW CHF MOP MYR THB IDR INR VND PHP AED SAR BND BRL MXN ZAR SEK NOK DKK PLN CZK HUF TRY ILS KWD BHD OMR QAR RUB PKR BDT LKR NPR EGP CLP COP PEN ARS ISK RON UAH").split(" "));
const CURRENCY_ALIASES: Record<string,string> = {
  "HK$":"HKD", "港元":"HKD", "港幣":"HKD", "港币":"HKD",
  "RMB":"CNY", "CN¥":"CNY", "人民幣":"CNY", "人民币":"CNY",
  "US$":"USD", "美元":"USD", "美金":"USD",
  "NT$":"TWD", "NTD":"TWD", "新台幣":"TWD", "新臺幣":"TWD", "新台币":"TWD",
  "S$":"SGD", "SG$":"SGD", "新加坡元":"SGD", "€":"EUR", "歐元":"EUR", "欧元":"EUR",
  "£":"GBP", "英鎊":"GBP", "英镑":"GBP", "JP¥":"JPY", "日圓":"JPY", "日元":"JPY",
  "A$":"AUD", "AU$":"AUD", "澳元":"AUD", "C$":"CAD", "CA$":"CAD", "加元":"CAD",
};
function currencyCode(raw: string): string | null {
  const v=raw.normalize("NFKC").trim().toUpperCase();
  return ISO_CURRENCIES.has(v) ? v : CURRENCY_ALIASES[v] ?? null;
}
const AMOUNT = /^(?:([A-Za-z]{1,3}[$¥]|[A-Za-z]{3}|[$¥€£]|[\p{Script=Han}]{1,5})\s*)?((?:[1-9]\d{0,2}(?:,\d{3})+|(?:0|[1-9]\d{0,7}))(?:\.\d{1,4})?)(?:\s*([A-Za-z]{1,3}[$¥]|[A-Za-z]{3}|[$¥€£]|[\p{Script=Han}]{1,5}))?$/u;
function parseRecordedAmount(raw: string, declared: string[]): {amount:number;currency:string|null} | null {
  const m=AMOUNT.exec(raw.trim());
  if (!m) return null;
  const markers=[m[1],m[3]].filter((v):v is string=>Boolean(v));
  const explicit=[...declared];
  for (const marker of markers) {
    if (["$","¥","元"].includes(marker)) continue;
    const code=currencyCode(marker);if(!code)return null;explicit.push(code);
  }
  if(new Set(explicit).size>1)return null;
  const currency=explicit[0]??null;
  for(const marker of markers){
    if(marker==="$" && (!currency || !["HKD","USD","TWD","SGD","AUD","CAD","NZD","BND","MXN"].includes(currency)))return null;
    if(marker==="¥" && (!currency || !["CNY","JPY"].includes(currency)))return null;
    if(marker==="元" && !currency)return null;
  }
  const amount=Number(m[2].replace(/,/gu,""));
  if(!Number.isFinite(amount)||amount<0||amount>99999999.99||!Number.isSafeInteger(Math.round(amount*10000)))return null;
  return {amount,currency};
}
export function kbProductRecordPrice(record: KbProductRecord): KbRecordedPrice {
  const prices=record.fields.filter(f=>PRICE_KEYS.has(kbProductFieldKey(f.key)));
  const absent={has_field:prices.length>0,amount:null,currency:null,field:null};
  if(record.ambiguous)return {...absent,reason:"ambiguous"};
  if(!prices.length)return {...absent,reason:"missing"};
  const rawCurrencies=record.fields.filter(f=>CURRENCY_KEYS.has(kbProductFieldKey(f.key))).map(f=>currencyCode(f.value));
  if(rawCurrencies.some(v=>!v)||new Set(rawCurrencies).size>1)return {...absent,reason:"invalid_or_unsupported_currency"};
  const values=prices.map(f=>parseRecordedAmount(f.value,rawCurrencies as string[]));
  if(values.some(v=>!v))return {...absent,reason:"invalid_or_unsupported_currency"};
  const valid=values as Array<{amount:number;currency:string|null}>;
  if(new Set(valid.map(v=>`${v.amount}:${v.currency}`)).size!==1)return {...absent,reason:"ambiguous"};
  return {has_field:true,...valid[0],field:prices[0].key.slice(0,64),reason:"ok"};
}

export type KbRecordedStock = {has_field:boolean;quantity:number|null;field:string|null;reason:"ok"|"missing"|"ambiguous"|"invalid"};
export function kbProductRecordStock(record: KbProductRecord): KbRecordedStock {
  const fields=record.fields.filter(f=>STOCK_KEYS.has(kbProductFieldKey(f.key)));
  const absent={has_field:fields.length>0,quantity:null,field:null};
  if(record.ambiguous)return {...absent,reason:"ambiguous"};
  if(!fields.length)return {...absent,reason:"missing"};
  const values=fields.map(f=>/^(?:0|[1-9]\d{0,8}|[1-9]\d{0,2}(?:,\d{3}){1,2})$/u.test(f.value)?Number(f.value.replace(/,/gu,"")):null);
  if(values.some(v=>v===null || !Number.isSafeInteger(v)))return {...absent,reason:"invalid"};
  if(new Set(values).size!==1)return {...absent,reason:"ambiguous"};
  return {has_field:true,quantity:values[0],field:fields[0].key.slice(0,64),reason:"ok"};
}

export type CatalogueRequest = {price:boolean;stock:boolean;specification:boolean;label:string;codes:string[];size:string|null;color:string|null};
export function catalogueFactRequest(request: string): CatalogueRequest | null {
  const text=request.normalize("NFKC").trim();
  if(!text || text.length>800 || /(?:維修|维修|故障|broken|repair|refund|退款|取消|cancel|不要查|唔查|don't check|do not check)/iu.test(text))return null;
  const price=/(?:售價|售价|價錢|价钱|價格|价格|幾錢|几钱|多少錢|多少钱|\bprice\b|\bcost\b|how\s+much)/iu.test(text);
  const stock=/(?:庫存|库存|現貨|现货|有冇貨|有沒有貨|有没有货|剩幾多|剩多少|\bstock\b|\binventory\b|\bavailability\b|\bavailable\b|how many.+left)/iu.test(text);
  const specification=/(?:規格|规格|\bspecs?\b|顏色|颜色|尺碼|尺码|\bsize\b|\bcolou?r\b)/iu.test(text);
  if(!price&&!stock&&!specification)return null;
  const upper=normalizeCatalogueCode(text);
  const codes=[...new Set((upper.match(/\b(?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|[A-Z]{1,8}\d{2,}[A-Z0-9]*)\b/gu)??[]).filter(code=>/\d/u.test(code)))];
  const size=/\b(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-9]XL)\b/u.exec(upper)?.[1]??null;
  const color=/(?:顏色|颜色|colou?r)\s*[:=]\s*([^\s,，?？;；]{1,20})/iu.exec(text)?.[1]??
    /(?:^|[\s,，])([\p{Script=Han}]{1,5}色)(?=$|[\s,，?？])/u.exec(text)?.[1]??null;
  let label=text.replace(/^(?:(?:請問|请问|想問|想问|我想知道|我想知|幫我查|帮我查|請查|请查)\s*)+/u,"")
    .replace(/^(?:how much (?:is|for|does) (?:the )?|what(?:'s| is) the (?:price|cost|stock|inventory|availability) (?:of|for) (?:the )?|(?:price|stock|inventory) (?:of|for) (?:the )?)/iu,"")
    .replace(/(?:嘅|的)?(?:售價|售价|價錢|价钱|價格|价格|幾錢|几钱|多少錢|多少钱|庫存|库存|現貨|现货|規格|规格|有冇貨|有沒有貨|有没有货|price|cost|stock|inventory|availability|in stock|available|specs?)(?:係幾多|是多少|有幾多|几多|幾多|多少|how many|please)?/giu," ")
    .replace(/^(?:is|are|do you have)\s+(?:the\s+)?/iu,"")
    .replace(/(?:^|\s)(?:and|or|for|please)(?=\s|$)/giu," ")
    .replace(/[?？!！。.,，;；:：&]/gu," ").replace(/(?:同埋|以及|及|同|有冇|有沒有|有没有|係幾多|仲有幾多|剩多少|多少件|多少|幾多|几多)/gu," ");
  if(size)label=label.replace(new RegExp(`\\b${size}\\b`,"giu")," ");
  if(color)label=label.replace(color," ");
  label=label.replace(/\s+/gu," ").trim();
  if(!label || label.length>160)return null;
  return {price,stock,specification,label,codes,size,color};
}

export type CatalogueMatch = {kind:"exact_name"|"exact_code"|"short_name_candidate";record:KbProductRecord};
function shortNameCandidate(query:string,name:string):boolean {
  if(query.length<4 || name.length>120 || query===name)return false;
  const words=query.split(/\s+/u), target=name.split(/\s+/u);
  if(words.length>=2){let i=0;for(const word of target)if(word===words[i])i++;return i===words.length && words.length/target.length>=0.5;}
  if(!/^[\p{Script=Han}]+$/u.test(query)||!name.startsWith(query.slice(0,2))||!name.endsWith(query.slice(-2)))return false;
  // A bounded elision is only a *candidate*. Caller must ask confirmation and
  // must reject competing SPUs; no generated synonym or substring authority.
  let i=0;for(const ch of name)if(ch===query[i])i++;
  return i===query.length && query.length/name.length>=0.5 && name.length-query.length<=6;
}
export function matchCatalogueRecord(query: CatalogueRequest, record:KbProductRecord): CatalogueMatch|null {
  if(record.ambiguous)return null;
  if(query.size && normalized(record.variants.size??"")!==normalized(query.size))return null;
  if(query.color && normalized(record.variants.color??"")!==normalized(query.color))return null;
  const codes=[...record.sku_codes,...record.spu_codes,...record.models.map(normalizeCatalogueCode)];
  if(query.codes.length){
    if(query.codes.length!==1 || !codes.includes(query.codes[0]))return null;
    return {kind:"exact_code",record};
  }
  const label=normalized(query.label);
  const names=kbProductRecordNames(record);
  if(names.some(n=>n===label))return {kind:"exact_name",record};
  if(names.length===1&&shortNameCandidate(label,names[0]))return {kind:"short_name_candidate",record};
  return null;
}

/** Resolve only an immediate, server-persisted variant question or an explicit
 * SKU supplied for an unresolved source candidate. This returns
 * a new retrieval query, never historical price/stock authority or an order.
 * Callers pass their already authenticated tenant-scoped, newest-first history.
 */
export function resolveCatalogueVariantFollowup(question:string,history:Array<{id?:string;role?:string;content?:string;metadata?:unknown;conversation_id?:string;company_id?:string}>,
 scope:{conversation_id:string;company_id:string;source_message_id:string}):{request:string;source_assistant_message_id:string}|null {
 if(!scope.conversation_id||!scope.company_id||!scope.source_message_id||!question.trim()||question.length>120||catalogueFactRequest(question)||
   /(?:取消|cancel|暫緩|暂缓|稍後|稍后|真人|human|agent|退款|refund|不是|唔係|not this|改問|改问)/iu.test(question))return null;
 const text=normalizeCatalogueCode(question).replace(/^(?:我要|要|選擇|选择|選|选|係|是|THE|PLEASE)\s*/u,'').replace(/[。.!！?？]/gu,'').trim();
 let anchor:typeof history[number]|undefined;
 for(const row of history.slice(0,12)){
  if(row.conversation_id && row.conversation_id!==scope.conversation_id || row.company_id && row.company_id!==scope.company_id)return null;
  if(row.id===scope.source_message_id || row.content==='__THINKING__')continue;
  if(row.role!=='assistant')return null;
  anchor=row;break;
 }
 if(!anchor?.id || !anchor.metadata || typeof anchor.metadata!=='object')return null;
 const meta=anchor.metadata as Record<string,unknown>;
 const variantQuestion=meta.answer_kind==='catalogue_variant_clarification';
 const candidateRecord=meta.identity_confirmation_required===true &&
   ['listed_price_unverified','recorded_product_facts'].includes(String(meta.answer_kind));
 if(meta.control_commit!=='ai'||meta.b2_expected_company_id!==scope.company_id||
   (!variantQuestion&&!candidateRecord)||!Array.isArray(meta.catalogue_options)||
   !meta.catalogue_options.length||meta.catalogue_options.length>8)return null;
 const matched=meta.catalogue_options.filter((raw:unknown)=>{
  if(!raw||typeof raw!=='object')return false;
  const item=raw as Record<string,unknown>, authority=item.reference_authority as Record<string,unknown>|undefined;
  if(typeof item.sku!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._\-]{1,95}$/u.test(item.sku) ||
    !authority || authority.decision!=='USE_CURRENT_KB' || authority.selected_source_id!==item.document_id || typeof item.chunk_id!=='string')return false;
  if(text===normalizeCatalogueCode(item.sku))return true;
  // A colour/size alone cannot confirm a candidate product's identity. Only
  // the existing multi-variant question accepts a specification-only choice.
  if(candidateRecord)return false;
  const variants=item.variants;if(!variants||typeof variants!=='object'||Array.isArray(variants))return false;
  const values=Object.values(variants).filter((v):v is string=>typeof v==='string'&&v.length>0).map(normalizeCatalogueCode);
  let remainder=text,found=0;
  for(const value of values.sort((a,b)=>b.length-a.length)){
   if(remainder===value){remainder='';found++;break;}
   const pieces=remainder.split(/\s+/u);if(pieces.includes(value)){remainder=pieces.filter(p=>p!==value).join(' ');found++;}
  }
  return found>0 && !remainder.trim();
 });
 if(matched.length!==1)return null;
 const selected=matched[0] as Record<string,unknown>;
 const facets=meta.catalogue_requested_facts as Record<string,unknown>|undefined;
 const words=[facets?.price===true?'price':'',facets?.stock===true?'stock':'',facets?.specification===true?'specification':''].filter(Boolean);
 if(!words.length)return null;
 return {request:`${selected.sku} ${words.join(' and ')}?`,source_assistant_message_id:anchor.id};
}
