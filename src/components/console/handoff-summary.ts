type RecordValue = Record<string, unknown>;
const obj = (x: unknown): RecordValue | null =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? (x as RecordValue) : null;
const rows = (x: unknown): RecordValue[] =>
  Array.isArray(x) ? x.map(obj).filter((r): r is RecordValue => r !== null) : [];
const labels: Record<string, string> = {
  air_conditioner: "冷氣",
  refrigerator: "雪櫃",
  washing_machine: "洗衣機",
  living_room: "客廳",
  large_bedroom: "大房",
  small_bedroom: "細房",
  window_unit: "窗口機",
  strong_afternoon_sun: "下午西曬",
  window_opening_check: "核對各窗口位闊度與高度",
  none: "未建立",
  not_confirmed: "未確認",
  unknown: "未確認",
  pending_quote: "待報價",
  draft: "草擬",
  paid: "已付款",
  confirmed: "已確認",
  pending: "待處理",
  max_width_mm: "闊度上限（mm）",
  max_height_mm: "高度上限（mm）",
  max_depth_mm: "深度上限（mm）",
  features: "功能",
  horsepower: "匹數",
  model: "型號",
  weight: "重量",
  dimension: "尺寸",
  capacity: "容量",
  power: "功率",
  voltage: "電壓",
  noise: "噪音",
  policy: "條款",
  product_count: "商品數量",
  staff_count: "人手",
  app_interest: "App 需要",
  preferred_interface: "使用介面",
  web: "網頁版",
  mobile: "手機版",
  current_market: "目前市場",
  hong_kong: "香港",
  desired_features: "需要功能",
  future_markets: "未來市場",
};
const text = (x: unknown): string =>
  typeof x === "string" ? x.slice(0, 2000) : typeof x === "number" ? String(x) : "";
