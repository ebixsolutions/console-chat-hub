import {
  buildCanonicalRetrievalQuery,
  deriveCurrentRequirementSnapshot,
  resolveConversationMemoryResponse,
  workflow5ShortTopicHint,
} from "../../supabase/functions/_shared/conversation-runtime-state.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function newest(turns: string[]) {
  return [...turns].reverse().map((content) => ({ role: "visitor", content }));
}

Deno.test("W7 numeric state keeps product_count isolated from staff_count", () => {
  const snapshot = deriveCurrentRequirementSnapshot([
    "我而家大約30件商品。",
    "其實年尾可能80件。",
    "再諗清楚，可能去到300件。",
    "記住最新係300，唔係30。",
    "我有兩個staff。",
    "再加兩個staff一齊管理，即係目前4個staff。",
  ]);
  assert(snapshot.product_count === 300, `product_count=${snapshot.product_count}`);
  assert(snapshot.staff_count === 4, `staff_count=${snapshot.staff_count}`);
});

Deno.test("W7 latest requirements summary never rewrites 300 SKU as staff count", () => {
  const q = "請列出「最新」需求，唔好列舊條件。";
  const r = resolveConversationMemoryResponse(q, newest([
    "我而家大約30件商品。",
    "再諗清楚，可能去到300件。",
    "記住最新係300，唔係30。",
    "我有兩個staff。",
    "App而家又有興趣。",
    "我想要Push。",
    "亦想用CRM。",
    "會員等級都會用。",
    "再加兩個staff一齊管理，即係目前4個staff。",
    q,
  ]));
  assert(Boolean(r), "missing memory response");
  assert(r!.includes("300"), r!);
  assert(r!.includes("4 位 staff"), r!);
  assert(!/商品數量：約 4 件/.test(r!), r!);
});

Deno.test("W7 Growth short price follow-up inherits plan subject for retrieval", () => {
  const latest = "直接講已發布價錢。";
  const q = buildCanonicalRetrievalQuery(latest, newest([
    "hi 想問 Smoke Test Growth plan 點計？",
    "係 yearly 定 monthly ga？",
    latest,
  ]));
  assert(q.mode === "contextual", `mode=${q.mode}`);
  assert(/Smoke Test Growth/i.test(q.query), q.query);
  assert(/price|價錢|價格|billing/i.test(q.query), q.query);
});

Deno.test("W7 model price/noise follow-up inherits exact model token", () => {
  const price = buildCanonicalRetrievalQuery("呢部而家KB寫幾錢？", newest([
    "先睇AeroHome WindowCool 10，型號AWC10-C。",
    "呢部而家KB寫幾錢？",
  ]));
  assert(/AWC10-C/i.test(price.query), price.query);
  const noise = buildCanonicalRetrievalQuery("室內噪音幾多dB？", newest([
    "先睇AeroHome WindowCool 10，型號AWC10-C。",
    "呢部而家KB寫幾錢？",
    "室內噪音幾多dB？",
  ]));
  assert(/AWC10-C/i.test(noise.query), noise.query);
});

Deno.test("W7 delivery and refund direct questions get domain retrieval targets", () => {
  const delivery = buildCanonicalRetrievalQuery("九龍係咪香港標準送貨範圍？", newest(["九龍係咪香港標準送貨範圍？"]));
  assert(/delivery policy/i.test(delivery.query), delivery.query);
  const refund = buildCanonicalRetrievalQuery("KB有冇固定退款百分比？", newest(["KB有冇固定退款百分比？"]));
  assert(/returns|refunds|fixed-percentage/i.test(refund.query), refund.query);
});

Deno.test("W7 staff follow-up keeps Growth subject after SKU question", () => {
  const q = buildCanonicalRetrievalQuery("staff limit呢？", newest([
    "正常問題：Growth SKU limit幾多？",
    "staff limit呢？",
  ]));
  assert(q.mode === "contextual", q.mode);
  assert(/Growth/i.test(q.query), q.query);
  assert(/staff/i.test(q.query), q.query);
});

Deno.test("W7 known/unknown summary derives current SKU instead of frozen hard-code", () => {
  const latest = "按我已確認資料，邊啲你知、邊啲未知？";
  const r = resolveConversationMemoryResponse(latest, newest([
    "如果我而家有 website already 呢？",
    "大約300 sku。",
    "我主要做 hk。",
    "but sometimes ship macau。",
    "Growth plan app included？",
    "push notification included？",
    "50 AI SEO係咩？",
    latest,
  ]));
  assert(Boolean(r), "missing summary");
  assert(r!.includes("300"), r!);
  assert(!/一千多|1,000\+/.test(r!), r!);
});

Deno.test("W7 combined CRM/member short topic is not generic", () => {
  const hint = workflow5ShortTopicHint("CRM同會員等級有冇？");
  assert(hint === "CRM and membership tiers", String(hint));
});

Deno.test("W7 generate-reply keeps high-risk threshold but improves standard recall", async () => {
  const source = await Deno.readTextFile(new URL("../../supabase/functions/generate-reply/index.ts", import.meta.url));
  assert(source.includes('const minScore = isHighRisk ? 0.78 : 0.45;'), "standard KB threshold not repaired");
  assert(/有冇\|有没有\|是否\|係咪/.test(source) && /退款\|退貨/.test(source), "informational refund classifier not repaired");
});
