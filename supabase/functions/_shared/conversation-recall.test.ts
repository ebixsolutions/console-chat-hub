import { customerDimensionPair, customerSunExposure } from "./commerce-state-authority.ts";
import {
  type ConversationRecallInput,
  prepareConversationRecall,
  hasAttestedUnlabelledCustomerRecall,
  recallClarification,
  renderConversationRecall,
  resolveConversationRecall,
} from "./conversation-recall.ts";
import {
  type ConversationCommerceState,
  createEmptyConversationCommerceState,
} from "./commerce-state-contract.ts";
import {
  buildCommerceEntityHints,
  reduceTurn,
} from "./commerce-state-runtime.ts";
import {
  buildCanonicalConversationMemory,
  type CanonicalConversationMemory,
} from "./conversation-long-memory.ts";
import { extractGenericCommerceEntity } from "./commerce-capability-runtime.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
export function recallFixture(
  question = "冷氣數量是多少？",
): ConversationRecallInput {
  const scope = {
    conversation_id: "00000000-0000-4000-8000-000000000001",
    company_id: "00000000-0000-4000-8000-000000000002",
    source_message_id: "00000000-0000-4000-8000-000000000100",
  };
  const state: ConversationCommerceState = {
    version: "commerce-state-1.0.0",
    language: "zh-TW",
    current_intent: "appliance enquiry",
    current_topic: "冷氣",
    latest_corrections: ["change from A block to B block"],
    unresolved_items: [],
    customer_constraints: {},
    entities: [
      {
        entity_id: "ac-wall",
        category: "aircon",
        quantity: 2,
        status: "researching",
        attributes: {
          name: "冷氣",
          room_size: "180 sqft",
          horsepower: 1.5,
          region: "hong_kong",
        },
        constraints: { brand_required: false },
        provenance: { source_type: "customer", source_message_id: "ac-source" },
      },
      {
        entity_id: "washer-front",
        category: "washer",
        quantity: 1,
        status: "deferred",
        attributes: { name: "洗衣機", region: "hong_kong" },
        constraints: {},
        provenance: {
          source_type: "customer",
          source_message_id: "washer-source",
        },
      },
    ],
    quotes: [5600, 8000].map((amount) => ({
      quote_id: `old-${amount}`,
      entity_id: "ac-wall",
      amount,
      currency: "HKD",
      quote_type: "customer_reported_historical",
      validity_status: "historical",
      conditions: {},
      provenance: {
        source_type: "customer",
        source_message_id: `quote-${amount}`,
      },
    })),
    delivery: {
      address: "測試屋苑 B block 9樓",
      recipient_name: "測試收件人甲",
      recipient_phone: "90000001",
      preferred_date: "星期六",
      confirmed: false,
      provenance: {
        source_type: "customer",
        source_message_id: "delivery-source",
      },
    },
    installation: { items: [], site_conditions: {}, pending_checks: [] },
    conversion: {
      funnel_stage: "quotation",
      quotation_status: "draft",
      order_status: "none",
      payment_status: "none",
      confirmed_entity_ids: [],
      tentative_entity_ids: ["ac-wall"],
      cancelled_entity_ids: [],
    },
    metadata: {},
  };
  const memory: CanonicalConversationMemory = {
    version: "conversation-memory-1.0.0",
    ...scope,
    memory_revision: 100,
    commerce_state_revision: 20,
    current_goal: "Compare appliance requirements",
    current_topic: "冷氣",
    active_entities: [{
      entity_id: "ac-wall",
      type: "aircon",
      brand: null,
      model: null,
      quantity: 2,
      status: "active",
      region: "hong_kong",
      current_requirements: {
        room_size: "180 sqft",
        horsepower: 1.5,
        brand_required: false,
      },
      transaction_state: {},
    }],
    latest_corrections: ["address is B block, not A block"],
    current_customer_facts: [],
    customer_preferences: ["我偏好星期六送貨"],
    active_constraints: [],
    current_regions: [{ region: "hong_kong", temporal_scope: "current" }, {
      region: "taiwan",
      temporal_scope: "future",
    }],
    transaction_summary: {
      quotation: "draft",
      order: "none",
      payment: "none",
      delivery: "not_confirmed",
      installation: "unknown",
    },
    historical_facts: [],
    cancelled_or_superseded: [{
      key: "entity:washer-front",
      value: "deferred",
      authority: "canonical_commerce",
      entity_id: "washer-front",
    }],
    open_questions: [],
    pending_actions: [],
    prior_topics: [],
    grounded_reference_lineage: [],
    handoff_relevant_state: {},
    updated_from_turn: 100,
    updated_at: "2026-09-15T00:00:00Z",
  };
  return {
    ...scope,
    question,
    memory,
    commerce: { ...scope, revision: 20, state },
    trusted_visitor_source_status: "verified",
    trusted_visitor_source_rows: [
      { id: "ac-source", content: "I requested aircon room size 180 sqft and horsepower 1.5 hp; brand is not mandatory." },
      { id: "delivery-source", content: "My delivery address is 測試屋苑 B block 9樓; recipient 測試收件人甲 and phone 90000001." },
    ],
  };
}
function answer(q: string, mutate?: (input: ConversationRecallInput) => void) {
  const input = recallFixture(q);
  mutate?.(input);
  const before = JSON.stringify(input);
  const d = resolveConversationRecall(input);
  assert(JSON.stringify(input) === before, "resolver mutated source");
  assert(d.handled, `${q}: ${JSON.stringify(d)}`);
  const reply = renderConversationRecall(
    d,
    /[\u4e00-\u9fff]/.test(q) ? "zh-TW" : "en",
  );
  assert(reply && reply.length <= 4096, "missing/bounded reply");
  return { d, reply };
}

export function t17ProductionFailureFixture(
  question = "現在實際保留幾多部冷氣？只回答數量和被取消項目。",
): ConversationRecallInput {
  const conversation_id = "17000000-0000-4000-8000-000000000001";
  const company_id = "17000000-0000-4000-8000-000000000002";
  const turns = [
    "我要三部冷氣：細房、大房和客廳各一部。",
    "更正：客廳那部暫時取消，只保留兩間房的兩部。",
    question,
  ];
  let state = createEmptyConversationCommerceState();
  for (let index = 0; index < turns.length; index++) {
    const source_message_id = `17000000-0000-4000-8000-00000000010${index}`;
    state = reduceTurn(state, {
      conversation_id,
      company_id,
      source_message_id,
      text: turns[index],
      language: "zh-TW",
      history: turns.slice(0, index).map((content) => ({
        role: "visitor",
        content,
      })),
    }, buildCommerceEntityHints([
      turns[index],
      ...turns.slice(0, index).reverse(),
    ]));
  }
  const source_message_id = "17000000-0000-4000-8000-000000000102";
  const memory = buildCanonicalConversationMemory({
    conversation_id,
    company_id,
    source_message_id,
    commerce_state_revision: 3,
    commerce_state: state,
    newest_first: turns.slice().reverse().map((content, index) => ({
      id: `17000000-0000-4000-8000-00000000020${index}`,
      role: "visitor",
      content,
    })),
    visitor_turn_count: 3,
    source_created_at: "2026-09-17T00:00:00Z",
    next_memory_revision: 3,
  });
  return {
    conversation_id,
    company_id,
    source_message_id,
    question,
    memory,
    commerce: {
      conversation_id,
      company_id,
      source_message_id,
      revision: 3,
      state,
    },
  };
}

// Regression scenarios derived from the supplied production failure categories.
// They are NOT the unavailable original production transcript or a production replay.
Deno.test("C3 semantic T06 initial AC quantity", () => {
  const { reply } = answer("一開始我要幾部冷氣？", (i) => {
    i.commerce!.state.entities[0].quantity = 3;
    i.memory!.active_entities[0].quantity = 3;
  });
  assert(reply.includes("3"));
});


