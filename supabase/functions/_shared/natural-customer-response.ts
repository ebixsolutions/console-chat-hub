import { classifyConversationalRoute, classifyNonFactualConversation, type NonFactualConversation } from "./conversational-routing.ts";

export type NaturalResponseLanguage = "zh-TW" | "zh-CN" | "en";

export type ProductFactualFacet =
  | "features"
  | "horsepower"
  | "suitability"
  | "price"
  | "specification"
  | "policy"
  | "model_info";

export type NaturalCustomerIntent =
  | { kind: "greeting"; product: null }
  | { kind: "product_shopping"; product: string | null }
  | {
    kind: "product_guidance";
    product: string | null;
  }
  | { kind: "product_availability"; product: string | null }
  | {
    kind: "product_factual_query";
    product: string;
    fact: ProductFactualFacet;
    facts: ProductFactualFacet[];
  }
  | {
    kind: "product_factual_clarification";
    product: null;
    candidates: string[];
    reason: string;
  }
  | { kind: "none"; product: null };

const MAX_PRODUCT_LABEL_LENGTH = 80;

/** Product-like codes must contain letters and a meaningful numeric part. */
export function exactProductIdentifiers(product: string | null): string[] {
  if (!product) return [];
  const tokens = product.normalize("NFKC").match(
    /(?<![A-Z0-9])(?:[A-Z][A-Z0-9]*-[A-Z0-9]+(?:-[A-Z0-9]+)*|[A-Z]{2,}[A-Z0-9]*\d{2,}[A-Z0-9]*|[A-Z]\d{3,}[A-Z0-9]*)(?![A-Z0-9])/giu,
  ) ?? [];
  return [
    ...new Set(
      tokens.filter((token) =>
        token.length >= 5 && /\d/u.test(token) && /[A-Z]/iu.test(token)
      ),
    ),
  ];
}

/** A specific model and an actual merchant fact request are both required. */
export function classifyProductFactualQuery(
  text: string,
): Extract<NaturalCustomerIntent, { kind: "product_factual_query" }> | null {
  const normalized = text.normalize("NFKC").trim();
  const models = exactProductIdentifiers(normalized);
  if (models.length !== 1 || isProductSupportProblem(normalized)) return null;
  const facts = productFactualFacets(normalized);
  if (!facts.length) return null;
  return productFactualIntent(models[0], facts);
}

function productFactualFacets(text: string): ProductFactualFacet[] {
  const matchers: Array<[ProductFactualFacet, RegExp]> = [
    ["policy", /(?:billing|booking|cancellation|return|warranty)\s+policy|付款政策|預約政策|预约政策|取消政策|保養政策|保修政策|退貨政策|退货政策/i],
    ["features", /(?:功能|feature|特點|特点|特色)/i],
    [
      "horsepower",
      /(?:幾多匹|几多匹|多少匹|幾匹|几匹|匹數|匹数|horsepower|\bHP\b)/i,
    ],
    ["price", /(?:售價|售价|幾錢|几钱|價錢|价钱|價格|价格|標價|标价|標示價|标示价|price|how\s+much)/i],
    [
      "specification",
      /(?:規格|规格|specs?|尺寸|dimension|capacity|容量|重量|weight|功率|power|電壓|电压|voltage|噪音)/i,
    ],
    [
      "model_info",
      /(?:型號|型号|model|產品資料|产品资料|可靠資料|可靠资料|product\s+(?:information|details))/i,
    ],
    [
      "suitability",
      /(?:適合|适合|適唔適合|适不适合|夠用|够用|夠唔夠|够不够|啱用|合用|合唔合適|合不合适|評估|评估|assess|suitab|enough|work\s+for|fit\s+(?:in|for)|appropriate\s+for)/i,
    ],
  ];
  return matchers.filter(([, pattern]) => pattern.test(text)).map(([fact]) =>
    fact
  );
}

function productFactualIntent(
  product: string,
  facts: ProductFactualFacet[],
): Extract<NaturalCustomerIntent, { kind: "product_factual_query" }> {
  // Keep the legacy single-fact precedence for existing consumers while also
  // exposing every compatible facet so renderers cannot silently drop one.
  const fact = facts.includes("suitability")
    ? "suitability"
    : facts.includes("price")
    ? "price"
    : facts.includes("horsepower")
    ? "horsepower"
    : facts[0];
  return { kind: "product_factual_query", product, fact, facts };
}

export interface ProductFollowUpHistoryMessage {
  role: string;
  content: string;
  conversation_id?: string;
  company_id?: string;
}

export interface ProductFollowUpScope {
  conversation_id: string;
  company_id: string;
}