const originalText = (x: unknown): string => typeof x === "string" ? x : "";
const human = (x: unknown): string => labels[text(x)] ?? text(x).replaceAll("_", " ");
const factValue = (x: unknown): string => x === null ? "未確認" : typeof x === "boolean" ? (x ? "是" : "否") : Array.isArray(x) ? x.map(factValue).join("、") : obj(x) ? JSON.stringify(x) : human(x);
const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((v): v is string => typeof v === "string").map(human) : [];
export type TicketSummary = { title: string; lines: string[] }[];
// Presentation only: read the persisted authoritative envelope; never infer facts from transcript.
export function projectTicketSummary(
  value: unknown,
  conversationId: string,
  companyId: string,
): TicketSummary | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const envelope = obj(parsed),
    p = obj(envelope?.structured_package);
  if (
    envelope?.schema_version !== "c2-handoff-1.0.0" ||
    p?.schema_version !== "c2-handoff-1.0.0" ||
    p.conversation_id !== conversationId ||
    p.company_id !== companyId
  )
    return null;
  const context = obj(p.handoff_context), request = obj(context?.current_request);
  const snapshot = obj(context?.memory_snapshot), priorMemory = obj(snapshot?.memory);
  if (context && (context.version !== "c3-early-r1-context-1.0.0" ||
    context.conversation_id !== conversationId || context.company_id !== companyId ||
    request?.source_message_id !== p.generated_from_source_message_id ||
    typeof request?.interpretation_committed !== "boolean" || !text(request?.content) ||
    (snapshot && (priorMemory?.conversation_id !== conversationId ||
      priorMemory?.company_id !== companyId ||
      priorMemory?.source_message_id !== snapshot.source_message_id ||
      priorMemory?.memory_revision !== snapshot.revision)))) return null;
  const previous = snapshot?.applicability === "prior_committed_snapshot" ? priorMemory : null;
  const entityLines = (items: unknown) =>
    rows(items).flatMap((e) => {
      const a = obj(e.attributes) ?? {},
        constraints = obj(e.constraints) ?? {};
      const requested = rows(p.current_customer_facts).find(f =>
        f.key === `entity:${text(e.entity_id)}:quantity` && f.entity_id === e.entity_id &&
        f.authority === "canonical_commerce" && text(f.source_message_id) &&
        typeof f.value === "number" && f.value === e.quantity);
      const quantity =
        a.quantity_basis !== "system_default" && (a.quantity_basis === "customer_explicit" || requested) && typeof e.quantity === "number"
          ? `${e.quantity}${text(a.unit) ? " " + human(a.unit) : ""}（客人確認）`
          : "數量未確認";
      const result = [
        `${text(a.product_name) || human(e.category)}${text(e.model) || text(a.sku) ? " " + (text(e.model) || text(a.sku)) : ""}：${quantity}`,
      ];
      for (const [key, v] of Object.entries(obj(a.room_sizes) ?? {}))
        if (text(v)) result.push(`${human(key)}：${text(v)}`);
      for (const [key, v] of Object.entries(obj(a.room_sunlight) ?? {}))
        if (text(v)) result.push(`${human(key)}：${human(v)}`);
      if (text(a.installation_type)) result.push(`安裝類型：${human(a.installation_type)}`);
      for (const key of ["max_width_mm", "max_height_mm", "max_depth_mm"])
        if (typeof constraints[key] === "number") result.push(`${human(key)}：${constraints[key]}`);
      return result;
    });
  const active = rows(p.active_entities).filter(
    (e) => !["deferred", "cancelled"].includes(text(e.status)),
  );
  const transaction = obj(p.transaction_state) ?? {};
  const sections: TicketSummary = [
    {
      title: "客人目標",
      lines: context && request?.interpretation_committed === false ? [originalText(request.content)]
        : text(p.current_customer_goal) && p.current_customer_goal !== "unknown"
        ? [human(p.current_customer_goal)] : ["目標未確認"],
    },
    { title: "目前需求", lines: entityLines(active) },
    { title: "客人提供的資料", lines: rows(p.current_customer_facts)
      .filter(f => ["customer", "canonical_commerce"].includes(text(f.authority)) && text(f.source_message_id) && Object.hasOwn(f, "value") && !text(f.key).startsWith("entity:"))
      .map(f => `${human(f.key)}：${factValue(f.value)}（客人提供，非商家核實）`) },
    { title: "已暫緩", lines: entityLines(p.deferred_entities) },
    { title: "已取消", lines: entityLines(p.cancelled_entities) },
    { title: "最新更正", lines: strings(p.latest_corrections) },
    {
      title: "已核實產品資料",
      lines: rows(p.current_authoritative_kb_facts)
        .filter(
          (f) =>
            f.authority === "CURRENT_KB" &&
            f.currentness_at_answer === "current" &&
            text(f.document_id) &&
            text(f.chunk_id),
        )
        .map((f) => `${text(f.model)} · ${human(f.field)}：${text(f.value)}`),
    },
    {
      title: "真人需跟進",
      lines: [
        ...new Set([
          ...strings(p.open_questions),
          ...strings(p.pending_actions),
          ...strings(p.safety_or_professional_requirements),
        ]),
      ],
    },
    {
      title: context && request?.interpretation_committed === false
        ? "最後已提交交易狀態（需按最新要求核實）" : "交易狀態",
      lines: [
        ["quotation", "報價"],
        ["order", "訂單"],
        ["payment", "付款"],
        ["delivery", "送貨"],
        ["installation", "安裝"],
      ].map(([k, label]) => `${label}：${human(transaction[k]) || "未確認"}`),
    },
    {
      title: "客人提供的歷史資料（不是現價）",
      lines: rows(p.historical_customer_facts)
        .filter((f) => f.authority === "historical")
        .flatMap((f) => {
          const v = obj(f.value);
          return v?.authority === "customer_historical_or_hypothetical" &&
            v.reusable_as_current === false &&
            typeof v.amount === "number"
            ? [
                `歷史${v.role === "unit_price" ? "單位金額" : "金額"}：${text(v.currency)} ${v.amount}；不可作現行報價`,
              ]
            : [];
        }),
    },
  ];
  if (context) {
    sections.splice(1, 0, {
      title: "最新要求的處理狀態",
      lines: [request?.interpretation_committed === true ? "最新理解已保存。"
        : "原文已保存；最新更正／取消尚未套用至已提交資料，需真人先確認。"],
    });
    if (previous) sections.push(
      { title: "先前已提交的客人資料（不是最新更正後的需求）", lines: [
        ...(text(previous.current_goal) ? [`先前目標：${text(previous.current_goal)}`] : []),
        ...rows(previous.current_customer_facts)
          .filter(f => ["customer", "canonical_commerce"].includes(text(f.authority)) &&
            text(f.source_message_id) && Object.hasOwn(f, "value"))
          .map(f => `${human(f.key)}：${factValue(f.value)}（客人提供，非商家核實）`),
        ...strings(previous.latest_corrections).map(v => `先前已保存更正：${v}`),
      ] },
      { title: "先前待確認／跟進（需重新核實是否適用）", lines: [
        ...strings(previous.open_questions), ...strings(previous.pending_actions),
      ] },
    );
    sections.push(
      { title: "先前有 KB 依據的答覆（歷史紀錄，不能作目前需求的依據）",
        lines: rows(context.grounded_answer_history)
          .filter(f => f.company_id === companyId && text(f.source_message_id) &&
            text(f.assistant_message_id) && text(f.tenant_id) &&
            f.applicability === "historical_answer_not_current_authority" && f.reusable_as_current === false)
          .map(f => `先前問題：${originalText(f.question)}\n當時答覆：${originalText(f.answer)}`) },
      { title: "先前對話原文（不是已核實事實／目前需求）",
        lines: rows(context.prior_turns).filter(t => text(t.message_id) &&
          ["visitor", "assistant", "agent"].includes(text(t.role)))
          .map(t => `${t.role === "visitor" ? "客人" : t.role === "agent" ? "客服" : "AI"}：${originalText(t.content)}`) },
    );
  }
  return sections.filter((s) => s.lines.length > 0);
}
