import { isDirectViolentThreat } from "./e2-direct-threat.ts";

export type ConversationClosureKind = "none" | "closure_candidate" | "no_more_help" | "positive_no_more_help";
export type ConversationClosureClassification = { kind: ConversationClosureKind; language: "zh-TW" | "zh-CN" | "en"; reason: string };
const MISSING_FACT_GUARD = /(沒有|没有|冇|未有|不知道|唔知|no|don['’]?t have|do not have).{0,16}(型號|型号|model|訂單|订单|order|收到|收貨|收货|貨|货|地址|電話|电话|email|電郵|邮箱|付款|payment)/i;
const HANDOFF_GUARD = /(真人客服|人工客服|真人|人工|human agent|live agent|real person|speak to (?:a )?human|talk to (?:a )?human|transfer me|connect me)/i;
const HIGH_RISK_GUARD = /(爆炸|起火|著火|触电|觸電|漏電|受傷|受伤|危險|危险|安全事故|法律|合規|合规|投訴|投诉|fraud|scam|explod|fire|electric shock|injur|danger|legal|compliance|complaint)/i;
const NO_MORE = /(?:沒有了|没有了|冇喇|冇啦|沒有其他(?:問題)?|没有其他(?:问题)?|暫時沒有|暂时没有|不用了|唔使喇|唔使啦|就這樣|就这样|沒事了|没事了|沒有問題了|没有问题了|no more|nothing else|that['’]?s all|no thanks|all good|i['’]?m good)/i;
const POSITIVE = /(滿意|满意|很好|幫到我|帮到我|解決了|解决了|多謝|謝謝|谢谢|great|good service|helpful|satisfied|resolved)/i;
const ACK_ONLY = /^(?:謝謝|谢谢|多謝|唔該|明白|明白了|知道了|收到|好的|好|ok|okay|got it|understood|thanks|thank you)[。.!！?？\s]*$/i;
function lang(t:string): "zh-TW"|"zh-CN"|"en" { if (!/[\u4e00-\u9fff]/.test(t)) return "en"; return /[转们队为这吗个]/.test(t) ? "zh-CN" : "zh-TW"; }
export function classifyConversationClosure(text:string): ConversationClosureClassification {
  const t=String(text??"").normalize("NFKC").trim(); const language=lang(t);
  if (!t) return {kind:"none",language,reason:"empty"};
  if (isDirectViolentThreat(t)) return {kind:"none",language,reason:"e2_threat_precedes_closure"};
  if (HANDOFF_GUARD.test(t)) return {kind:"none",language,reason:"human_handoff_precedes_closure"};
  if (HIGH_RISK_GUARD.test(t)) return {kind:"none",language,reason:"risk_review_precedes_closure"};
  if (MISSING_FACT_GUARD.test(t)) return {kind:"none",language,reason:"missing_fact_not_closure"};
  if (NO_MORE.test(t)) return {kind:POSITIVE.test(t)?"positive_no_more_help":"no_more_help",language,reason:"customer_has_no_more_help_requests"};
  if (ACK_ONLY.test(t)) return {kind:"closure_candidate",language,reason:"customer_acknowledged_resolution"};
  return {kind:"none",language,reason:"substantive_or_unresolved_turn"};
}
export function buildConversationClosureReply(c:ConversationClosureClassification): string|null {
  if (c.kind === "none") return null;
  if (c.kind === "closure_candidate") return c.language === "en" ? "You're welcome. Is there anything else I can help you with?" : c.language === "zh-CN" ? "不用客气。还有什么可以帮到你吗？" : "不用客氣。還有什麼可以幫到你嗎？";
  return c.language === "en" ? "You're very welcome. Thank you for contacting us." : c.language === "zh-CN" ? "好的，不用客气。谢谢你联络我们！" : "好的，不用客氣。謝謝你聯絡我們！";
}