Deno.test("Task3C original Ticket source sequence stops six-browser-tabs from becoming three-AC quantity",()=>{
  const conversation_id="70000000-0000-4000-8000-000000000001";
  const company_id="70000000-0000-4000-8000-000000000002";
  const turns=[
    "早晨，我間書房大約95呎，想揀部窗口冷氣。見到樂聲 CW-SUL70BA，呢款係幾多匹，同埋有咩主要功能？",
    "更正，實際只係8個分頁，預算想慳啲。請比較 RAM、CPU、SSD 升級優先次序，邊啲可以暫緩？暫時唔使查店舖售價或庫存。",
    "再更正，依家只會開6個分頁，其他文書、視像會議同慳錢要求不變。",
    "我要為兩間睡房同一個客廳選購冷氣，即合共三部；這是測試資料。",
  ];
  // Phase1 NO INDUSTRY: unknown original count stays unknown (zero marker)
  // until the independent source-authored three-unit goal is actually stated.
  let state=createEmptyConversationCommerceState();
  for(let index=0;index<turns.length;index++){
    const source_message_id="70000000-0000-4000-8000-"+String(index+1).padStart(12,"0");
    state=reduceTurn(state,{
      conversation_id,company_id,source_message_id,text:turns[index],
      language:"zh-TW",history:turns.slice(0,index).map(content=>({role:"visitor",content})),
    },buildCommerceEntityHints(turns.slice(0,index+1).reverse()));
    const old=state.entities.find(e=>e.model==="CW-SUL70BA");
    assert(old && old.quantity===0 && old.attributes.quantity_basis==="system_default",
      "unknown original item and explicit SKU must survive without assumed appliance quantity");
    assert(old.provenance.source_message_id==="70000000-0000-4000-8000-000000000001",
      "browser 8/6 cannot replace the original Visitor source");
    assert(state.current_industry===null,"no industry flow can activate");
    if(index===3){
      const fresh=state.entities.filter(e=>e.entity_id!==old.entity_id &&
        e.provenance.source_message_id===source_message_id);
      assert(fresh.length===1 && fresh[0].quantity===3,"new source-owned goal needs exactly three");
      assert(fresh[0].model===null,"new goal must not inherit historical model");
      assert(Object.keys((fresh[0].attributes.room_sizes??{}) as Record<string,unknown>).length===0,
        "new goal must not inherit prior room sizes");
    }
  }
});
// Task3C T06 v289 actual-source shaped regression (isolated, redacted).
// This keeps the observed six-versus-three contradiction, original customer
// source, old legacy SKU and exact fresh question. It is not a Hosted PASS.
function t06Turn2SourceConflictFixture(): ConversationRecallInput {
  const input = recallFixture("我剛才說總共要幾多部冷氣？只回答數量。");
  const sourceId = "60000000-0000-4000-8000-000000000100";
  const entity = input.commerce!.state.entities[0];
  entity.entity_id = "air_conditioner:unscoped";
  entity.category = "air_conditioner";
  entity.model = "CW-SUL70BA";
  entity.quantity = 6;
  entity.provenance = { source_type: "customer", source_message_id: sourceId };
  entity.attributes = { ...entity.attributes, product_name:"CW-SUL70BA", room_sizes:{study:"95平方呎"} };
  input.memory!.active_entities = [{
    ...input.memory!.active_entities[0],
    entity_id:"air_conditioner:unscoped",type:"air_conditioner",
    quantity:6, model:"CW-SUL70BA",
  }];
  input.memory!.current_customer_facts = [{
    key:"quantity",value:3,authority:"customer",
    entity_id:null,region:null,source_message_id:sourceId,
  }];
  input.trusted_visitor_source_rows = [{
    id:sourceId,
    content:"我要為兩間睡房同一個客廳選購冷氣，即合共三部；這是測試資料。",
  }];
  return input;
}
Deno.test("Task3C v289 T06 quoted customer total uses original Visitor evidence, not stale canonical six", () => {
  const input=t06Turn2SourceConflictFixture();
  const before=JSON.stringify(input);
  const result=prepareConversationRecall(input,"zh-TW");
  assert(JSON.stringify(input)===before,"recall cannot mutate canonical state");
  assert(result.decision.handled&&result.decision.value===3,JSON.stringify(result.decision));
  assert(result.decision.provenance.evidence.length===1 &&
    result.decision.provenance.evidence[0].source_kind==="attested_customer_utterance",JSON.stringify(result.decision));
  assert((result.reply??"").includes("3")&&!(result.reply??"").includes("6"),String(result.reply));
  assert(input.commerce!.state.entities[0].quantity===6,"read must not mutate legacy bad commerce state");
});
for(const [label,change] of [
  ["missing source", (x:ConversationRecallInput)=>{x.trusted_visitor_source_rows=[];}],
  ["wrong quoted number", (x:ConversationRecallInput)=>{x.trusted_visitor_source_rows![0].content="客人合共四部。";}],
  ["wrong source ID", (x:ConversationRecallInput)=>{x.trusted_visitor_source_rows![0].id="60000000-0000-4000-8000-000000000999";}],
  ["tenant changed", (x:ConversationRecallInput)=>{x.company_id="other-tenant";}],
  ["not actually a prior-speech request", (x:ConversationRecallInput)=>{x.question="現在實際要幾多部冷氣？";}],
] as const)Deno.test("Task3C v289 T06 unverified quantity fails closed: "+label,()=>{
  const input=t06Turn2SourceConflictFixture();change(input);
  const result=resolveConversationRecall(input);
  assert(!result.handled && result.reason==="AMBIGUOUS",JSON.stringify(result));
});
Deno.test("Task3C cross-industry customer-owned count has a different source type from merchant price",()=>{
  const input=t06Turn2SourceConflictFixture();
  input.question="How many licenses did I mention earlier?";
  input.trusted_visitor_source_rows![0].content="We need 3 licenses for the new service.";
  const recall=resolveConversationRecall(input);
  assert(recall.handled && recall.value===3,JSON.stringify(recall));
  input.question="What is the current official price of those licenses?";
  const merchant=resolveConversationRecall(input);
  assert(!merchant.handled && merchant.reason==="CURRENT_KB_REQUIRED",JSON.stringify(merchant));
});


for (const [industry,sourceText,question] of [
  ["retail","我之前說合共要三件商品。","我之前說要幾多件商品？"],
  ["saas","We need 3 licenses for the new service.","How many licenses did I mention earlier?"],
  ["beauty","我之前提過要三堂美容療程。","我之前提過幾多堂美容療程？"],
  ["restaurant","我先前說想要三份套餐。","我先前說要幾多份套餐？"],
  ["education","我之前要求三課英語課程。","我之前要求幾多課英語課程？"],
] as const) Deno.test("Task3C customer quantity source proof is industry-neutral: "+industry,()=>{
  const input=t06Turn2SourceConflictFixture();
  input.question=question;
  input.trusted_visitor_source_rows![0].content=sourceText;
  const result=resolveConversationRecall(input);
  assert(result.handled && result.value===3,JSON.stringify(result));
});
Deno.test("Task3C customer source number cannot cross into a different service/product subject",()=>{
  const input=t06Turn2SourceConflictFixture();
  input.question="How many licenses did I mention earlier?";
  input.trusted_visitor_source_rows![0].content="We need 3 refrigerators.";
  const result=resolveConversationRecall(input);
  assert(!result.handled&&result.reason==="AMBIGUOUS",JSON.stringify(result));
});
Deno.test("C3 semantic T17 corrected active quantity excludes deferred item", () => {
  const { d, reply } = answer("更正後冷氣數量是多少？");
  assert(d.value === 2 && !reply.includes("3"));
});
Deno.test("C3 T17 exact production reproduction retains two and excludes living room", () => {
  const input = t17ProductionFailureFixture();
  assert(
    input.commerce?.state.entities.length === 1 &&
      input.commerce.state.entities[0].status === "cancelled",
    "fixture must reproduce the collapsed inactive canonical entity",
  );
  const decision = resolveConversationRecall(input);
  assert(decision.handled, JSON.stringify(decision));
  const reply = renderConversationRecall(decision, "zh-TW") ?? "";
  assert(
    (reply.includes("2") || reply.includes("兩")) && reply.includes("客廳") &&
      /取消/.test(reply) && !reply.includes("3 部"),
    reply,
  );
});
Deno.test("C3 T17 canonical active correction outranks stale inactive quantity", () => {
  const input = t17ProductionFailureFixture();
  const cancelled = input.commerce!.state.entities[0];
  cancelled.quantity = 99;
  input.commerce!.state.entities.push({
    ...cancelled,
    entity_id: "air_conditioner:unscoped",
    quantity: 2,
    status: "tentative",
    provenance: {
      source_type: "customer",
      source_message_id: "17000000-0000-4000-8000-000000000101",
    },
  });
  input.memory!.active_entities = [{
    entity_id: "air_conditioner:unscoped",
    type: "air_conditioner",
    brand: null,
    model: null,
    quantity: 2,
    status: "active",
    region: null,
    current_requirements: {},
    transaction_state: {},
  }];
  const decision = resolveConversationRecall(input);
  assert(decision.handled, JSON.stringify(decision));
  const quantity = decision.provenance.evidence.find((e) =>
    e.fact_type === "quantity"
  );
  const cancelledStatus = decision.provenance.evidence.find((e) =>
    e.fact_type === "entity_status"
  );
  assert(
    quantity?.value === 2 &&
      quantity.entity_id === "air_conditioner:unscoped" &&
      cancelledStatus?.entity_id === "air_conditioner:living_room",
    JSON.stringify(decision),
  );
});
Deno.test("C3 T17 explicit retained correction ignores inactive stored quantity", () => {
  const input = t17ProductionFailureFixture();
  input.commerce!.state.entities[0].quantity = 99;
  const decision = resolveConversationRecall(input);
  assert(decision.handled, JSON.stringify(decision));
  const quantity = decision.provenance.evidence.find((e) =>
    e.fact_type === "quantity"
  );
  assert(
    quantity?.value === 2 && quantity.entity_id === null &&
      quantity.source_kind === "retained_customer_correction_checkpoint",
    JSON.stringify(decision),
  );
});
Deno.test("C3 T17 direct inactive quantity remains genuinely ambiguous", () => {
  const input = t17ProductionFailureFixture("客廳冷氣有幾多部？");
  const decision = resolveConversationRecall(input);
  assert(
    !decision.handled && decision.reason === "AMBIGUOUS" &&
      decision.detail === "INACTIVE_ENTITY_NOT_CURRENT_QUANTITY",
    JSON.stringify(decision),
  );
});
Deno.test("C3 semantic T40 corrected B-block address", () => {
  const { reply, d } = answer("我更正後的收貨地址是什麼？");
  assert(
    reply.includes("B block") && !reply.includes("A block") &&
      d.authority === "CANONICAL_COMMERCE_STATE",
  );
});
Deno.test("C3 semantic T50 early room-size retention", () =>
  assert(answer("之前提供的房間面積是多少？").reply.includes("180 sqft")));