export type ProductFollowUpArbitration =
  | { kind: "not_applicable" }
  | {
    kind: "resolved";
    intent: Extract<NaturalCustomerIntent, { kind: "product_factual_query" }>;
    grounded_question: string;
    source_turn_offset: number;
    resolved_topic: string | null;
    resolution_strategy:
      | "RECENT_GLOBAL_REFERENT"
      | "PER_TOPIC_REFERENT_HISTORY";
  }
  | {
    kind: "clarification";
    intent: Extract<
      NaturalCustomerIntent,
      { kind: "product_factual_clarification" }
    >;
  };

// Meaning/category values come from scoped canonical state or explicit profile
// bindings supplied by the caller. No default industry or category inference.
export interface ProductReferenceContext extends ProductFollowUpScope {
  state?: {
    current_topic?: string | null;
    entities: Array<{ entity_id: string; category: string; model?: string | null;
      status: string; attributes: Record<string, unknown> }>;
  } | null;
  category_aliases?: Array<{ key: string; aliases: readonly string[] }>;
  semantic?: { confidence: number; topic: string | null;
    ambiguity: { is_ambiguous: boolean };
    referents: Array<{ ref: string; source: string; confidence: number }> } | null;
}
const PRODUCT_ANAPHOR = /(?:呢|這|这|嗰|那)(?:一)?(?:部|款|個|个|件|項|项)|(?:頭先|头先|之前)(?:嗰|那)?(?:部|款|個|个|件|項|项)|(?:佢|它)(?!們|们)|\b(?:this\s+(?:one|item|service)|that\s+(?:one|model|item|service)|it|the\s+.+?\s+we\s+(?:discussed|were discussing))\b/iu;
const PRODUCT_CONTEXT_SWITCH = /(?:轉(?:去|睇|問)|转(?:去|看|问)|講返|讲回|回到|返回|switch(?:ing)?\s+to|mov(?:e|ing)\s+to|back\s+to|return\s+to)/iu;
const INACTIVE_REFERENT = /(?:取消|唔要|不要|刪除|删除|先擺低|先放低|暫時唔跟|暫時唔搞|暫緩|暂缓|遲啲先|迟点再|cancel(?:led)?|defer(?:red)?|no\s+longer|not\s+that)/iu;
const NEGATED_LIFECYCLE = /(?:唔好|不要|別|别|not|don't|do not|never).{0,12}(?:取消|刪|删|cancel|defer)/iu;
function removesHistoryIdentity(text: string): boolean {
  return INACTIVE_REFERENT.test(text) && !NEGATED_LIFECYCLE.test(text) &&
    !/(?:政策|policy|如果|假設|假设|\bif\b|hypothetical|quoted|[「“"].*(?:取消|cancel).*[」”"])/iu.test(text);
}
const norm = (text: string) => text.normalize("NFKC").trim().toLowerCase();
function containsLabel(text: string, label: string): boolean {
  const a=norm(text), b=norm(label);
  if (!b) return false;
  let offset=a.indexOf(b);
  while (offset>=0) {
    if (!/^[a-z0-9]/u.test(b) ||
      (!/[a-z0-9]/u.test(a[offset-1]??"") && !/[a-z0-9]/u.test(a[offset+b.length]??""))) return true;
    offset=a.indexOf(b,offset+1);
  }
  return false;
}
function scopedProductHistory(history: ProductFollowUpHistoryMessage[], scope?: ProductFollowUpScope) {
  return history.filter(row => !scope ||
    (row.conversation_id===scope.conversation_id && row.company_id===scope.company_id));
}
/** Identity binding is read-only and never constitutes merchant fact evidence. */
export function arbitrateAnaphoricProductFollowUp(
  text: string, newestFirstHistory: ProductFollowUpHistoryMessage[],
  scope?: ProductFollowUpScope, context?: ProductReferenceContext,
): ProductFollowUpArbitration {
  const original=text.normalize("NFKC").trim();
  const clarification=(reason:string,candidates:string[]=[]):ProductFollowUpArbitration =>
    ({kind:"clarification",intent:{kind:"product_factual_clarification",product:null,candidates,reason}});
  const history=scopedProductHistory(newestFirstHistory,scope).filter((r,i)=>
    i!==0 || r.role!=="visitor" || r.content.normalize("NFKC").trim()!==original);
  const supplied=exactProductIdentifiers(original);
  let question=original, facts=productFactualFacets(original);
  // A supplied identifier answers an outstanding identity clarification. The
  // pending question is retained; no price/specification is inferred from it.
  if (supplied.length===1 && !facts.length) {
    const last=history[0], previous=history[1];
    const remainder=original.toUpperCase().replace(supplied[0].toUpperCase(),"").trim();
    if (/^(?:(?:我指|係|是|就係|就是|the\s+model\s+is|i\s+mean)\s*)?(?:嗰款|呢款|that\s+one)?[。.!！\s]*$/iu.test(remainder) &&
      last?.role==="assistant" && previous?.role==="visitor" &&
      /^(?:你指邊個(?:現行產品或)?型號|你指的是哪個|你指的是哪个|Which (?:current product or model|model) do you mean)/iu.test(last.content.trim()) &&
      PRODUCT_ANAPHOR.test(previous.content)) {
      question=previous.content; facts=productFactualFacets(question);
    }
  }
  if (!facts.length || isProductSupportProblem(original) ||
    (question===original && (!PRODUCT_ANAPHOR.test(original) || supplied.length))) return {kind:"not_applicable"};
  if (context && (!scope || context.company_id!==scope.company_id || context.conversation_id!==scope.conversation_id))
    return clarification("REFERENCE_CONTEXT_SCOPE_MISMATCH");
  const visitors=history.filter(r=>r.role==="visitor" && r.content.trim()).slice(0,32);
  const entities=context?.state?.entities??[];
  const inactive=new Set(entities.filter(e=>["cancelled","deferred","superseded"].includes(e.status))
    .flatMap(e=>[e.entity_id,e.model??"",String(e.attributes.model??"")]).filter(Boolean).map(norm));
  const active=entities.filter(e=>["researching","tentative","confirmed"].includes(e.status));
  const identity=(e:typeof active[number])=>[e.entity_id,e.model??"",String(e.attributes.model??""),String(e.attributes.name??""),String(e.attributes.product_name??"")].filter(Boolean);
  const product=(e:typeof active[number])=>[e.model,e.attributes.model,e.attributes.product_name,e.attributes.name].find(v=>typeof v==="string" && v.trim()) as string|undefined ?? "";
  const aliases=new Map<string,string[]>();
  for (const e of entities) aliases.set(e.category,[...(aliases.get(e.category)??[]),e.category]);
  for (const c of context?.category_aliases??[]) aliases.set(c.key,[...(aliases.get(c.key)??[]),c.key,...c.aliases]);
  const topics=(value:string)=>[...aliases].filter(([,names])=>names.some(n=>containsLabel(value,n))).map(([key])=>key);
  // Per-category history is possible only with authoritative category bindings.
  // An attribute such as horsepower never supplies a category by itself.
  const requestedTopics=topics(question);
  const resolve=(model:string,topic:string|null,offset:number,strategy:"RECENT_GLOBAL_REFERENT"|"PER_TOPIC_REFERENT_HISTORY"):ProductFollowUpArbitration=>
    ({kind:"resolved",intent:productFactualIntent(model,facts),grounded_question:`${model} ${question}`,
      source_turn_offset:offset,resolved_topic:topic,resolution_strategy:strategy});
  if (supplied.length) {
    if (inactive.has(norm(supplied[0]))) return clarification("INACTIVE_OR_SUPERSEDED_PRODUCT_REFERENT");
    const current=active.filter(e=>identity(e).some(id=>norm(id)===norm(supplied[0])));
    return resolve(supplied[0],current.length===1?current[0].category:null,0,"RECENT_GLOBAL_REFERENT");
  }
  const frame=context?.semantic;
  const refs=frame && frame.confidence>=0.62 && !frame.ambiguity.is_ambiguous
    ? frame.referents.filter(r=>r.confidence>=0.62 && r.source!=="unknown").map(r=>norm(r.ref)):[];
  if (frame?.ambiguity.is_ambiguous) return clarification("AMBIGUOUS_SEMANTIC_REFERENT",active.map(product));
  if (frame?.referents.length && (refs.length!==frame.referents.length)) return clarification("UNPROVEN_SEMANTIC_REFERENT");
  let chosen:typeof active=active.filter(e=>refs.some(ref=>identity(e).some(id=>norm(id)===ref)));
  if (refs.length && (!chosen.length || refs.some(ref=>inactive.has(ref) || !active.some(e=>identity(e).some(id=>norm(id)===ref))))) return clarification("UNKNOWN_OR_INACTIVE_SEMANTIC_REFERENT");
  if (!chosen.length && requestedTopics.length===1) chosen=active.filter(e=>e.category===requestedTopics[0]);
  if (requestedTopics.length>1) return clarification("MULTIPLE_REQUESTED_PRODUCT_TOPICS");
  if (!chosen.length && active.length && !requestedTopics.length && !PRODUCT_CONTEXT_SWITCH.test(question)) {
    chosen=active.filter(e=>e.category===context?.state?.current_topic);
    if (!chosen.length && active.length===1 && (!frame?.topic || frame.topic===active[0].category)) chosen=active;
  }
  if (chosen.length && requestedTopics.length===1 && chosen.some(e=>e.category!==requestedTopics[0]))
    return clarification("SEMANTIC_TOPIC_IDENTITY_CONFLICT");
  if (chosen.length>1) return clarification("MULTIPLE_COMPATIBLE_PRODUCT_REFERENTS",chosen.map(product));
  if (chosen.length===1) {
    const model=product(chosen[0]);
    if (!model) return clarification("CUSTOMER_VISIBLE_IDENTITY_MISSING");
    if (supplied.length && norm(supplied[0])!==norm(model)) return clarification("SUPPLIED_IDENTITY_CONFLICT");
    return resolve(model,chosen[0].category,visitors.findIndex(r=>identity(chosen[0]).some(id=>containsLabel(r.content,id))),"PER_TOPIC_REFERENT_HISTORY");
  }
  // Canonical lifecycle state outranks textual history, including older mentions.
  if (context?.state && !supplied.length) return clarification("NO_ACTIVE_PRODUCT_REFERENT_FOR_REQUESTED_TOPIC");
  const ledger=new Map<string,{offset:number;topic:string|null}>();
  let focus:string|null=null, barrier=false;
  for (let offset=visitors.length-1;offset>=0;offset--) {
    const row=visitors[offset], ts=topics(row.content), ids=exactProductIdentifiers(row.content);
    if (ts.length===1) focus=ts[0];
    else if (ts.length>1) focus=null;
    if (PRODUCT_CONTEXT_SWITCH.test(row.content) && !ids.length) barrier=true;
    const corrected=ids.length===2 && /(?:更正|改為|改成|唔係.{0,40}係|不是.{0,40}是|replace|instead|change.{0,40}to)/iu.test(row.content);
    if (corrected) ledger.delete(norm(ids[0]));
    for (const model of corrected?ids.slice(1):ids) {
      if (removesHistoryIdentity(row.content) || inactive.has(norm(model))) ledger.delete(norm(model));
      else if (!inactive.has(norm(model))) { ledger.set(norm(model),{offset,topic:focus}); barrier=false; }
    }
    if (!ids.length && removesHistoryIdentity(row.content) && PRODUCT_ANAPHOR.test(row.content)) {
      for (const [id,value] of ledger) if (!focus || value.topic===focus) ledger.delete(id);
    }
  }
  let candidates=[...ledger].filter(([,value])=>!requestedTopics.length || value.topic===requestedTopics[0]);
  if (supplied.length) candidates=[[norm(supplied[0]),{offset:0,topic:null}]];
  if (barrier && !requestedTopics.length && !supplied.length) return clarification("INCOMPATIBLE_RECENT_PRODUCT_CONTEXT");
  if (candidates.length!==1) return clarification(candidates.length?"MULTIPLE_COMPATIBLE_PRODUCT_REFERENTS":"NO_RECENT_EXPLICIT_PRODUCT_REFERENT",candidates.map(([id])=>id.toUpperCase()));
  const [id,value]=candidates[0];
  if (inactive.has(id)) return clarification("INACTIVE_OR_SUPERSEDED_PRODUCT_REFERENT");
  // Keep customer's actual identifier spelling; never invent a semantic alias.
  const model=supplied[0]??visitors.flatMap(r=>exactProductIdentifiers(r.content)).find(m=>norm(m)===id)!;
  return resolve(model,value.topic,value.offset,requestedTopics.length?"PER_TOPIC_REFERENT_HISTORY":"RECENT_GLOBAL_REFERENT");
}

/** Canonical caller contract: bind the readback's tenant/ticket before query resolution.
 * History alone can prove a supplied identifier, never manufacture its category.
 * Readback must follow the existing verified Commerce commit/read path.
 */
export function arbitrateCanonicalProductFollowUp(
  text: string, history: ProductFollowUpHistoryMessage[], scope: ProductFollowUpScope,
  snapshot: ProductFollowUpScope & { revision: number; state: ProductReferenceContext["state"] },
  categoryAliases?: ProductReferenceContext["category_aliases"],
  semantic?: ProductReferenceContext["semantic"],
): ProductFollowUpArbitration {
  // An initial empty revision must not preempt greetings or other non-reference routes.
  if (arbitrateAnaphoricProductFollowUp(text,history,scope).kind === "not_applicable")
    return {kind:"not_applicable"};
  if (snapshot.company_id!==scope.company_id || snapshot.conversation_id!==scope.conversation_id ||
    !Number.isSafeInteger(snapshot.revision) || snapshot.revision<1 || !snapshot.state) {
    return {kind:"clarification",intent:{kind:"product_factual_clarification",product:null,candidates:[],reason:"CANONICAL_REFERENCE_READBACK_UNPROVEN"}};
  }
  return arbitrateAnaphoricProductFollowUp(text,history,scope,{
    ...scope,state:snapshot.state,category_aliases:categoryAliases,semantic,
  });
}

export function isProductSupportProblem(text: string): boolean {
  return isProductOperationFailure(text) ||
    /(?:故障|維修|维修|壞咗|坏了|損壞|损坏|缺少功能|缺失功能|功能失效|兼容問題|兼容问题|相容問題|賣家投訴|卖家投诉|malfunction|broken|damaged|missing\s+(?:advertised\s+)?(?:features?|parts?)|compatibility\s+issue|seller\s+(?:problem|complaint)|product\s+support)/i
      .test(text);
}

/** A reported operating failure, distinct from a question about product features. */
export function isProductOperationFailure(text: string): boolean {
  return /(?:開唔到機|开不了机|開不了機|不能開機|无法开机|唔著|(?:機|机|產品|产品).{0,8}(?:開唔到|开不了|唔著)|not\s+working|won['’]?t\s+(?:start|turn\s+on)|(?:does\s+not|doesn['’]?t)\s+turn\s+on)/i
    .test(text);
}

