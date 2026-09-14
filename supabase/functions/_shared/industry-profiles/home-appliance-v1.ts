import type { IndustryProfile } from "../industry-agent-registry.ts";

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
