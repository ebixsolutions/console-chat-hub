import type { IndustryProfile } from "../industry-agent-registry.ts";
import type { ConversationCommerceState } from "../commerce-state-contract.ts";
import type { ContextualCandidate } from "../contextual-customer-update.ts";
import { activeCustomerGoal, type CustomerJourneySignal } from "../customer-journey-orchestration.ts";

export interface HomeApplianceCategory {
  key: string;
  label: Record<"zh-TW" | "zh-CN" | "en", string>;
  aliases: readonly string[];
}

export interface HomeApplianceRoom {
  key: string;
  label: Record<"zh-TW" | "zh-CN" | "en", string>;
  aliases: readonly string[];
}

export const HOME_APPLIANCE_CATEGORIES: readonly HomeApplianceCategory[] = [
  {
    key: "air_conditioner",
    label: { "zh-TW": "冷氣機", "zh-CN": "空调", en: "air conditioner" },
    aliases: [
      "冷氣",
      "冷气",
      "空調",
      "空调",
      "air con",
      "aircon",
      "air-con",
      "air conditioner",
      "ac unit",
    ],
  },
  {
    key: "refrigerator",
    label: { "zh-TW": "雪櫃", "zh-CN": "冰箱", en: "refrigerator" },
    aliases: ["雪櫃", "雪柜", "冰箱", "fridge", "refrigerator"],
  },
  {
    key: "washing_machine",
    label: { "zh-TW": "洗衣機", "zh-CN": "洗衣机", en: "washing machine" },
    aliases: ["洗衣機", "洗衣机", "washer", "washing machine"],
  },
  {
    key: "water_heater",
    label: { "zh-TW": "熱水爐", "zh-CN": "热水器", en: "water heater" },
    aliases: ["熱水爐", "热水器", "water heater"],
  },
  {
    key: "television",
    label: { "zh-TW": "電視", "zh-CN": "电视", en: "television" },
    aliases: ["電視", "电视", "television", "tv"],
  },
];

export const HOME_APPLIANCE_ROOMS: readonly HomeApplianceRoom[] = [
  {
    key: "living_room",
    label: { "zh-TW": "客廳", "zh-CN": "客厅", en: "living room" },
    aliases: ["客廳", "客厅", "living room", "lounge"],
  },
  {
    key: "bedroom",
    label: { "zh-TW": "睡房", "zh-CN": "卧室", en: "bedroom" },
    aliases: ["睡房", "臥室", "卧室", "房間", "房间", "bedroom"],
  },
  {
    key: "kitchen",
    label: { "zh-TW": "廚房", "zh-CN": "厨房", en: "kitchen" },
    aliases: ["廚房", "厨房", "kitchen"],
  },
];

export const HOME_APPLIANCE_PROFILE_V1: IndustryProfile = Object.freeze({
  id: "home_appliance",
  version: "1.0.0",
  aliases: ["home_appliances", "appliance", "appliances", "家電", "家电"],
  schema: Object.freeze({
    id: "home_appliance",
    version: "1.0.0",
    fields: Object.freeze([
      {
        key: "product",
        type: "string" as const,
        required: false,
        description: "Customer-grounded appliance product or category.",
      },
      {
        key: "model",
        type: "string" as const,
        required: false,
        description: "Customer-grounded product model.",
      },
      {
        key: "capacity",
        type: "string" as const,
        required: false,
        description: "Customer-stated size or capacity.",
      },
      {
        key: "installation",
        type: "object" as const,
        required: false,
        description: "Installation requirements stated by the customer.",
      },
      {
        key: "delivery",
        type: "object" as const,
        required: false,
        description: "Delivery requirements stated by the customer.",
      },
      {
        key: "engineering",
        type: "object" as const,
        required: false,
        description: "Site or engineering constraints requiring confirmation.",
      },
      {
        key: "payment",
        type: "object" as const,
        required: false,
        description: "Customer-stated payment requirements; never payment authority.",
      },
      {
        key: "warranty",
        type: "string" as const,
        required: false,
        description: "Customer-stated warranty requirement; never an inferred policy.",
      },
    ]),
  }),
});

function hasTwoBedroomLivingContext(text: string): boolean {
  return /(?:兩|两|二|2)\s*(?:間|间|个|個)?\s*(?:睡?房|臥室|卧室).{0,30}(?:客廳|客厅|廳|厅)|(?:客廳|客厅|廳|厅).{0,30}(?:兩|两|二|2)\s*(?:間|间|个|個)?\s*(?:睡?房|臥室|卧室)|two\s+bedrooms?.{0,30}(?:living\s+room|lounge)|(?:living\s+room|lounge).{0,30}two\s+bedrooms?/iu.test(text);
}