function chineseProductPrefix(product: string): string {
  return /^[\p{Script=Latin}\d]/u.test(product) ? ` ${product}` : product;
}

function chinesePossessiveParticle(
  product: string,
  particle: "嘅" | "的",
): string {
  return /^[\p{Script=Latin}\d]/u.test(product) ? ` ${particle}` : particle;
}

function cleanProductLabel(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .normalize("NFKC")
    .replace(/^[\s,，:：;；一個一部一件一款]+/u, "")
    .replace(
      /(?:嘅)?(?:產品|商品)?(?:資料)?(?:嗎|呢|呀|啊)?[?？!！.。\s]*$/u,
      "",
    )
    .replace(/^(?:an?|any|some|the)\s+/i, "")
    .replace(/\s+(?:available|in stock|for sale)$/i, "")
    .replace(/[?？!！.。]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > MAX_PRODUCT_LABEL_LENGTH) return null;
  if (
    /^(?:產品|商品|貨|嘢|東西|东西|product|item|something|anything)$/i.test(
      cleaned,
    )
  ) return null;
  return cleaned;
}

function extractShoppingProduct(text: string): string | null {
  const chinese = text.match(
    /(?:我|本人)?(?:想|要|打算|準備|准备|考慮|考虑|希望)(?:買|买|購買|购买|訂購|订购|訂|订|入手)\s*(.+?)[?？!！.。]*$/iu,
  );
  if (chinese) return cleanProductLabel(chinese[1]);

  const english = text.match(
    /(?:i\s+)?(?:want|would like|need|plan|hope|am looking)(?:\s+to)?\s+(?:buy|purchase|order|get)\s+(.+?)[?!.]*$/i,
  );
  return cleanProductLabel(english?.[1]);
}

