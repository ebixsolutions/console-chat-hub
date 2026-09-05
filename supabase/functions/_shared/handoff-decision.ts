export type HandoffMode = "immediate" | "optional_clarification_then_handoff" | "normal_ai_continue";
export type HandoffPriority = "emergency" | "required" | "recommended" | "advisory";
export type MissingInfoPolicy = "do_not_ask" | "ask_once_optional" | "ask_if_customer_willing";
export type HandoffDecisionInput = {
  explicit_human_request: boolean;
  human_request_count: number;
  request_strength: "standard" | "strong";
  anger_level: "high" | "medium" | "low" | null;
  sentiment_trend: number[] | null;
  frustration_due_to_repetition: boolean;
  unresolved_turns: number;
  same_intent_repeat: boolean;
  prior_clarification_count: number;
  customer_refused_more_questions: boolean;
  vip_tier: string | null;
  high_value_customer: boolean | null;
  predicted_csat: number | null;
  churn_risk: number | null;
  policy_risk: "high" | "standard" | null;
  threat_flag: boolean;
  rag_state: string | null;
  handoff_history: number;
  current_intent: string | null;
  current_topic: string | null;
  required_info_missing: string[];
  missing_info_actionability: "high" | "low" | "none";
};
export type HandoffDecision = {
  handoff_mode: HandoffMode;
  handoff_priority: HandoffPriority;
  missing_info_policy: MissingInfoPolicy;
  reason_codes: string[];
};
type Row = { role?: string; content?: string | null; metadata?: unknown };
const HUMAN_REQUEST = /(真人客服|人工客服|真人|人工|human agent|live agent|real person|speak to (?:a )?human|talk to (?:a )?human)/i;
const HUMAN_INFO_QUESTION = /(真人客服|人工客服|human agent|live agent).{0,16}(幾點|几点|時間|时间|服務時間|服务时间|hours|when|available)|(?:幾點|几点|hours|when).{0,16}(真人客服|人工客服|human agent|live agent)/i;
const STRONG_REQUEST = /(立即|即刻|而家|現在|现在).{0,10}(?:真人|人工)|(?:不要|唔要|不想要|別再|别再).{0,10}(?:AI|機器人|机器人)|(?:只要|一定要|必須|必须).{0,10}(?:真人|人工)|(?:connect|transfer).{0,8}(?:now|immediately)|no more ai|don't want ai|do not want ai/i;
const ANGER = /(嬲|生氣|生气|憤怒|愤怒|火大|離譜|离谱|垃圾|廢話|废话|煩|烦|投訴|投诉|angry|furious|ridiculous|useless|frustrat|annoyed)/i;
const REPETITION_FRUSTRATION = /(又問|再問|問過|问过|講過|说过|重複|重复|already told|asked already|again\?|stop asking|same question)/i;
const REFUSED = /(不想再提供|唔想再答|不要再問|不要再问|不會再提供|不会再提供|不提供|拒絕提供|拒绝提供|won't provide|will not provide|don't ask|do not ask|not giving)/i;
const CLARIFICATION_ROUTES = new Set(["warm_handoff_data_collection", "kb_no_match_clarification"]);
function clean(v: unknown): string { return typeof v === "string" ? v.normalize("NFKC").trim() : ""; }
function obj(v: unknown): Record<string, unknown> | null { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; }
export function deriveHandoffDecisionInput(
  rows: Row[], latestMessage: string, requiredMissing: string[], opts: Partial<HandoffDecisionInput> = {},
): HandoffDecisionInput {
  const visitors = rows.filter((r) => ["visitor","customer","user"].includes(String(r.role ?? "").toLowerCase()));
  const humanCount = visitors.filter((r) => { const text = clean(r.content); return HUMAN_REQUEST.test(text) && !HUMAN_INFO_QUESTION.test(text); }).length;
  const transcript = visitors.map((r) => clean(r.content)).join(" ");
  const priorClarifications = rows.filter((r) => {
    const m = obj(r.metadata); return !!m && (CLARIFICATION_ROUTES.has(String(m.response_route ?? "")) || m.escalation_action === "clarification");
  }).length;
  const explicit = opts.explicit_human_request ?? HUMAN_REQUEST.test(latestMessage);
  const strength = opts.request_strength ?? ((STRONG_REQUEST.test(latestMessage) || humanCount >= 2) ? "strong" : "standard");
  const anger = opts.anger_level ?? (ANGER.test(latestMessage) ? "high" : null);
  const refusal = opts.customer_refused_more_questions ?? REFUSED.test(latestMessage);
  const repetition = opts.frustration_due_to_repetition ?? REPETITION_FRUSTRATION.test(transcript.slice(-1200));
  const actionability = opts.missing_info_actionability ?? (requiredMissing.length === 0 ? "none" : requiredMissing.length === 1 && ["model","order_reference"].includes(requiredMissing[0]!) ? "high" : "low");
  return {
    explicit_human_request: explicit,
    human_request_count: opts.human_request_count ?? humanCount,
    request_strength: strength,
    anger_level: anger,
    sentiment_trend: opts.sentiment_trend ?? null,
    frustration_due_to_repetition: repetition,
    unresolved_turns: opts.unresolved_turns ?? 0,
    same_intent_repeat: opts.same_intent_repeat ?? false,
    prior_clarification_count: opts.prior_clarification_count ?? priorClarifications,
    customer_refused_more_questions: refusal,
    vip_tier: opts.vip_tier ?? null,
    high_value_customer: opts.high_value_customer ?? null,
    predicted_csat: opts.predicted_csat ?? null,
    churn_risk: opts.churn_risk ?? null,
    policy_risk: opts.policy_risk ?? null,
    threat_flag: opts.threat_flag ?? false,
    rag_state: opts.rag_state ?? null,
    handoff_history: opts.handoff_history ?? humanCount,
    current_intent: opts.current_intent ?? null,
    current_topic: opts.current_topic ?? null,
    required_info_missing: [...requiredMissing],
    missing_info_actionability: actionability,
  };
}
export function evaluateHandoffDecision(input: HandoffDecisionInput): HandoffDecision {
  const reasons: string[] = [];
  if (input.threat_flag || input.policy_risk === "high") {
    reasons.push(input.threat_flag ? "threat_or_safety_risk" : "high_policy_risk");
    return { handoff_mode:"immediate", handoff_priority:"emergency", missing_info_policy:"do_not_ask", reason_codes:reasons };
  }
  if (input.explicit_human_request) {
    const immediate = input.request_strength === "strong" || input.human_request_count >= 2 || input.anger_level === "high" || input.frustration_due_to_repetition || input.unresolved_turns >= 2 || input.prior_clarification_count > 0 || (input.same_intent_repeat && input.prior_clarification_count > 0) || input.customer_refused_more_questions;
    if (immediate) {
      if (input.request_strength === "strong") reasons.push("strong_explicit_human_request");
      if (input.human_request_count >= 2) reasons.push("repeated_human_request");
      if (input.anger_level === "high") reasons.push("high_anger");
      if (input.frustration_due_to_repetition) reasons.push("repetition_frustration");
      if (input.unresolved_turns >= 2) reasons.push("multiple_unresolved_turns");
      if (input.prior_clarification_count > 0) reasons.push("already_clarified");
      if (input.customer_refused_more_questions) reasons.push("customer_refused_more_questions");
      return { handoff_mode:"immediate", handoff_priority:"required", missing_info_policy:"do_not_ask", reason_codes:reasons };
    }
    if (input.required_info_missing.length === 1 && input.missing_info_actionability === "high") {
      return { handoff_mode:"optional_clarification_then_handoff", handoff_priority:"required", missing_info_policy:"ask_once_optional", reason_codes:["first_calm_human_request","one_high_value_missing_fact"] };
    }
    return { handoff_mode:"immediate", handoff_priority:"required", missing_info_policy:"ask_if_customer_willing", reason_codes:["explicit_human_request_override"] };
  }
  if (input.vip_tier || input.high_value_customer === true || (input.predicted_csat !== null && input.predicted_csat < 3) || (input.churn_risk !== null && input.churn_risk >= 0.7)) {
    return { handoff_mode:"normal_ai_continue", handoff_priority:"advisory", missing_info_policy:"ask_if_customer_willing", reason_codes:["advisory_signal_only"] };
  }
  return { handoff_mode:"normal_ai_continue", handoff_priority:"advisory", missing_info_policy:"ask_if_customer_willing", reason_codes:["no_handoff_trigger"] };
}