Deno.test("C3 semantic T57 corrected address after topic switch", () => {
  const { reply } = answer("What is my corrected delivery address?", (i) => {
    i.memory!.current_topic = "washer";
  });
  assert(reply.includes("B block") && !reply.includes("A block"));
});
Deno.test("C3 semantic T58 Saturday preference is not a promise", () => {
  const { reply } = answer("我偏好星期幾送貨？");
  assert(reply.includes("星期六") && reply.includes("不代表"));
});
Deno.test("C3 semantic T68 horsepower recall", () =>
  assert(answer("我之前冷氣要求幾匹？").reply.includes("1.5")));
Deno.test("C3 semantic T69 brand-not-mandatory preserves false", () => {
  const { d, reply } = answer("我要求的冷氣品牌是否一定要指定？");
  assert(d.value === false && reply.includes("並非必要"));
});
Deno.test("C3 semantic T71 historical 5600 must not be reused", () => {
  const { reply } = answer("舊報價 HKD 5,600 不應沿用，記得嗎？");
  assert(
    !reply.includes("5600") && !reply.includes("5,600") &&
      reply.includes("不列入"),
  );
});
Deno.test("C3 semantic T96 recipient/contact readback", () => {
  const { reply, d } = answer("請讀回我的收貨人和聯絡電話？");
  assert(
    reply.includes("測試收件人甲") && reply.includes("90000001") &&
      d.provenance.evidence.length === 2,
  );
});
Deno.test("C3 semantic T98 quotation is not an order", () => {
  const { reply } = answer("我現在是報價階段還是正式訂單？");
  assert(reply.includes("草擬") && reply.includes("尚未形成正式訂單"));
});

for (
  const q of [
    "Quantity?",
    "How many air conditioners did I ask for?",
    "那個數量呢？",
    "冷氣幾部？",
    "幾多部冷氣？",
  ]
) {
  Deno.test(`C3 quantity paraphrase: ${q}`, () =>
    assert(answer(q).d.value === 2));
}
for (
  const q of [
    "地址？",
    "What is my address?",
    "我更正後係邊座？",
    "收貨地址讀返一次？",
  ]
) {
  Deno.test(`C3 address paraphrase: ${q}`, () =>
    assert(answer(q).reply.includes("B block")));
}
for (
  const q of [
    "What is the current price?",
    "冷氣有現貨嗎？",
    "保養多久？",
    "我之前的房間面積和目前官方價錢是多少？",
    "What horsepower does this model have?",
    "之前 HKD 8000 的報價現在仍然有效嗎？請不要當作現價。",
    "What is the official delivery policy?",
    "What is my warranty eligibility?",
  ]
) {
  Deno.test(`C3 C1 external firewall: ${q}`, () => {
    const d = resolveConversationRecall(recallFixture(q));
    assert(!d.handled && d.reason === "CURRENT_KB_REQUIRED", JSON.stringify(d));
  });
}
for (
  const q of [
    "我想要兩部冷氣",
    "請記住我的地址",
    "Change the quantity to 4",
    "Please remember that I prefer Saturday",
    "已經付款",
  ]
) {
  Deno.test(`C3 does not replace customer update: ${q}`, () => {
    const d = resolveConversationRecall(recallFixture(q));
    assert(!d.handled && d.reason === "NOT_A_RECALL_QUERY", JSON.stringify(d));
  });
}
Deno.test("C3 explicit handoff outranks recall", () => {
  const i = recallFixture();
  i.explicit_handoff = true;
  const d = resolveConversationRecall(i);
  assert(!d.handled && d.reason === "NOT_A_RECALL_QUERY");
});
for (
  const field of ["company_id", "conversation_id", "source_message_id"] as const
) {
  Deno.test(`C3 rejects memory ${field} mismatch`, () => {
    const i = recallFixture();
    i.memory![field] = "other";
    const d = resolveConversationRecall(i);
    assert(!d.handled && d.reason === "AMBIGUOUS");
  });
}
Deno.test("C3 rejects stale memory revision", () => {
  const i = recallFixture();
  i.memory!.commerce_state_revision = 19;
  const d = resolveConversationRecall(i);
  assert(!d.handled && d.reason === "AMBIGUOUS");
});
Deno.test("C3 rejects commerce tenant mismatch", () => {
  const i = recallFixture();
  i.commerce!.company_id = "other";
  const d = resolveConversationRecall(i);
  assert(!d.handled && d.reason === "AMBIGUOUS");
});