function hasOneEachBedroomAllocation(text: string): boolean {
  return /(?:兩|两|二|2)\s*(?:間|间|个|個)?\s*(?:睡?房|臥室|卧室)\s*(?:(?:每|各)\s*(?:間|间|个|個)?\s*)?(?:各\s*)?(?:要|需|放|裝|装)?\s*(?:一|1)\s*(?:部|台)|(?:睡?房|臥室|卧室)(?:間|间)?\s*(?:每\s*(?:間|间|个|個)?|各)\s*(?:要|需|放|裝|装)?\s*(?:一|1)\s*(?:部|台)|each\s+(?:of\s+the\s+)?two\s+bedrooms?\s+(?:gets?|needs?|has)?\s*(?:one|1)\s+(?:unit)?|two\s+bedrooms?\s*,?\s*(?:one|1)\s+(?:unit\s+)?each/iu.test(text);
}

function hasOneLivingRoomAllocation(text: string): boolean {
  return /(?:客廳|客厅|廳|厅|廤)\s*(?:要|需|放|裝|装)?\s*(?:一|1)\s*(?:部|台)|(?:one|1)\s+(?:unit\s+)?(?:for|in)\s+(?:the\s+)?(?:living\s+room|lounge)|(?:living\s+room|lounge)\s*(?:gets?|needs?|has)?\s*(?:one|1)\s+(?:unit)?/iu.test(text);
}

interface HomeApplianceJourneyPolicy {
  stage: string;
  required: readonly string[];
  decision_outputs: readonly string[];
  prompts: Record<"zh-TW" | "zh-CN" | "en", Record<string, string>>;
  ready: Record<"zh-TW" | "zh-CN" | "en", string>;
}

const HOME_APPLIANCE_JOURNEY_POLICIES: Record<string, HomeApplianceJourneyPolicy> = {
  air_conditioner: {
    stage: "sizing_guidance",
    required: ["room_sizes", "installation_type", "sunlight"],
    decision_outputs: ["sizing_decision", "suitable_models"],
    prompts: {
      "zh-TW": {
        room_sizes: "我會按兩間房同客廳逐個空間幫你揀冷氣。下一步需要細房、大房同客廳各自嘅平方呎面積。",
        installation_type: "三個空間面積已分開記低。下一步要確認各位置係窗口位、分體位，定係其他安裝方式？",
        sunlight: "面積同安裝方式會分開考慮。仲要確認邊個空間有較強下午日照或西斜？",
      },
      "zh-CN": {
        room_sizes: "我会按两间房和客厅逐个空间帮你选择。请先告诉我小房、大房和客厅各自多少平方英尺？",
        installation_type: "三个空间的面积已经分开记录。下一步请确认各位置是窗口位、分体位，还是其他安装方式？",
        sunlight: "面积和安装方式会分开考虑。还要确认哪个空间有较强下午日晒或西晒？",
      },
      en: {
        room_sizes: "I’ll size the two bedrooms and living room separately. What is the area of each space?",
        installation_type: "I have the room areas separately. Are these window openings, split-unit positions, or another installation type?",
        sunlight: "I’ll consider the areas and installation type separately. Which spaces get strong afternoon or west-facing sun?",
      },
    },
    ready: {
      "zh-TW": "西斜會增加實際冷氣負荷，我會連同各房面積同窗口安裝條件一齊考慮；唔會單憑西斜直接保證匹數。下一步係逐個空間核對有現行資料支持嘅型號同適用範圍。",
      "zh-CN": "西晒会增加实际冷气负荷，我会连同各房面积和窗口安装条件一起考虑；不会只凭西晒直接保证匹数。下一步是逐个空间核对有现行资料支持的型号和适用范围。",
      en: "West-facing afternoon sun can increase the cooling load, so I’ll consider it together with each room’s area and installation conditions rather than guarantee horsepower from sunlight alone. The next step is to compare models with current evidence for each space.",
    },
  },
  refrigerator: {
    stage: "requirements_discovery",
    required: ["dimensions", "capacity"],
    decision_outputs: ["suitable_models"],
    prompts: {
      "zh-TW": { dimensions: "揀雪櫃先要確認擺位嘅闊、高、深上限。你個位置尺寸係幾多？", capacity: "尺寸已記低；你大概需要幾多容量，或者幾多人使用？" },
      "zh-CN": { dimensions: "选择冰箱前要先确认位置的宽、高、深上限。位置尺寸是多少？", capacity: "尺寸已经记录；你大概需要多少容量，或者有多少人使用？" },
      en: { dimensions: "To narrow down a refrigerator, what are the maximum width, height and depth of the space?", capacity: "I have the dimensions. What capacity do you need, or how many people will use it?" },
    },
    ready: { "zh-TW": "尺寸同容量要求已齊，可以開始比較合適型號。", "zh-CN": "尺寸和容量要求已经齐全，可以开始比较合适型号。", en: "The size and capacity requirements are ready, so we can compare suitable models." },
  },
};