function stripLeadingGreeting(text: string): string {
  return text.replace(
    /^(?:(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))|(?:你好|您好|嗨|哈囉|哈啰|早晨|早安|午安|晚安))[\s,，:：!！。.]*/iu,
    "",
  ).trim();
}

function extractGuidanceProduct(text: string): string | null {
  const chinese = text.match(
    /(?:想問|想问|想了解|想睇|想看|請教|请教)\s*([^，,。.!！?？]{1,48}?)(?=\s*(?:，|,|。|\?|？|點揀|点选|點選|揀邊|选哪|買咩|买什么|邊款|哪款|邊種|哪种|要幾|要几))/iu,
  );
  if (chinese) return cleanProductLabel(chinese[1]);
  const chineseSelection = text.match(
    /(?:想|要|打算|準備|准备|考慮|考虑|希望)?(?:幫|帮)?(?:屋企|家裡|家里|公司|辦公室|办公室)?\s*(?:換|换|買|买|選購|选购|揀|選|选|搵|找)\s*(?:一部|一台|個|个)?\s*([^，,。.!！?？]{1,32}?)(?=\s*(?:，|,|。|\?|？|俾|給|给|for|兩|两|2|三|3|點樣|怎样|怎樣|如何|邊款|哪款|$))/iu,
  );
  if (chineseSelection) return cleanProductLabel(chineseSelection[1]);
  const chineseHow = text.match(
    /(?:點樣|怎样|怎樣|如何|怎么)\s*(?:揀|選|选|選擇|选择|挑選|挑选)\s*(?:一部|一台|個|个)?\s*([^，,。.!！?？]{1,32})/iu,
  );
  if (chineseHow) return cleanProductLabel(chineseHow[1]);
  const english = text.match(
    /(?:help|advice|guidance|recommendation)s?\s+(?:with|on|for)\s+([^,.!?]{1,48})/i,
  );
  if (english) return cleanProductLabel(english[1]);
  const englishSelection = text.match(
    /(?:how\s+(?:should|can|do)\s+i\s+)?(?:choos(?:e|ing)|select(?:ing)?|pick(?:ing)?|shop\s+for)\s+(?:an?|the|some)?\s*([^,.!?]{1,48}?)(?=\s+for\s+(?:two|three|the|my|our|a|an|\d)|[,.!?]|$)/i,
  );
  return cleanProductLabel(englishSelection?.[1]);
}

