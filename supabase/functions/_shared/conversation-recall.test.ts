import {
  type ConversationRecallInput,
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
Deno.test("C3 summary uses bounded structured projection", () => {
  const { reply } = answer("Summarize our current requirements");
  assert(
    reply.includes("### Transaction State") && !reply.includes("8000") &&
      !reply.includes("5600"),
  );
});
Deno.test("C3 Cantonese and English requirement-recap paraphrases use structured recall", () => {
  for (const question of ["而家我冷氣要求係點？", "Can you recap my current air conditioner requirements?"]) {
    const { reply } = answer(question);
    assert(reply.includes("### Active Entities") && !reply.includes("washer-front"), `${question}:${reply}`);
  }
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
