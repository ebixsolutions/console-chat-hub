import type { IndustryProfile } from "../industry-agent-registry.ts";
import type { ConversationCommerceState } from "../commerce-state-contract.ts";
import type { ContextualCandidate } from "../contextual-customer-update.ts";

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
  const sizingQuestion = /(?:想問|想问|請教|请教|想了解|how|help).{0,30}(?:匹數|匹数|冷氣|冷气|air\s*condition)/i.test(text)
    && /(?:匹數|匹数|sizing|capacity)/i.test(text)
    && !/(?:一\s*部|兩\s*部|两\s*部|\d+\s*部)/i.test(text);
  if (topic === "air_conditioner" && explicit.length === 1 && sizingQuestion && currentRoomContext) {
    return {
      topic, topic_source: "explicit", action: "enquiry", values: [],
      context_sufficient: true,
      reply: language === "en"
        ? "I can help size each AC for the bedrooms and living room. What is each room's area, afternoon sun exposure, and window or installation arrangement?"
        : language === "zh-CN"
        ? "两间房和客厅要分别估冷气匹数。请给我各自面积、下午日晒情况，以及窗口和安装方式。"
        : "兩間房同客廳要分別估冷氣匹數。你話我知各自面積、下午日照，同窗口／安裝方式，我就可以幫你縮窄選擇。",
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
