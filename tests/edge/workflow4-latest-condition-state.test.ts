import {
  buildCanonicalRetrievalQuery,
  deriveCurrentRequirementSnapshot,
  resolveConversationMemoryResponse,
} from "../../supabase/functions/_shared/conversation-runtime-state.ts";

const case06Turns = [
  "我而家大約30件商品。",
  "想先睇最簡單方案。",
  "暫時唔需要App。",
  "得我一個人管理。",
  "只做香港。",
  "如果商品少，應該留意咩限制？",
  "50件商品限制如果有就講清楚。",
  "其實年尾可能80件。",
  "咁建議會唔會變？",
  "再諗清楚，可能去到300件。",
  "記住最新係300，唔係30。",
  "我有兩個staff。",
  "多人管理有咩要確認？",
  "之後可能做台灣。",
  "但目前主要市場仍然香港。",
  "App而家又有興趣。",
  "所以「唔要App」已經過時。",
  "我想要Push。",
  "亦想用CRM。",
  "會員等級都會用。",
  "再加兩個staff一齊管理。",
  "如果只睇我第一句會推薦錯，係咪？",
];

function newestFirst(extra: string[] = []) {
  return [...case06Turns, ...extra].map((content) => ({ role: "visitor", content })).reverse();
}

Deno.test("Workflow 4 projects latest customer requirements and supersedes stale values", () => {
  const state = deriveCurrentRequirementSnapshot(case06Turns);
  if (state.product_count !== 300) throw new Error(`product_count=${state.product_count}`);
  if (state.staff_count !== 4) throw new Error(`staff_count=${state.staff_count}`);
  if (state.app_interest !== true) throw new Error(`app_interest=${state.app_interest}`);
  for (const feature of ["Push", "CRM", "會員等級"]) {
    if (!state.desired_features.includes(feature)) throw new Error(`missing feature ${feature}: ${JSON.stringify(state)}`);
  }
  if (state.current_market !== "hong_kong") throw new Error(`current_market=${state.current_market}`);
  if (!state.future_markets.includes("taiwan")) throw new Error(`future Taiwan missing: ${JSON.stringify(state.future_markets)}`);
  if (state.future_markets.includes("hong_kong")) throw new Error("current Hong Kong leaked into future markets");
});

Deno.test("Workflow 4 deterministic latest-requirements memory answer excludes superseded conditions", () => {
  const latest = "請列出「最新」需求，唔好列舊條件。";
  const reply = resolveConversationMemoryResponse(latest, newestFirst([latest]));
  if (!reply) throw new Error("latest-requirements reply missing");
  for (const expected of ["300", "4 位 staff", "App：有興趣", "Push", "CRM", "會員等級", "目前主要市場：香港", "未來可能市場：台灣"]) {
    if (!reply.includes(expected)) throw new Error(`missing ${expected}: ${reply}`);
  }
  if (/商品數量：約 30 件/.test(reply) || /商品數量：約 80 件/.test(reply)) throw new Error(`stale quantity leaked: ${reply}`);
  if (reply.includes("App：目前不需要")) throw new Error(`stale App preference leaked: ${reply}`);
  if (reply.includes("管理人手：2 位 staff")) throw new Error(`stale staff count leaked: ${reply}`);
});

Deno.test("Workflow 4 plan-limit follow-up carries full current requirement snapshot into retrieval", () => {
  const latest = "基於最新需求，一句講我應該再核實邊幾項方案限制。";
  const query = buildCanonicalRetrievalQuery(latest, newestFirst(["請列出「最新」需求，唔好列舊條件。", latest]));
  if (query.mode !== "contextual") throw new Error(`mode=${query.mode}`);
  for (const expected of ["300", "4 位 staff", "App：有興趣", "Push", "CRM", "會員等級", "目前主要市場：香港", "未來可能市場：台灣"]) {
    if (!query.query.includes(expected)) throw new Error(`retrieval snapshot missing ${expected}: ${query.query}`);
  }
  if (query.query.includes("App：目前不需要")) throw new Error(`stale App state in retrieval: ${query.query}`);
});

Deno.test("Workflow 4 T24 latest-plan-limit answer is deterministic and excludes stale unrelated KB topic", () => {
  const latest = "基於最新需求，一句講我應該再核實邊幾項方案限制。";
  const reply = resolveConversationMemoryResponse(latest, newestFirst(["請列出「最新」需求，唔好列舊條件。", latest]));
  if (!reply) throw new Error("T24 deterministic reply missing");
  for (const expected of ["300", "4 位 staff", "App", "Push", "CRM", "會員等級", "香港", "台灣", "商品數量上限", "管理人手名額"]) {
    if (!reply.includes(expected)) throw new Error(`T24 missing ${expected}: ${reply}`);
  }
  for (const stale of ["30 件", "80 件", "2 位 staff", "App：目前不需要", "四電一腦", "雪櫃容積"]) {
    if (reply.includes(stale)) throw new Error(`T24 stale/unrelated topic leaked: ${stale}: ${reply}`);
  }
});