function looksLikeProductGuidance(text: string): boolean {
  return /(?:買咩|买什么|揀邊|选哪|點(?:樣)?揀|怎樣選|怎样选|如何選|如何选|怎么选|點選|邊款|哪款|邊種|哪种|幾大|几大|幾多匹|几匹|合適|合适|推薦|推荐|建議|建议|what\s+should\s+i\s+(?:buy|choose|get)|how\s+(?:should|can|do)\s+i\s+(?:choose|select|pick)|which\s+(?:model|size|option)|help(?:\s+me)?\s+(?:with\s+)?(?:choos(?:e|ing)|select(?:ing)?|pick(?:ing)?)|recommend|advi[cs]e)/iu
    .test(
      text,
    );
}

function extractAvailabilityProduct(text: string): string | null {
  const chinesePatterns = [
    /(?:你(?:哋|們|们)?|店內|店内|呢度|這裡|这里)?\s*(?:有冇|有無|有沒有|有没有|是否有)\s*(.+?)(?:賣|卖|售賣|售卖|出售|現貨|现货|庫存|库存)?[?？!！.。]*$/iu,
    /(?:你(?:哋|們|们)?|店內|店内|呢度|這裡|这里)?\s*(?:賣唔賣|卖不卖|有售)\s*(.+?)[?？!！.。]*$/iu,
    /(.+?)(?:有冇|有沒有|有没有)(?:現貨|现货|庫存|库存|售賣|售卖)?[?？!！.。]*$/iu,
  ];
  for (const pattern of chinesePatterns) {
    const match = text.match(pattern);
    const product = cleanProductLabel(match?.[1]);
    if (product) return product;
  }

  const englishPatterns = [
    /(?:do\s+you|does\s+(?:the\s+)?(?:shop|store)|have\s+you)\s+(?:have|carry|sell|stock)\s+(.+?)[?!.]*$/i,
    /(?:is|are)\s+(?:there\s+)?(?:any\s+)?(.+?)\s+(?:available|in stock|for sale)[?!.]*$/i,
    /(?:do\s+you\s+have)\s+(.+?)[?!.]*$/i,
  ];
  for (const pattern of englishPatterns) {
    const match = text.match(pattern);
    const product = cleanProductLabel(match?.[1]);
    if (product) return product;
  }
  return null;
}