function journeyObservations(text: string): string[] {
  const values: string[] = [];
  if (hasTwoBedroomLivingContext(text)) values.push("space_plan");
  if (/(?:細房|小房|大房|客廳|客厅|living room|bedroom).{0,14}\d{2,4}\s*(?:平方呎|平方英尺|sq\.?\s*ft|ft²|呎)|\d{2,4}\s*(?:平方呎|平方英尺|sq\.?\s*ft|ft²|呎).{0,14}(?:房|客廳|客厅|living room|bedroom)/iu.test(text)) values.push("room_sizes");
  if (/(?:窗口位|窗口機|窗口机|分體位|分体位|分體機|分体机|window\s*(?:opening|unit|air)|split[- ]?unit|installation\s*type)/iu.test(text)) values.push("installation_type");
  if (/(?:西斜|西曬|西晒|下午日照|下午日曬|下午日晒|afternoon\s+sun|west[- ]?facing)/iu.test(text)) values.push("sunlight");
  if (/(?:闊|宽|高|深|width|height|depth).{0,12}\d{2,4}\s*(?:mm|毫米)/iu.test(text)) values.push("dimensions");
  if (/(?:容量|公升|升|litres?|liters?|\d+\s*l\b|幾多人|几个人|people)/iu.test(text)) values.push("capacity");
  return [...new Set(values)];
}

function journeyObjective(text: string, previous: string | null): string {
  if (/(?:換|更換|替換|replace|replacement)/iu.test(text)) return "replace_existing_appliance";
  if (/(?:比較|对比|compare)/iu.test(text)) return "compare_products";
  return previous || "select_product";
}

function isJourneyStart(text: string): boolean {
  return /(?:點揀|点选|點選|點樣揀|怎样选|怎樣選|如何選|如何选|買咩|买什么|推薦|推荐|應該點|应该怎么|how\s+(?:should\s+i|do\s+i|to)\s+(?:choose|select)|help\s+(?:me\s+)?choose|想.{0,12}(?:換|买|買|揀|选|選|睇|看)|replace)/iu.test(text);
}

export function homeApplianceCustomerJourneySignal(input: {
  text: string;
  state: ConversationCommerceState;
  language: "zh-TW" | "zh-CN" | "en";
}): CustomerJourneySignal | null {
  const text = input.text.normalize("NFKC").trim();
  if (!text || /(?:取消|唔要|不要|暫時唔|暂时不|defer|hold off|cancel)/iu.test(text)) return null;
  if (hasOneEachBedroomAllocation(text) || hasOneLivingRoomAllocation(text)) return null;
  const explicit = HOME_APPLIANCE_CATEGORIES.filter((category) =>
    category.aliases.some((alias) => alias.length >= 2 && text.toLowerCase().includes(alias.toLowerCase()))
  );
  if (explicit.length > 1) return null;
  const prior = activeCustomerGoal(input.state);
  const category = explicit[0]?.key ?? prior?.goal.category ??
    (HOME_APPLIANCE_CATEGORIES.some((item) => item.key === input.state.current_topic) ? input.state.current_topic : null);
  if (!category) return null;
  const policy = HOME_APPLIANCE_JOURNEY_POLICIES[category];
  if (!policy) return null;
  const observed = journeyObservations(text);
  if (!isJourneyStart(text) && !observed.length) return null;
  const collected = [...new Set([...(prior?.goal.category === category ? prior.goal.collected : []), ...observed])];
  const operationalMissing = policy.required.filter((item) => !collected.includes(item));
  const missing = [...operationalMissing, ...policy.decision_outputs];
  const next = operationalMissing[0] ?? null;
  return {
    category,
    objective: journeyObjective(text, prior?.goal.category === category ? prior.goal.objective : null),
    journey_stage: policy.stage,
    collected,
    missing,
    response_intent: next ? "request_highest_value_missing_information" : "advance_decision",
    reply: next ? policy.prompts[input.language][next] : policy.ready[input.language],
    category_source: explicit.length === 1 ? "explicit" : "active_goal",
  };
}