Deno.test("C3 retained persisted Memory lineage is recap-only and fails closed", () => {
  const input = recallFixture("Give me a recap of everything.");
  const memory = input.memory!, commerce = input.commerce!;
  memory.source_message_id = "retained-semantic-source";
  commerce.source_message_id = "earlier-commerce-source";
  memory.question_lifecycle = [];
  const proof = {
    contract: "persisted-memory-readback-v1" as const,
    conversation_id: input.conversation_id, company_id: input.company_id,
    source_message_id: memory.source_message_id, memory_revision: memory.memory_revision,
    commerce_state_revision: commerce.revision, memory_hash: "a".repeat(64),
  };
  const valid = { ...input, trusted_persisted_memory_readback: proof };
  const before = JSON.stringify(valid);
  const recap = prepareConversationRecall(valid, "en");
  assert(recap.decision.handled && recap.decision.fact_type === "summary" && recap.reply,
    "verified retained Memory did not resolve summary");
  assert(JSON.stringify(valid) === before, "recall mutated retained state");
  for (const [name, change] of [
    ["omitted", { trusted_persisted_memory_readback: null }],
    ["contract", { trusted_persisted_memory_readback: { ...proof, contract: "invalid" as typeof proof.contract } }],
    ["company", { trusted_persisted_memory_readback: { ...proof, company_id: "wrong" } }],
    ["conversation", { trusted_persisted_memory_readback: { ...proof, conversation_id: "wrong" } }],
    ["source", { trusted_persisted_memory_readback: { ...proof, source_message_id: "wrong" } }],
    ["memory_revision", { trusted_persisted_memory_readback: { ...proof, memory_revision: proof.memory_revision + 1 } }],
    ["commerce_revision", { trusted_persisted_memory_readback: { ...proof, commerce_state_revision: proof.commerce_state_revision + 1 } }],
    ["stale_memory", { memory: { ...memory, commerce_state_revision: commerce.revision - 1 } }],
    ["source_empty", { memory: { ...memory, source_message_id: "" }, trusted_persisted_memory_readback: { ...proof, source_message_id: "" } }],
    ["hash", { trusted_persisted_memory_readback: { ...proof, memory_hash: "invalid" } }],
    ["non_recap", { question: "How many air conditioners?" }],
  ] as const) {
    const rejected = resolveConversationRecall({ ...valid, ...change });
    assert(!rejected.handled && rejected.reason === "AMBIGUOUS", `lineage ${name} accepted`);
  }
  // The prior Commerce-source path continues to work without the new private proof.
  memory.source_message_id = commerce.source_message_id;
  const existing = resolveConversationRecall(input);
  assert(existing.handled && existing.fact_type === "summary", "existing source path regressed");
});
Deno.test("C3 canonical quantity wins over stale memory and correction", () => {
  const { d } = answer("冷氣幾部？", (i) => {
    i.memory!.active_entities[0].quantity = 99;
    i.memory!.latest_corrections = ["quantity is 8, not 99"];
  });
  assert(d.value === 2);
});
Deno.test("C3 current-KB memory facts cannot answer personal recall", () => {
  const i = recallFixture("我的聯絡電話？");
  delete i.commerce!.state.delivery.recipient_phone;
  i.memory!.current_customer_facts = [{
    key: "phone",
    value: "99999999",
    authority: "current_kb",
  }];
  const d = resolveConversationRecall(i);
  assert(!d.handled && d.reason === "AMBIGUOUS");
});
Deno.test("C3 personal contact stays out of unrelated quantity reply", () => {
  const { reply } = answer("冷氣幾部？");
  assert(!reply.includes("90000001") && !reply.includes("測試收件人"));
});
Deno.test("C3 typed personal fact readback retains source provenance", () => {
  const { d } = answer("我的聯絡電話？", (i) => {
    delete i.commerce!.state.delivery.recipient_phone;
    i.memory!.current_customer_facts = [{
      key: "phone",
      value: "90000002",
      authority: "customer",
      source_message_id: "original-phone-turn",
    }];
  });
  assert(
    d.value === "90000002" &&
      d.provenance.evidence[0].evidence_source_message_id ===
        "original-phone-turn",
  );
});
Deno.test("C3 correction precedes customer-owned fact", () => {
  const { reply } = answer("我的收貨地址？", (i) => {
    delete i.commerce!.state.delivery.address;
    i.memory!.current_customer_facts = [{
      key: "address",
      value: "A block",
      authority: "customer",
    }];
  });
  assert(reply.includes("B block") && !reply.includes("A block"));
});
Deno.test("C3 conflicting same-rank facts fail closed", () => {
  const i = recallFixture("我的聯絡電話？");
  delete i.commerce!.state.delivery.recipient_phone;
  i.memory!.current_customer_facts = [{
    key: "phone",
    value: "11111111",
    authority: "customer",
  }, { key: "contact_number", value: "22222222", authority: "customer" }];
  const d = resolveConversationRecall(i);
  assert(!d.handled && d.reason === "AMBIGUOUS");
});
Deno.test("C3 multiple active referents require disambiguation", () => {
  const i = recallFixture("那個數量呢？");
  i.commerce!.state.entities[1].status = "researching";
  i.commerce!.state.current_topic = "";
  i.memory!.current_topic = "";
  const d = resolveConversationRecall(i);
  assert(!d.handled && d.reason === "AMBIGUOUS");
});
Deno.test("C3 pronoun follows validated existing referent", () => {
  const { d } = answer("那個數量呢？", (i) => {
    i.commerce!.state.entities[1].status = "researching";
    i.referents = [{
      ref: "washer-front",
      confidence: 0.99,
      source: "persistent_state",
    }];
  });
  assert(
    d.value === 1 && d.provenance.evidence[0].entity_id === "washer-front",
  );
});
Deno.test("C3 model hint cannot invent a fact", () => {
  const { d } = answer("冷氣幾部？", (i) => {
    i.referents = [{
      ref: "invented",
      confidence: 1,
      source: "persistent_state",
    }];
  });
  assert(d.value === 2);
});
Deno.test("C3 unknown industry exact entity remains supported", () => {
  const { d } = answer("How many calibrators did I request?", (i) => {
    i.commerce!.state.entities = [{
      ...i.commerce!.state.entities[0],
      entity_id: "calibrators",
      category: "laboratory calibration service",
      quantity: 7,
      attributes: {},
    }];
    i.memory!.active_entities = [];
  });
  assert(d.value === 7);
});
Deno.test("C3 deferred item not reported as current quantity", () => {
  const d = resolveConversationRecall(recallFixture("洗衣機幾部？"));
  assert(!d.handled && d.reason === "AMBIGUOUS");
});
Deno.test("C3 old address not returned as current address", () => {
  const d = resolveConversationRecall(recallFixture("我的舊地址是什麼？"));
  assert(!d.handled && d.reason === "AMBIGUOUS");
});
Deno.test("C3 does not substitute HK address for Taiwan", () => {
  const d = resolveConversationRecall(recallFixture("台灣的收貨地址是什麼？"));
  assert(!d.handled && d.reason === "AMBIGUOUS");
});
Deno.test("C3 pending payment is not completed", () => {
  const { reply } = answer("付款狀態？", (i) => {
    i.commerce!.state.conversion.payment_status = "pending_payment";
  });
  assert(reply.includes("待付款") && !reply.includes("已付款"));
});
Deno.test("C3 unconfirmed delivery not promoted", () => {
  const { reply } = answer("送貨狀態？");
  assert(reply.includes("尚未確認") && !reply.includes("已安排送貨"));
});
Deno.test("C3 COMPONENT summary keeps structured evidence and renders customer language", () => {
  const { reply } = answer("Summarize our current requirements");
  assert(
    !reply.includes("###") && !reply.includes("8000") &&
      !reply.includes("5600"),
  );
});
Deno.test("C3 Cantonese and English requirement-recap paraphrases use structured recall", () => {
  for (const question of ["而家我冷氣要求係點？", "Can you recap my current air conditioner requirements?"]) {
    const { reply } = answer(question,(i)=>{
      // A bilingual identity comes from the customer's attested statement,
      // not an industry vocabulary or a model-invented referent.
      if(/air conditioner/i.test(question)){
        i.commerce!.state.entities[0].attributes.customer_subject_aliases=["air conditioner"];
        i.trusted_visitor_source_rows=(i.trusted_visitor_source_rows??[]).map(row=>
          row.id==="ac-source" ? {...row,content:row.content+" I also call this my air conditioner."}:row);
      }
    });
    assert(!reply.includes("###") && !reply.includes("washer-front") && !reply.includes("entity_id"), `${question}:${reply}`);
  }
});
Deno.test("C3 two-sentence Cantonese recap presents known corrected and deferred state", () => {
  const input = recallFixture("可唔可以用廣東話兩句講返我而家嘅要求？");
  input.commerce!.state.entities[0].attributes.room_sizes = { study: "105平方呎" };
  input.commerce!.state.entities[1].category = "refrigerator";
  input.commerce!.state.entities[1].constraints.max_width_mm = 610;
  input.commerce!.state.latest_corrections = ["書房 95 → 105 平方呎"];
  const result = prepareConversationRecall(input, "zh-TW");
  assert(result.reply, JSON.stringify(result));
  assert(result.decision.handled && result.reply.includes("105平方呎") &&
    result.reply.includes("610 mm") && result.reply.includes("暫緩"), JSON.stringify(result));
  assert(!result.reply.includes("95") && !result.reply.includes("請提供型號"), result.reply);
  assert(result.reply.split("。").filter(Boolean).length === 2, result.reply);
});
Deno.test("C3 renderer never invents unsupported decision", () =>
  assert(
    renderConversationRecall({
      handled: false,
      reason: "AMBIGUOUS",
      detail: "test",
      requested_facts: [],
    }) === null,
  ));
Deno.test("C3 clarification is bounded and not a re-request for known data", () =>
  assert(
    recallClarification("en").length < 200 &&
      !/please (tell|provide|confirm)/i.test(recallClarification("en")),
  ));