export function classifyNaturalCustomerIntent(
  text: string,
): NaturalCustomerIntent {
  const normalized = (text ?? "").normalize("NFKC").trim();
  if (!normalized) return { kind: "none", product: null };

  // A greeting may prefix a real customer goal.  Classify the meaningful
  // remainder first so "Hi, I need help choosing ..." cannot be reduced to a
  // greeting-only response or fall through to generic clarification.
  const meaningful = stripLeadingGreeting(normalized) || normalized;

  // Only a whole, goal-free help request belongs to the opening response.
  // Tasks and explicit human requests must continue through their own routes.
  if (/^(?:(?:請|请|麻煩|麻烦)?(?:你)?(?:可以|可唔可以|能|能否|可否)?(?:幫|帮)(?:下|一下)?(?:我|忙)(?:嗎|吗|嘛)?|(?:我)?(?:想|需要)(?:你)?(?:幫忙|帮忙|幫手|帮手)|(?:can|could|would)\s+you\s+help(?:\s+me)?(?:\s+please)?|(?:i\s+)?need\s+(?:some\s+)?help)[\s?？!！.。]*$/iu.test(meaningful)) {
    return { kind: "greeting", product: null };
  }

  if (
    /^(?:(?:你(?:哋|們|们)?|店內|店内|呢度|這裡|这里)\s*)?(?:有冇|有無|有沒有|有没有|是否有)\s*[?？!！.。]*$/iu
      .test(meaningful) ||
    /^(?:do\s+you|does\s+(?:the\s+)?(?:shop|store))\s+(?:have|carry|sell|stock)\s*[?!.]*$/iu
      .test(meaningful)
  ) {
    return { kind: "product_availability", product: null };
  }

  // Merchant stock counts are not the customer's retained purchase quantity.
  // Bind the product before generic quantity recall in both Edge consumers.
  if (/(?:幾多|几多|多少|how many|how much).{0,24}(?:現貨|现货|庫存|库存|in stock)|(?:現貨|现货|庫存|库存|stock).{0,24}(?:幾多|几多|多少|how many|how much)/i.test(meaningful)) {
    const models = exactProductIdentifiers(meaningful);
    const product = models.length === 1 ? models[0] : cleanProductLabel(meaningful.split(/(?:依家|而家|現在|现在|有幾多|有几多|有多少)/u)[0]);
    return { kind: "product_availability", product };
  }

  const availabilityProduct = /(?:有冇|有沒有|有没有)\s*(?:啲|一些)?(?:方向|建議|建议)/iu.test(meaningful)
    ? null : extractAvailabilityProduct(meaningful);
  if (availabilityProduct) {
    return { kind: "product_availability", product: availabilityProduct };
  }

  const factualQuery = classifyProductFactualQuery(meaningful);
  if (factualQuery) return factualQuery;

  const shoppingProduct = extractShoppingProduct(meaningful);
  if (
    shoppingProduct ||
    /(?:想|要|打算|準備|准备|考慮|考虑|希望)(?:買|买|購買|购买|訂購|订购|入手)|(?:want|would like|plan|hope|looking)(?:\s+to)?\s+(?:buy|purchase|order|get)/i
      .test(meaningful)
  ) {
    return { kind: "product_shopping", product: shoppingProduct };
  }

  if (looksLikeProductGuidance(meaningful)) {
    const product = extractGuidanceProduct(meaningful);
    // Bare sizing shorthand such as "how big?" may be a contextual recall
    // query and must remain available to the state resolver. A model-free turn
    // is guidance only when the customer actually asks to choose/recommend.
    if (
      !product &&
      !/(?:想問|想问|想了解|想睇|想看|請教|请教|推薦|推荐|建議|建议|點(?:樣)?揀|怎樣選|怎样选|如何選|如何选|怎么选|help|advice|guidance|recommend|what\s+should\s+i\s+(?:buy|choose|get)|how\s+(?:should|can|do)\s+i\s+(?:choose|select|pick)|which\s+(?:model|option))/iu
        .test(meaningful)
    ) {
      return { kind: "none", product: null };
    }
    return {
      kind: "product_guidance",
      product,
    };
  }

  const conversational = classifyConversationalRoute(normalized);
  if (
    conversational.kind === "conversational" &&
    conversational.subtype === "greeting"
  ) {
    return { kind: "greeting", product: null };
  }

  return { kind: "none", product: null };
}

