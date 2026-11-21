import { isDirectViolentThreat } from "./e2-direct-threat.ts";

export type ConversationClosureKind = "none" | "closure_candidate" | "no_more_help" | "positive_no_more_help";
export type ConversationClosureClassification = { kind: ConversationClosureKind; language: "zh-TW" | "zh-CN" | "en"; reason: string };
const MISSING_FACT_GUARD = /(沒有|没有|冇|未有|不知道|唔知|no|don['’]?t have|do not have).{0,16}(型號|型号|model|訂單|订单|order|收到|收貨|收货|貨|货|地址|電話|电话|email|電郵|邮箱|付款|payment)/i;
const HANDOFF_GUARD = /(真人客服|人工客服|真人|人工|human agent|live agent|real person|speak to (?:a )?human|talk to (?:a )?human|transfer me|connect me)/i;
const HIGH_RISK_GUARD = /(爆炸|起火|著火|触电|觸電|漏電|受傷|受伤|危險|危险|安全事故|法律|合規|合规|投訴|投诉|fraud|scam|explod|fire|electric shock|injur|danger|legal|compliance|complaint)/i;
// A closure phrase is authoritative only when the rest of the same message
// contains no additional service request. Do not reinterpret "no more ... but
// please check ..." or "no quote yet" as a customer-confirmed resolution.
const NO_MORE = /(?:沒有了|没有了|冇喇|冇啦|(?:暫時|暂时)?(?:沒有|没有|無|无|冇)(?:其他|別的|别的)(?:問題|问题|疑問|疑问)|暫時沒有|暂时没有|不用了|唔使喇|唔使啦|就這樣|就这样|沒事了|没事了|沒有問題了|没有问题了|no more(?:\s+(?:questions?|help|issues?))?|(?:i\s+)?(?:do\s+not|don['’]t)\s+have\s+any\s+more\s+questions?|nothing else|that['’]?s all|no thanks|all good|i['’]?m good)/i;
// A language-local end-of-conversation acknowledgement is not a grant to
// discard another service request in the same message. Fail closed unless
// text preceding the closure phrase consists entirely of safe closure-context
// words; this protects against "please check ...; no more questions".
const CLOSURE_PENDING_REQUEST = /(?:仲想|還想|还想|想問|想问|要問|要问|幫我|帮我|請先|请先|麻煩|麻烦|核實|核实|查詢|查询|查下|please|could you|can you|tell me|check|confirm|show me|how much|how long|i(?: still)? need|still want|not saying|not sure|not yet|先|before|but|不過|不过)/iu;
const CLOSURE_SAFE_PREFIX = /^(?:(?:[\s，,。.!！;；]*)?(?:係|是|好|好的|对|對|嗯|yes|yeah|okay|ok|no|多謝|謝謝|谢谢|thanks|thank\s+you|我|i(?: have)?|幫到我|帮到我)[\s，,。.!！;；]*)*(?:[^?？\n]{1,70}(?:問題|问题|issue|question)[\s，,。.!！;；]*(?:已經|已经|has been|is|was)?[\s，,。.!！;；]*(?:解決(?:了)?|解决(?:了)?|resolved|solved)[\s，,。.!！;；]*)?$/iu;
const CLOSURE_COURTESY_SUFFIX = /^[\s，,。.!！;；]*(?:(?:多謝|謝謝|谢谢|唔該|唔该|thank\s+you|thanks|bye|goodbye|了|啦|喇)[\s，,。.!！;；]*)*$/i;
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
  const noMore = NO_MORE.exec(t);
  if (noMore) {
    const before = t.slice(0, noMore.index);
    const after = t.slice(noMore.index + noMore[0].length);
    // More questions or instructions in this same customer turn outrank a
    // preceding no-more/help-ended phrase. The canonical Commerce blockers
    // remain a separate mandatory server-side resolution guard.
    if (/[?？]/u.test(before) || CLOSURE_PENDING_REQUEST.test(before) ||
        !CLOSURE_SAFE_PREFIX.test(before) || !CLOSURE_COURTESY_SUFFIX.test(after)) {
      return {kind:"none",language,reason:"follow_up_or_missing_fact_precedes_closure"};
    }
    return {kind:POSITIVE.test(t)?"positive_no_more_help":"no_more_help",language,reason:"customer_has_no_more_help_requests"};
  }
  if (ACK_ONLY.test(t)) return {kind:"closure_candidate",language,reason:"customer_acknowledged_resolution"};
  return {kind:"none",language,reason:"substantive_or_unresolved_turn"};
}
export function buildConversationClosureReply(c:ConversationClosureClassification): string|null {
  if (c.kind === "none") return null;
  if (c.kind === "closure_candidate") return c.language === "en" ? "You're welcome. Is there anything else I can help you with?" : c.language === "zh-CN" ? "不用客气。还有什么可以帮到你吗？" : "不用客氣。還有什麼可以幫到你嗎？";
  return c.language === "en" ? "You're very welcome. Thank you for contacting us." : c.language === "zh-CN" ? "好的，不用客气。谢谢你联络我们！" : "好的，不用客氣。謝謝你聯絡我們！";
}