Deno.test("C3 field-scoped multi-entity recall", () => {
  const { d, reply } = answer("冷氣幾部，洗衣機是否暫緩？");
  assert(
    d.provenance.evidence.some((e) =>
      e.fact_type === "quantity" && e.value === 2 && e.entity_id === "ac-wall"
    ),
  );
  assert(reply.includes("暫緩") && !reply.includes("3 部"));
});
Deno.test("C3 two explicit entity quantities remain separate", () => {
  const { d } = answer("冷氣幾部，洗衣機幾部？", (i) => {
    i.commerce!.state.entities[1].status = "researching";
    i.memory!.cancelled_or_superseded = [];
  });
  assert(d.provenance.evidence.length === 2);
});
Deno.test("C3 boolean inversion is consistent across projections", () => {
  const { d } = answer("我的冷氣品牌要求？", (i) => {
    i.commerce!.state.entities[0].constraints = { brand_not_required: true };
    i.memory!.active_entities[0].current_requirements = {
      brand_optional: true,
    };
  });
  assert(d.value === false);
});
Deno.test("C3 product catalog count is not purchase quantity", () => {
  const i = recallFixture("我需要幾部？");
  i.commerce!.state.entities = [];
  i.memory!.active_entities = [];
  i.memory!.current_customer_facts = [{
    key: "product_count",
    value: 300,
    authority: "customer",
  }];
  const d = resolveConversationRecall(i);
  assert(!d.handled);
});
Deno.test("C3 old amount non-use is not current price validation", () => {
  const { reply } = answer(
    "Do not treat the old quote as current price. Do you remember?",
  );
  assert(!reply.includes("5600") && reply.includes("historical"));
});
Deno.test("C3 conflicting reconfirmed current amount prevents exclusion", () => {
  const i = recallFixture("舊報價5600不要沿用，記得嗎？");
  i.commerce!.state.quotes.push({
    ...i.commerce!.state.quotes[0],
    quote_id: "verified-new",
    quote_type: "current_verified",
    validity_status: "current",
  });
  const d = resolveConversationRecall(i);
  assert(!d.handled && d.reason === "AMBIGUOUS");
});
Deno.test("C3 missing room fact never substitutes a specification", () => {
  const i = recallFixture("我的房間面積是多少？");
  delete i.commerce!.state.entities[0].attributes.room_size;
  delete i.memory!.active_entities[0].current_requirements.room_size;
  i.memory!.historical_facts = [{
    key: "room_size",
    value: 999,
    authority: "historical",
  }];
  const d = resolveConversationRecall(i);
  assert(!d.handled && d.reason === "AMBIGUOUS");
});
Deno.test("C3 model referent cannot override explicit entity", () =>
  assert(
    answer("冷氣幾部？", (i) => {
      i.referents = [{
        ref: "washer-front",
        confidence: 1,
        source: "persistent_state",
      }];
    }).d.value === 2,
  ));
Deno.test("C3 multi-clause external fact is not partially satisfied", () => {
  const d = resolveConversationRecall(
    recallFixture("我的電話是什麼，冷氣官方保養多久？"),
  );
  assert(!d.handled && d.reason === "CURRENT_KB_REQUIRED");
});
Deno.test("C3 future and current regions stay labelled", () => {
  const { reply } = answer("我的市場範圍是什麼？");
  assert(
    reply.includes("hong_kong") && reply.includes("current") &&
      reply.includes("taiwan") && reply.includes("future"),
  );
});

Deno.test("C3 slot-free short recall uses prior fact type, never prior raw value", () => {
  const { d } = answer("那個呢？", (i) => {
    i.recent_questions = ["我之前冷氣要求幾匹？"];
  });
  assert(d.value === 1.5);
});
Deno.test("C3 slot-free short recall after external query still requires KB", () => {
  const i = recallFixture("那個呢？");
  i.recent_questions = ["What is the official warranty?"];
  const d = resolveConversationRecall(i);
  assert(!d.handled && d.reason === "CURRENT_KB_REQUIRED");
});
Deno.test("C3 unresolved short pronoun does not fall into KB", () => {
  const d = resolveConversationRecall(recallFixture("那個呢？"));
  assert(!d.handled && d.reason === "AMBIGUOUS");
});
Deno.test("C3 room size Cantonese paraphrase", () =>
  assert(answer("我之前講間房幾大？").reply.includes("180")));
Deno.test("C3 original quantity is not substituted after correction", () => {
  const i = recallFixture("一開始冷氣幾部？");
  i.memory!.latest_corrections = ["quantity is 2, not 3"];
  const d = resolveConversationRecall(i);
  assert(!d.handled && d.reason === "AMBIGUOUS");
});