export function requiresCurrentMerchantEvidence(
  intent: NaturalCustomerIntent,
): boolean {
  // Product-specific facts must use the same current, tenant-scoped KB gate.
  return intent.kind === "product_availability" ||
    intent.kind === "product_factual_query" ||
    intent.kind === "product_guidance" ||
    (intent.kind === "product_shopping" && Boolean(intent.product));
}

/** Whole social turns carry no business goal or transaction semantics. */
export function classifySocialTurn(text: string): NonFactualConversation | null {
  return classifyNonFactualConversation(text) ??
    (classifyNaturalCustomerIntent(text).kind === "greeting" ? "opening" : null);
}

export function renderSocialTurn(text: string, language: NaturalResponseLanguage): string | null {
  const kind = classifySocialTurn(text);
  if (!kind) return null;
  if (kind === "identity") {
    // No configured name exists in this call path. Do not invent one or use
    // a merchant/person name from untrusted conversation text.
    return language === "en" ? "I'm an AI customer support assistant, not a human agent. I can help with your questions here, and you can ask for human support."
      : language === "zh-CN" ? "我是 AI 客服助手，并非真人客服。我可以在这里协助你处理问题；你也可以要求人工客服。"
      : "我係 AI 客服助手，並非真人客服。我可以喺呢度協助你處理問題；你亦可以要求真人客服。";
  }
  if (kind === "wellbeing") return language === "en" ? "Hi! I'm here and ready to help. What can I help you with?"
    : language === "zh-CN" ? "你好！我在这里，可以帮你处理什么问题？" : "你好！我喺度，有咩可以幫你？";
  if (kind === "opening") return renderNaturalImmediateResponse({kind:"greeting",product:null},language);
  return language === "en" ? "You're welcome. I'm here if you need anything else." : language === "zh-CN" ? "好的，有需要可以再问我。" : "好，有需要可以再問我。";
}

