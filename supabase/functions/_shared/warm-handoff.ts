export type WarmHandoffKnownFact = { label: string; value: string };
export type WarmHandoffPackage = {
  reason: string;
  customer_goal: string;
  known_facts: WarmHandoffKnownFact[];
  unavailable_facts: string[];
  missing_facts: string[];
  actions_already_tried: string[];
  last_customer_request: string;
  conversation_summary: string;
  collection_already_attempted: boolean;
  ready_for_handoff: boolean;
};
type Row = { role?: string; content?: string | null; metadata?: unknown };
const REGION = /(香港|台灣|台湾|澳門|澳门|Hong Kong|Taiwan|Macau)/i;
const PRODUCT = /(冷氣|空調|空调|洗衣機|洗衣机|雪櫃|冰箱|電視|电视|產品|产品|product)/i;
const PRODUCT_SUPPORT = /(維修|维修|保養|保修|故障|唔凍|不冷|不能運作|无法运行|repair|warranty|broken|not working)/i;
const ORDER_SUPPORT = /(訂單|订单|送貨|送货|退款|退貨|退货|order|delivery|refund|return)/i;
const MODEL_VALUE = /(?:型號|型号|model(?: number)?)[\s:：#-]*([A-Za-z0-9][A-Za-z0-9._\/-]{1,60})/i;
const ORDER_VALUE = /(?:訂單(?:編號|號碼|号码)|订单(?:编号|号码)|order(?: number| no\.?| id)|order\s*#)[\s:：#-]*([A-Za-z0-9][A-Za-z0-9._\/-]{2,80})/i;
const NO_MODEL = /(?:沒有|没有|冇|不知道|唔知|未知|no|don['’]?t have|do not have).{0,10}(?:型號|型号|model)/i;
const NO_ORDER = /(?:沒有|没有|冇|不知道|唔知|未知|no|don['’]?t have|do not have).{0,12}(?:訂單(?:編號|號碼|号码)?|订单(?:编号|号码)?|order(?: number| no\.?| id)?)/i;
function clean(v: unknown, max = 500): string {
  return typeof v === "string" ? v.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function meta(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
export function buildWarmHandoffPackage(rows: Row[], reason = "human_handoff"): WarmHandoffPackage {
  const usable = rows.filter((r) => clean(r.content) && clean(r.content) !== "__THINKING__");
  const visitors = usable.filter((r) => ["visitor", "customer", "user"].includes(String(r.role || "").toLowerCase()));
  const transcript = visitors.map((r) => clean(r.content)).join(" ");
  const last = clean(visitors.at(-1)?.content);
  const known: WarmHandoffKnownFact[] = [];
  const region = transcript.match(REGION)?.[0]; if (region) known.push({ label: "Region", value: region });
  const product = transcript.match(PRODUCT)?.[0]; if (product) known.push({ label: "Product", value: product });
  const model = transcript.match(MODEL_VALUE)?.[1]; if (model) known.push({ label: "Model", value: model });
  const order = transcript.match(ORDER_VALUE)?.[1]; if (order) known.push({ label: "Order reference", value: order });
  const unavailable: string[] = [];
  if (NO_MODEL.test(transcript)) unavailable.push("model");
  if (NO_ORDER.test(transcript)) unavailable.push("order_reference");
  const missing: string[] = [];
  if (PRODUCT_SUPPORT.test(transcript) && !model && !unavailable.includes("model")) missing.push("model");
  if (ORDER_SUPPORT.test(transcript) && !order && !unavailable.includes("order_reference")) missing.push("order_reference");
  const collectionAttempted = usable.some((r) => meta(r.metadata)?.response_route === "warm_handoff_data_collection");
  const assistants = usable.filter((r) => String(r.role || "").toLowerCase() === "assistant");
  const actions = assistants
    .filter((r) => meta(r.metadata)?.response_route !== "warm_handoff_data_collection")
    .slice(-3).map((r) => clean(r.content)).filter(Boolean);
  const goal = last || clean(visitors.at(-2)?.content) || "Customer requested human support";
  return {
    reason,
    customer_goal: goal,
    known_facts: known,
    unavailable_facts: unavailable,
    missing_facts: missing,
    actions_already_tried: actions,
    last_customer_request: last,
    conversation_summary: visitors.slice(-5).map((r) => clean(r.content)).join(" / ").slice(0, 1500),
    collection_already_attempted: collectionAttempted,
    ready_for_handoff: missing.length === 0 || collectionAttempted,
  };
}
export function buildMissingFactsQuestion(pkg: WarmHandoffPackage, lang: "zh-TW" | "zh-CN" | "en" = "zh-TW"): string | null {
  if (pkg.missing_facts.length === 0 || pkg.collection_already_attempted) return null;
  const names = {
    model: { "zh-TW": "產品型號", "zh-CN": "产品型号", en: "product model" },
    order_reference: { "zh-TW": "訂單編號", "zh-CN": "订单编号", en: "order number" },
  } as const;
  const labels = pkg.missing_facts.map((x) => (names as any)[x]?.[lang] || x);
  if (lang === "en") return `Before I connect you with a human agent, could you provide ${labels.join(" and ")}? If you don’t have it, just say so and I’ll still pass along everything we have.`;
  return `轉交真人客服前，想先補齊${labels.join("、")}；如果你手上沒有，直接告訴我「沒有」也可以，我會把目前資料一併交給客服。`;
}
export function shouldCollectMissingFacts(rule: string | null | undefined, explicitNow: boolean, pkg: WarmHandoffPackage): boolean {
  if (explicitNow) return false;
  if (rule === "E1" || rule === "E2" || rule === "S0" || rule === "R1") return false;
  return pkg.missing_facts.length > 0 && !pkg.collection_already_attempted;
}