const internalRecap = /###|(?:funnel_stage|quotation_status|order_status|payment_status|entity_id|commerce_state_revision|memory_revision|source_message_id)|\{[^}]*\}/;
for (const language of ["zh-TW", "zh-CN", "en"]) {
  Deno.test("C3 HOSTED category aliases and stored global operational checks " + language, () => {
    const i = recallFixture("Summarize our current requirements");
    i.commerce!.state.installation.pending_checks = ["Installation feasibility requires a site check"];
    const before = JSON.stringify(i);
    const r = prepareConversationRecall(i, language);
    assert(r.decision.handled && r.reply, JSON.stringify(r));
    assert(!/aircon|washer|ac-wall|washer-front/.test(r.reply), r.reply);
    // G-only: verified customer names remain literal in any requested locale;
    // unit is unspecified in the source and may not be invented.
    assert(r.reply.includes("冷氣"), r.reply);
    assert(r.reply.includes(language==="en"?"冷氣 for 2":"冷氣 2"), r.reply);
    assert(!r.reply.includes(language==="en"?"2 units":"2部"),"unattested unit");
    assert(r.reply.includes(language === "en" ? "site checks" : language === "zh-CN" ? "现场条件" : "現場條件"), r.reply);
    assert(!internalRecap.test(r.reply) && JSON.stringify(i) === before, r.reply);
    const scoped = prepareConversationRecall({ ...i, question: "Recap washer-front." }, language);
    assert(scoped.decision.handled && scoped.reply && !/site checks|现场条件|現場條件/.test(scoped.reply), JSON.stringify(scoped));
    i.commerce!.state.entities[0].attributes.unit = "seats";
    const explicit = prepareConversationRecall(i, language);
    assert(explicit.reply?.includes(language === "en" ? "2 seats" : "2席"), JSON.stringify(explicit));
  });
}
for (const [language, items, quote, order, payment, booking, site] of [
  ["zh-TW", "項目：", "報價階段：草擬中", "未建立訂單", "未有付款記錄", "預約要求仍需職員確認", "適用性仍要"],
  ["zh-CN", "项目：", "报价阶段：草拟中", "尚未建立订单", "没有付款记录", "预约要求仍需职员确认", "适用性仍需"],
  ["en", "Items:", "Quotation stage: draft", "Order: no order has been placed", "no payment record", "booking still needs staff confirmation", "Suitability still needs"],
] as const) {
  Deno.test("C3 COMPLETE global recap independent sections " + language, () => {
    const i = recallFixture("Summarize our current requirements");
    i.commerce!.state.entities[0].attributes.capabilities = { requires_booking: true, requires_site_check: true };
    const before = JSON.stringify(i);
    const r = prepareConversationRecall(i, language);
    assert(r.decision.handled && r.reply, JSON.stringify(r));
    for (const section of [items, quote, order, payment, booking, site]) assert(r.reply.includes(section), r.reply);
    assert(r.reply.includes(language === "en" ? "is paused" : language === "zh-CN" ? "已暂缓" : "已暫緩"), r.reply);
    assert(!internalRecap.test(r.reply) && r.reply.length <= 4096, r.reply);
    assert(JSON.stringify(i) === before, "global recap changed authoritative state");
  });
}
Deno.test("C3 COMPLETE scoped recap excludes portfolio transaction and unrelated inactive entities", () => {
  for (const [question, referents] of [
    ["Recap ac-wall.", []],
    ["Recap aircon.", []],
    ["Recap it.", [{ ref: "ac-wall", confidence: 1, source: "canonical_commerce" }]],
  ] as const) {
    const i = recallFixture(question);
    i.referents = [...referents];
    const r = prepareConversationRecall(i, "en");
    assert(r.decision.handled && r.reply, JSON.stringify(r));
    assert(!/Items:|Quotation|Order:|Payment:|washer|paused/i.test(r.reply), r.reply);
  }
});
Deno.test("C3 COMPONENT typed generic quantities bind before or after the named request, never a currency amount",()=>{
 for(const [text,quantity,unit,name] of [["I need PJ-274 subscription for 13 seats.",13,"seats","PJ-274 subscription"],["I also need MR-691 add-on with 7 units.",7,"units","MR-691 add-on"],["I need 4 sessions of BK-395 booking.",4,"sessions","BK-395 booking"]] as const){
   const e=extractGenericCommerceEntity(text);assert(e?.quantity===quantity && e.unit===unit && e.display_name===name,JSON.stringify(e));
 }
 for(const text of ["I need PJ-274 subscription for HKD 731.","I need MR-691 add-on for 284 dollars."]){assert(extractGenericCommerceEntity(text)===null,"currency became entity quantity");}
});
Deno.test("C3 COMPONENT recap accepts resolved KB source only with the current revision and matching company",()=>{
 const i=recallFixture("Summarize our current requirements");
 i.memory!.source_message_id="kb-question-source";
 i.memory!.question_lifecycle=[{source_message_id:"kb-question-source",text:"policy question",status:"resolved",entity_id:null,resolution_source_message_id:"kb-answer-source"}];
 assert(resolveConversationRecall(i).handled);
 i.memory!.question_lifecycle[0].status="pending";assert(!resolveConversationRecall(i).handled);
 i.memory!.question_lifecycle[0].status="resolved";i.memory!.commerce_state_revision=i.commerce!.revision-1;assert(!resolveConversationRecall(i).handled);
 i.memory!.commerce_state_revision=i.commerce!.revision;i.memory!.company_id="other-company";assert(!resolveConversationRecall(i).handled);
});
Deno.test("C3 COMPONENT absent-state recap requires an explicit verified-read receipt and valid scope",()=>{
 const i=recallFixture("What do I currently have noted?");i.memory=null;i.commerce=null;
 assert(!resolveConversationRecall(i).handled);
 i.empty_state_verified=true;const r=prepareConversationRecall(i,"en");
 assert(r.decision.handled && r.reply?.includes("No specific requirements are available yet"));
 i.company_id="";assert(!resolveConversationRecall(i).handled);
});
Deno.test("C3 COMPONENT semantic recap paraphrases share one read-only contract; external facts and mutations retain priority", () => {
  for (const q of ["What do I currently have noted?", "Summarize where we are now.", "Give me a quick recap of my current setup.", "What are my current requirements?", "Remind me what we have agreed so far.", "而家記低咗啲咩？", "幫我講返目前要求。", "總結一下而家個情況。"]){
    const input=recallFixture(q), result=prepareConversationRecall(input, /[一-龿]/.test(q)?"zh-TW":"en");
    assert(result.decision.handled && result.decision.fact_type==="summary", JSON.stringify({q,result}));
    assert(result.reply && !internalRecap.test(result.reply), JSON.stringify({q,result}));
  }
  for(const q of ["Change my current request to 5 units.","目前要5部冷氣。","而家要3個選項。","Cancel my current setup.","Summarize the current stock policy.","What is the current price?"]){
    const d=resolveConversationRecall(recallFixture(q));assert(!d.handled || d.fact_type!=="summary",JSON.stringify({q,d}));
  }
});
for (const [name,language,configure,expected] of [
  ["R1 English active corrected SaaS and deferred add-on","en",(i:ConversationRecallInput)=>{
    const s=i.commerce!.state;s.entities[0]={...s.entities[0],entity_id:"generic:qp-491-subscription",category:"subscription",quantity:12,attributes:{product_name:"QP-491 subscription",unit:"seats"}};
    s.entities[1]={...s.entities[1],entity_id:"generic:zx-682-add-on",category:"addon",attributes:{product_name:"ZX-682 add-on",unit:"items"}};
  },["QP-491 subscription at 12 seats","ZX-682 add-on for 1 item is paused"]],
  ["R2 Cantonese equivalent","zh-TW",(i:ConversationRecallInput)=>{i.commerce!.state.entities[0].attributes.room_sizes={study:"137平方呎"};},["137平方呎","暫緩"]],
  ["R3 requested Booking remains unconfirmed","en",(i:ConversationRecallInput)=>{i.commerce!.state.entities[0]={...i.commerce!.state.entities[0],category:"booking",quantity:5,attributes:{product_name:"BM-673 booking",unit:"sessions",requested_date:"2026-12-18",capabilities:{requires_booking:true}}};},["5 BM-673 sessions on 18 December 2026","still needs staff confirmation"]],
  ["R4 simple one entity","en",(i:ConversationRecallInput)=>{i.commerce!.state.entities=i.commerce!.state.entities.slice(0,1);},["冷氣 for 2"]],
  ["R5 no active entity or business goal","en",(i:ConversationRecallInput)=>{i.commerce!.state.entities=[];i.memory!.active_entities=[];i.memory!.current_goal=null;},["No specific requirements are available yet"]],
  ["R6 A to B to A current recap","en",(i:ConversationRecallInput)=>{i.memory!.current_topic="washer";},["冷氣 for 2","is paused"]],
  ["R7 latest correction only","en",(i:ConversationRecallInput)=>{i.commerce!.state.entities[0].quantity=17;i.commerce!.state.latest_corrections=["2 items to 17 items"];},["冷氣 for 17"]],
  ["R8 cancelled item never active","en",(i:ConversationRecallInput)=>{i.commerce!.state.entities[1].status="cancelled";},["has been cancelled"]],
  ["R9 English despite Cantonese stored language","en",(i:ConversationRecallInput)=>{i.commerce!.state.entities[0].attributes={product_name:"KT-296 subscription",unit:"seats"};},["KT-296 subscription for 2 seats"]],
  ["R10 Cantonese despite English stored language","zh-TW",(i:ConversationRecallInput)=>{i.commerce!.state.language="en";i.commerce!.state.entities[0].attributes={product_name:"KT-296 subscription",unit:"seats"};},["而家記低咗","2席"]],
] as const){
 Deno.test("C3 COMPONENT shared natural recap "+name,()=>{
  const i=recallFixture("Summarize our current requirements");configure(i);const before=JSON.stringify(i);
  const r=prepareConversationRecall(i,language);assert(r.decision.handled && r.decision.authority==="CANONICAL_COMMERCE_STATE",JSON.stringify(r));
  assert(r.reply && !internalRecap.test(r.reply),JSON.stringify(r));for(const value of expected)assert(r.reply.includes(value),r.reply);
  assert(JSON.stringify(i)===before,"recap mutated structured input");
  assert(r.metadata.commerce_state_revision===i.commerce!.revision && r.decision.provenance.company_id===i.company_id && r.decision.provenance.source_message_id===i.source_message_id,"scope/revision lost");
  if(name.startsWith("R7"))assert(!r.reply.includes("冷氣 for 2"),r.reply);
  if(language==="en"){
    // Source literals can stay Chinese; system-provided prose must be English.
    let systemProse=r.reply;
    for(const e of i.commerce!.state.entities){
      if(e.provenance.source_type!=="customer")continue;
      for(const literal of [e.model,e.attributes.product_name,e.attributes.name]){
        if(typeof literal==="string" && /[一-龿]/u.test(literal))
          systemProse=systemProse.replaceAll(literal,"");
      }
    }
    assert(!/[一-龿]/u.test(systemProse),systemProse);
  }
 });
}

for(const company of ['3d6e17b5-ec79-4f75-aa7f-eaa824ff8493','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'])Deno.test('Hosted 5dacabe8 Summary retains customer measurements when entity lacks matching attributes: '+company,()=>{
 const i=recallFixture('請總結同票目前最新要求。');i.company_id=company;i.commerce!.company_id=company;i.memory!.company_id=company;
 i.commerce!.state.entities=i.commerce!.state.entities.slice(0,1);i.commerce!.state.entities[0].attributes={};i.commerce!.state.entities[0].status='deferred';
 i.memory!.current_customer_facts=[{key:'room_size',value:[{label:'客廳',value:'150平方呎'}],authority:'customer',source_message_id:i.source_message_id,entity_id:null,region:null},{key:'budget',value:{amount:5000,unit:'HKD'},authority:'customer',source_message_id:i.source_message_id,entity_id:null,region:null},{key:'priority',value:['quiet_operation_at_night','energy_efficiency'],authority:'customer',source_message_id:i.source_message_id,entity_id:null,region:null}];
 const before=JSON.stringify(i),r=prepareConversationRecall(i,'zh-TW');assert(r.reply?.includes('150平方呎'),JSON.stringify(r));assert(r.reply?.includes('HK$5,000'),JSON.stringify(r));assert(r.reply?.includes('夜間安靜') && r.reply?.includes('能源效益'),JSON.stringify(r));assert(!r.reply?.includes('quiet_operation_at_night'));assert(JSON.stringify(i)===before,'read-only Summary changed canonical lifecycle/state');
});