export function renderNaturalImmediateResponse(
  intent: NaturalCustomerIntent,
  language: NaturalResponseLanguage,
): string | null {
  if (intent.kind === "product_availability" && !intent.product) {
    if (language === "en") {
      return "Which product or model would you like me to check?";
    }
    if (language === "zh-CN") return "你想查哪类产品或哪个型号？";
    return "你想查邊類產品或邊個型號？";
  }
  if (intent.kind === "product_factual_clarification") {
    if (intent.candidates.length > 1) {
      const choices = intent.candidates.join(" / ");
      if (language === "en") return `Which model do you mean: ${choices}?`;
      if (language === "zh-CN") return `你指的是哪个型号：${choices}？`;
      return `你指邊個型號：${choices}？`;
    }
    if (language === "en") return "Which current product or model do you mean?";
    if (language === "zh-CN") return "你指的是哪个当前产品或型号？";
    return "你指邊個現行產品或型號？";
  }
  if (intent.kind === "greeting") {
    if (language === "en") return "Hi! How can I help?";
    if (language === "zh-CN") return "你好！有什么可以帮你？";
    return "你好！有咩可以幫你？";
  }
  // A category is sufficient for a scoped first read. Specific models and
  // customer constraints can refine that read after actual retrieval.
  if (intent.kind === "product_guidance" ||
    (intent.kind === "product_shopping" && intent.product)) return null;
  if (intent.kind !== "product_shopping") return null;

  // A supplied identifier is already a referent; it is not merchant evidence.
  const supplied = exactProductIdentifiers(intent.product ?? "");
  if (supplied.length) {
    const identifiers = supplied.join(language === "en" ? ", " : "、");
    return language === "en"
      ? `You want to buy ${identifiers}. Live availability still needs merchant verification.`
      : language === "zh-CN"
      ? `明白，你想选购 ${identifiers}；实时供应情况仍需商家核实。`
      : `明白，你想選購 ${identifiers}；即時供應情況仍需商家核實。`;
  }

  if (language === "en") {
    return intent.product
      ? `Sure. Which ${intent.product} model are you looking for? If you have not decided yet, I can first check whether the store has relevant product information.`
      : "Sure. What kind of product are you looking for? I can first check what relevant product information the store currently has.";
  }
  if (language === "zh-CN") {
    return intent.product
      ? `可以。你想找哪一款${
        chineseProductPrefix(intent.product)
      }？如果还没决定，我可以先帮你查目前店内有没有相关产品资料。`
      : "可以。你想找哪一类产品？我可以先帮你查目前店内有没有相关产品资料。";
  }
  return intent.product
    ? `可以。你想搵邊款${
      chineseProductPrefix(intent.product)
    }？如果你未決定，我可以先幫你查目前店內有冇相關產品資料。`
    : "可以。你想搵邊類產品？我可以先幫你查目前店內有冇相關產品資料。";
}

export function renderNaturalNoCurrentEvidence(
  intent: NaturalCustomerIntent,
  language: NaturalResponseLanguage,
): string | null {
  if (intent.kind === "product_factual_query") {
    const model = intent.product;
    if (language === "en") {
      return `I cannot find verifiable current product information for ${model}, so I cannot confirm its features or suitability. I will not guess.`;
    }
    if (language === "zh-CN") {
      return `我目前找不到 ${model} 的可核实当前产品资料，所以无法确认功能或适用情况。我不会猜测。`;
    }
    return `我而家搵唔到 ${model} 嘅可核實現行產品資料，所以未能確認功能或適用情況。我唔會估。`;
  }
  if (intent.kind !== "product_availability") return null;
  const product = intent.product;
  const identifiers = exactProductIdentifiers(product);
  if (identifiers.length) {
    const subject = identifiers.length === 1 ? identifiers[0] : product!;
    if (language === "en") {
      return `I cannot find current product information for ${subject}, so I cannot confirm whether it is sold here. I will not guess.`;
    }
    if (language === "zh-CN") {
      return `我目前找不到${subject}的现行产品资料，所以暂时无法确认有没有售卖。我不会猜测。`;
    }
    return `我而家搵唔到${chineseProductPrefix(subject)}${
      chinesePossessiveParticle(subject, "嘅")
    }現行產品資料，所以暫時未能確認有冇售賣。我唔會估。`;
  }
  if (language === "en") {
    return product
      ? `I cannot find current store product information for ${product}, so I cannot confirm whether it is sold here. If you have a specific model, I can check again.`
      : "I cannot find relevant current store product information, so I cannot confirm availability. If you have a specific product or model, I can check again.";
  }
  if (language === "zh-CN") {
    return product
      ? `我目前找不到店内有${chineseProductPrefix(product)}${
        chinesePossessiveParticle(product, "的")
      }产品资料，所以暂时无法确认有没有售卖。如果你有指定型号，我可以再帮你查。`
      : "我目前找不到店内相关产品资料，所以暂时无法确认有没有售卖。如果你有指定产品或型号，我可以再帮你查。";
  }
  return product
    ? `我而家搵唔到店內有${chineseProductPrefix(product)}${
      chinesePossessiveParticle(product, "嘅")
    }產品資料，所以暫時未能確認有冇售賣。你有指定型號的話，我可以再幫你查。`
    : "我而家搵唔到店內相關產品資料，所以暫時未能確認有冇售賣。你有指定產品或型號的話，我可以再幫你查。";
}