/** Optional profile vocabulary for the universal contextual update contract. */
export function homeApplianceContextualCandidate(input: {
  text: string;
  history: readonly string[];
  state: ConversationCommerceState;
  language: "zh-TW" | "zh-CN" | "en";
}): ContextualCandidate | null {
  const text = input.text.normalize("NFKC").trim();
  const customerHistory = input.history.join(" ");
  const explicit = HOME_APPLIANCE_CATEGORIES.filter((category) =>
    category.aliases.some((alias) => alias.length >= 2 && text.toLowerCase().includes(alias.toLowerCase()))
  );
  if (explicit.length > 1) return null;
  const topic = explicit[0]?.key ?? input.state.current_topic;
  const roomContext = hasTwoBedroomLivingContext(customerHistory);
  const currentRoomContext = hasTwoBedroomLivingContext(text);
  const language = input.language;
  const sizingQuestion = /(?:想問|想问|請教|请教|想了解|想換|想换|點揀|点揀|如何選|如何选|應該點揀|应该怎么选|how|help|replace).{0,40}(?:匹數|匹数|冷氣|冷气|空調|空调|air\s*condition)|(?:冷氣|冷气|空調|空调|air\s*condition).{0,40}(?:點揀|点揀|如何選|如何选|應該|应该|choose|select|sizing|capacity)/iu.test(text)
    && !/(?:一\s*部|兩\s*部|两\s*部|\d+\s*部)/i.test(text);
  if (topic === "air_conditioner" && explicit.length === 1 && sizingQuestion && currentRoomContext) {
    return {
      topic, topic_source: "explicit", action: "enquiry", values: [],
      context_sufficient: true,
      reply: language === "en"
        ? "I can help size each AC for the bedrooms and living room. What is each room's area, afternoon sun exposure, and window or installation arrangement?"
        : language === "zh-CN"
        ? "两间房和客厅要分别估冷气匹数。请给我各自面积、下午日晒情况，以及窗口和安装方式。"
        : "我會按兩間房同客廳逐個空間幫你揀冷氣。下一步需要細房、大房同客廳各自嘅平方呎面積。",
      clarification: "",
    };
  }
  const bedroomAllocation = hasOneEachBedroomAllocation(text);
  const livingAllocation = hasOneLivingRoomAllocation(text);
  if (!bedroomAllocation && !livingAllocation) return null;
  if (/[?？]/.test(text)) return null;
  const clarification = language === "en"
    ? "Which product is this for, and how many bedrooms and living rooms do you mean?"
    : language === "zh-CN"
    ? "这是哪种产品？请确认有几间房和几个客厅需要各一部。"
    : "你講緊邊種產品？請確認有幾間房同幾個客廳要各一部。";
  const safeRooms = currentRoomContext || roomContext;
  const typo = /廤/.test(text);
  const complete = topic === "air_conditioner" && bedroomAllocation && livingAllocation && safeRooms &&
    (!typo || (roomContext && input.state.current_topic === "air_conditioner"));
  const values = complete
    ? ([
      { scope: "living_room", attribute: "quantity", action: "set", value: 1 },
      { scope: "bedroom_1", attribute: "quantity", action: "set", value: 1 },
      { scope: "bedroom_2", attribute: "quantity", action: "set", value: 1 },
    ] as const).map((v) => ({ ...v }))
    : [];
  return {
    topic: explicit[0]?.key ?? "air_conditioner",
    topic_source: explicit.length === 1 ? "explicit" : "profile",
    action: "scoped_update",
    values,
    aggregate_quantity: complete ? 3 : undefined,
    context_sufficient: complete,
    clarification,
    reply: language === "en"
      ? "I have one unit for the living room and one for each of the two bedrooms: three units in total. This is a requirement, not an order."
      : language === "zh-CN"
      ? "记下客厅一部、两间房各一部，共三部；这只是选购要求，并非已落单。"
      : "記低客廳一部、兩間房各一部，共三部；呢個係選購要求，未落單。",
  };
}