for (const [text,expected] of [
 ['我想換客廳冷氣，暫時唔使查產品或報價。','active'],
 ['書房想換冷氣，暫時不用查外部資料，先講量度方法。','active'],
 ['I want an air conditioner for the study; do not look up prices for now.','active'],
 ['Consider an air conditioner, without checking vendor products yet.','active'],
 ['唔使查報價；客廳冷氣暫時唔買住。','deferred'],
 ['我要冷氣，唔使查報價；取消冷氣。','cancelled'],
 ['I want an air conditioner; do not check prices; defer the air conditioner.','deferred'],
 ['I want an air conditioner; without checking prices, cancel the air conditioner.','cancelled'],
] as const)Deno.test('lookup instruction and genuine lifecycle remain independent: '+text,()=>{
 const setup='我要一部客廳冷氣。';const scope={conversation_id:'17000000-0000-4000-8000-000000000001',company_id:'17000000-0000-4000-8000-000000000002',language:'zh-TW' as const,history:[]};
 const previous=reduceTurn(createEmptyConversationCommerceState(),{...scope,source_message_id:'17000000-0000-4000-8000-000000000102',text:setup},buildCommerceEntityHints([setup]));
 const shortReference=/^(?:我要冷氣|I want an air conditioner)/u.test(text);
 // The original setup has no customer-authored short alias. No-frame fuzzy
 // cancellation must fail closed rather than mutate via a substring.
 if(shortReference){
   const unbound=reduceTurn(previous,{...scope,
     source_message_id:'17000000-0000-4000-8000-000000000103',text},
     buildCommerceEntityHints([text,setup]));
   assert(JSON.stringify(unbound)===JSON.stringify(previous),"unbound lifecycle changed state");
 }
 const acceptedFrame=shortReference ? ({
   version:"commerce-semantic-1.0.0" as const,language:"zh-TW",
   operation:expected==="deferred"?"DEFER" as const:"CANCEL_ITEM" as const,
   intent:"customer_preference",topic:null,entities:[],customer_facts:[],
   requested_facts:[],confidence:.99,customer_correction:false,additive:false,
   referents:[{ref:previous.entities[0].entity_id,source:"persistent_state" as const,confidence:.99}],
   ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},
   explicit_negations:[],transaction_state:"none" as const,payment_state:"none" as const,
   booking_state:"none" as const,fulfillment_state:"none" as const,
 }) : null;
 const state=reduceTurn(previous,{...scope,
   source_message_id:'17000000-0000-4000-8000-000000000103',text,
   ...(acceptedFrame ? {semantic_frame:acceptedFrame}:{}),
 },buildCommerceEntityHints([text,setup]));
 assert(state.entities.length>0,JSON.stringify(state));
 assert(state.entities.every(e=>expected==='active'?!['deferred','cancelled'].includes(e.status):e.status===expected),JSON.stringify(state));
});

for(const text of ['全屋都沒有西斜','全屋都没有西斜','所有房間都冇下午西曬','The whole house has no afternoon sun'])Deno.test('Frankie bbd3/e1c6 explicit absence replaces positive sunlight consistently: '+text,()=>{
 const i=recallFixture('請總結目前已記錄的要求。');const s=i.commerce!.state;s.entities=s.entities.slice(0,1);s.current_topic='air_conditioner';const e=s.entities[0];e.entity_id='air_conditioner:unscoped';e.category='air_conditioner';e.status='researching';e.attributes={customer_goal:{category:'air_conditioner',objective:'replace_existing_appliance',journey_stage:'sizing_guidance',collected:['room_sizes','installation_type'],missing:['sunlight'],response_intent:'request_highest_value_missing_information',source_message_id:i.source_message_id,updated_at:null},sunlight:'strong_afternoon_sun',semantic_attributes:{sun_exposure:'none'},room_sizes:{small_bedroom:'80平方呎',large_bedroom:'100平方呎',living_room:'180平方呎'},room_sunlight:{small_bedroom:'strong_afternoon_sun'}};
 const out=reduceTurn(s,{conversation_id:i.conversation_id,company_id:i.company_id,source_message_id:i.source_message_id,text,language:'zh-TW',history:[]},buildCommerceEntityHints([text]));
 const facts=out.customer_constraints.customer_reported_facts as Record<string,unknown>;
 const current=facts.site_observation as Record<string,unknown>;
 assert(current.value==='none' && current.scope==='whole_premises' && current.source_text===text,JSON.stringify(out));
 assert((current.provenance as Record<string,unknown>).source_message_id===i.source_message_id);
 assert(out.entities[0].attributes.sunlight==='strong_afternoon_sun','old industry schema is historical and must not be rewritten');
 const before=JSON.stringify(out);i.commerce!.state=out;
 const recap=prepareConversationRecall(i,'zh-TW');
 assert(recap.decision.handled && recap.reply?.includes(text),JSON.stringify(recap));
 assert(!recap.reply?.includes('下午日照強'));assert(JSON.stringify(out)===before);
});

for(const text of ['70 (W) x 55 (H) cm','70(W)×55(H)cm','width 70cm, height 55cm','闊70厘米，高55厘米','W70cm H550mm'])Deno.test('Frankie paired-axis dimensions retain declared units: '+text,()=>{const d=customerDimensionPair(text);assert(d?.width_mm===700&&d.height_mm===550,JSON.stringify(d));});
for(const text of ['70 x 55 cm','70W x55H','-70(W)x55(H)cm','CW-SUL70BA'])Deno.test('unlabelled or invalid dimensions cannot invent an opening: '+text,()=>{assert(customerDimensionPair(text)===null,JSON.stringify(customerDimensionPair(text)));});
for(const text of ['有冇西斜？','全屋有沒有西斜','不是沒有西斜','I am not sure about afternoon sun','如果沒有西斜呢？','If there is no afternoon sun'])Deno.test('uncertain sunlight is not affirmative or an absence: '+text,()=>{assert(customerSunExposure(text)===null);});

for(const [text,expected] of [["另外個廳下晝西斜幾勁，揀機時要點考慮？","strong_afternoon_sun"],["全屋都沒有西斜，應該量度哪些尺寸？","none"],["The living room has strong afternoon sun. How should I choose?","strong_afternoon_sun"],["There is no afternoon sun, what should I measure?","none"],["如果沒有西斜，應該點揀？",null]] as const)Deno.test("explicit site observation survives a separate follow-up question: "+text,()=>{assert(customerSunExposure(text)===expected);});

Deno.test("Task3C semantic recall preserves T17 effective quantity and cancellation proof",()=>{
  const input=t17ProductionFailureFixture();
  const expected=resolveConversationRecall(input);
  assert(expected.handled,JSON.stringify(expected));
  for(const requested_facts of [["quantity"],[]]){
    const result=resolveConversationRecall({...input,customer_recall_proposal:{
      company_id:input.company_id,conversation_id:input.conversation_id,source_message_id:input.source_message_id,
      intent:"customer_fact_recall",requested_facts,subject_refs:[],
    }});
    assert(JSON.stringify(result)===JSON.stringify(expected),JSON.stringify(result));
  }
});
Deno.test("Task3C current quantity conflict remains unresolved under a semantic recall label",()=>{
  for(const question of ["目前實際保留幾多部冷氣？","現在實際要幾多部冷氣？"]){
    const input=t06Turn2SourceConflictFixture();input.question=question;
    const expected=resolveConversationRecall(input);
    assert(!expected.handled&&expected.detail==="CONFLICTING_CUSTOMER_QUANTITY_SOURCE",JSON.stringify(expected));
    for(const requested_facts of [["quantity"],[]]){
      const result=resolveConversationRecall({...input,customer_recall_proposal:{
        company_id:input.company_id,conversation_id:input.conversation_id,source_message_id:input.source_message_id,
        intent:"customer_fact_recall",requested_facts,subject_refs:[],
      }});
      assert(JSON.stringify(result)===JSON.stringify(expected),JSON.stringify(result));
    }
  }
});
Deno.test("Task3C quoted prior total still uses customer source after effective-state routing",()=>{
  const input=t06Turn2SourceConflictFixture();
  for(const requested_facts of [["quantity"],[]]){
    const result=resolveConversationRecall({...input,customer_recall_proposal:{
      company_id:input.company_id,conversation_id:input.conversation_id,source_message_id:input.source_message_id,
      intent:"customer_fact_recall",requested_facts,subject_refs:[],
    }});
    assert(result.handled&&result.value===3&&result.provenance.evidence[0].source_kind==="attested_customer_utterance",JSON.stringify(result));
  }
});

// Task3C N1/N2 differential: the old canonical route on the same source
// fixture must not be shadowed by a new, value-free semantic recall proposal.
// F1/S3 & F3/S4; this is NOT an actual old-version Hosted/33-turn replay.
Deno.test("C3 semantic proposal preserves canonical address, multiple fields and status", () => {
  const cases: Array<[string,string,string[],string[]]> = [
    ["T40", "我更正後的收貨地址是什麼？", ["address"], ["B block"]],
    ["T50", "之前提供的房間面積是多少？", ["room_size"], ["180 sqft"]],
    ["T57", "What is my corrected delivery address?", ["address"], ["B block"]],
    ["T58", "目前送貨安排是甚麼狀態？", ["delivery_status"], ["不代表已確認配送安排"]],
    ["T68", "我之前冷氣要求幾匹？", ["horsepower"], ["1.5"]],
    ["T69", "我要求的冷氣品牌是否一定要指定？", ["brand_constraint"], ["品牌並非必要"]],
    ["T96", "請讀回我的收貨人和聯絡電話？", ["recipient","contact"], ["測試收件人甲","90000001"]],
    ["T98", "我現在是報價階段還是正式訂單？", ["quotation_status","order_status"], ["草擬","尚未形成正式訂單"]],
  ];
  for (const [id,question,requested_facts,expected] of cases) {
    const input=recallFixture(question);
    const before=resolveConversationRecall(input);
    assert(before.handled, id+" original route not handled "+JSON.stringify(before));
    input.customer_recall_proposal={company_id:input.company_id,conversation_id:input.conversation_id,
      source_message_id:input.source_message_id,intent:"customer_fact_recall",requested_facts,subject_refs:[]};
    const after=resolveConversationRecall(input);
    assert(after.handled, id+" shadowed "+JSON.stringify(after));
    assert(JSON.stringify(after.value)===JSON.stringify(before.value), id+" value changed");
    const reply=renderConversationRecall(after,"zh-TW")??"";
    for(const phrase of expected)assert(reply.includes(phrase),id+" missing "+phrase+": "+reply);
  }
});
Deno.test("C3 semantic fallback preserves hard scope and integrity stops",()=>{
 for(const what of ["foreign-proposal","foreign-memory","stale-revision","mixed-order"]){
  const input=recallFixture("我更正後的收貨地址是什麼？");
  input.customer_recall_proposal={company_id:input.company_id,conversation_id:input.conversation_id,
    source_message_id:input.source_message_id,intent:"customer_fact_recall",requested_facts:["address"],subject_refs:[]};
  if(what==="foreign-proposal") input.customer_recall_proposal.company_id="foreign";
  if(what==="foreign-memory") input.memory!.company_id="foreign";
  if(what==="stale-revision") input.memory!.commerce_state_revision=19;
  if(what==="mixed-order") input.question="讀回地址，同時幫我下單。";
  const result=resolveConversationRecall(input);
  assert(!result.handled,what+" wrongly answered "+JSON.stringify(result));
 }
});

Deno.test("Task3C D3 source-owned room value mismatch cannot reuse canonical field", () => {
  const i=recallFixture("之前提供的房間面積是多少？");
  i.customer_recall_proposal={company_id:i.company_id,conversation_id:i.conversation_id,
    source_message_id:i.source_message_id,intent:"customer_fact_recall",
    requested_facts:["room_size"],subject_refs:[]};
  assert(resolveConversationRecall(i).handled,"valid T50 historical read must remain available");
  i.commerce!.state.entities[0].attributes.room_size="999 sqft";
  i.memory!.active_entities[0].current_requirements.room_size="999 sqft";
  assert(!resolveConversationRecall(i).handled,
    "typed canonical 999 sqft cannot replace the original Visitor 180 sqft");
});

Deno.test("Task3C R3 current-record recap never claims original speech",()=>{
 const i=t06Turn2SourceConflictFixture();i.question="請總結目前已記錄的要求。";
 const r=prepareConversationRecall(i,"zh-TW");
 assert(r.decision.handled&&r.decision.fact_type==="summary",JSON.stringify(r.decision));
 assert((r.reply??"").includes("而家記低咗"));
 assert(!(r.reply??"").includes("你之前說過"));
 assert((r.reply??"").includes("矛盾")&&(r.reply??"").includes("尚未核實"),
   "canonical six and customer fact three must remain explicitly unresolved");
});
Deno.test("Task3C R3 absent historical Visitor source cannot certify stale six",()=>{
 const i=t06Turn2SourceConflictFixture();i.trusted_visitor_source_rows=[];
 i.trusted_visitor_source_status="not_requested";
 const r=prepareConversationRecall(i,"zh-TW");
 assert(!r.decision.handled&&r.decision.reason==="AMBIGUOUS",JSON.stringify(r.decision));
 assert(!(r.reply??"").includes("6 部"));
});

Deno.test("Task3C R1 unlabelled typed recall proves same original Visitor and rejects changed text",()=>{
 for(const [question,key,value,attribute,source] of [
   ["之前提供的房間面積是多少？","room_size","180 sqft","room_size","我之前提供的房間面積係180 sqft。"],
   ["我之前冷氣要求幾匹？","horsepower",1.5,"horsepower","我要求細房需要1.5匹冷氣。"],
   ["我要求的冷氣品牌是否一定要指定？","brand_required",false,"brand_required","冷氣品牌並非必要條件，我沒有指定品牌。"],
 ] as const){
  const x=recallFixture(question);x.customer_recall_proposal=undefined;
  x.memory!.current_customer_facts=[{key,value,authority:"customer",source_message_id:"ac-source"}];
  x.memory!.active_entities[0].current_requirements[attribute]=value;
  if(attribute==="brand_required") x.commerce!.state.entities[0].constraints.brand_required=value;
  else x.commerce!.state.entities[0].attributes[attribute]=value;
  x.trusted_visitor_source_rows=[{id:"ac-source",content:source}];
  x.trusted_visitor_source_status="verified";
  const resolved=prepareConversationRecall(x,"zh-TW");
  assert(resolved.decision.handled,JSON.stringify(resolved.decision));
  assert(hasAttestedUnlabelledCustomerRecall(x,resolved.decision),"original Visitor provenance required");
  const wrong={...x,trusted_visitor_source_rows:[{id:"ac-source",content:"另一位客戶的無關要求。"}]};
  const rejected=prepareConversationRecall(wrong,"zh-TW");
  assert(!hasAttestedUnlabelledCustomerRecall(wrong,rejected.decision),"no mismatched Visitor text");
  const missing={...x,trusted_visitor_source_status:"failed" as const};
  assert(!hasAttestedUnlabelledCustomerRecall(missing,prepareConversationRecall(missing).decision),
    "missing source read status cannot grant recall");
 }
});

Deno.test("Task3C T50 grouped room areas require individually source-attested label/value pairs",()=>{
 const x=recallFixture("兩間房的面積分別是多少？");
 x.customer_recall_proposal=undefined;
 x.memory!.current_customer_facts=[{
  key:"room_size",authority:"customer",source_message_id:"ac-source",entity_id:null,
  value:[
    {member_id:"room:1",group:"room",label:"細房",value:"80平方呎"},
    {member_id:"room:2",group:"room",label:"大房",value:"100平方呎"},
  ]
 }];
 x.trusted_visitor_source_rows=[{id:"ac-source",content:"細房80平方呎，大房100平方呎。"}];
 x.trusted_visitor_source_status="verified";
 const good=prepareConversationRecall(x,"zh-TW");
 assert(good.decision.handled && hasAttestedUnlabelledCustomerRecall(x,good.decision),
   "each pair must derive from original Visitor line");
 for(const bad of ["細房100平方呎，大房80平方呎。","細房80平方呎，另外的房間未說面積。"]){
  const wrong={...x,trusted_visitor_source_rows:[{id:"ac-source",content:bad}]};
  assert(!hasAttestedUnlabelledCustomerRecall(wrong,prepareConversationRecall(wrong,"zh-TW").decision),
    "swapped or missing pair must not certify existing canonical values");
 }
});
