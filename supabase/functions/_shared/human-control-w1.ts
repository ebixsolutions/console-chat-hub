/** W1 human-control interpretation bridge. Pure proposal validation, not an R1
 * permission, a model call, or a completed transfer. Original B2/atomic RPC
 * remains the only writer. No tenant, company or industry hardcoding. */
import {classifyHandoffIntent} from "./handoff-intent.ts";
export const W1_HUMAN_INTENT="request_human_now" as const;
export type W1Locale="en"|"zh-TW"|"zh-CN"|"yue-Hant";
export type W1Action="r1"|"confirm"|"excluded"|"continue"|"needs_understanding";
export interface W1Decision { action:W1Action; locale:W1Locale; reason:string }
const PERSON=/(?:真人|人工(?:客服|服務|服务)?|客服(?:人員|人员)?|專人|专人|職員|职员|個人|个人|人員|人员|\b(?:human|real\s+person|real\s+human|person|someone|representative|agent|operator|staff|specialist)\b)/iu;
const BOT_WISH=/(?:唔想|不想|不要|不願|不愿).{0,8}(?:機械人|机器人|bot|ai)|\b(?:don't|do not)\s+want\s+(?:a\s+)?bot\b/iu;
const QUOTE=/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|‘[^’]*’|(?<!\w)'[^']*'(?!\w)/gu;
const REPORTED=/^(?:(?:my|the|a)\s+)?(?:friend|customer|client|user|colleague|he|she|they)\s+(?:said|asked|wrote|mentioned)\b|^(?:佢|他|她|同事|朋友|客人|顧客|顾客).{0,8}(?:話|话|說|说|表示|提到)/iu;
const NEGATED=/(?:don't|do not|never|not asking|no need|don't need|do not need|not yet|cancel|withdraw|revoke)\b.{0,50}(?:human|agent|person|someone|representative|transfer|handoff)|(?:唔好|不要|不用|不需要|唔需要|不想|唔想|唔使|未叫|冇叫|沒要求|没要求|取消|撤回|禁止).{0,20}(?:轉|转|真人|人工|客服|專人|专人|職員|职员|個人|个人)|(?:human|agent|person|representative).{0,20}(?:not needed|not required)/iu;
const CONDITION=/\b(?:if|unless|in case|hypothetically|suppose|imagine|assuming)\b|如果|若果|假如|假設|假设|萬一|万一|除非|答唔到|答不到|查唔到|查不到/iu;
const LATER=/\b(?:later|afterwards|eventually|in the future|tomorrow|next\s+(?:week|month|day|time|year))\b|之後|之后|遲啲|迟点|稍後|稍后|聽日|听日|明天|下次|日後|日后/iu;
const INFO=/\b(?:what\s+(?:are|is|time)|when|how\s+(?:long|much)|opening\s+hours|support\s+hours|service\s+hours|process|workflow|eligibility)\b|(?:服務|服务|營業|营业|辦公|办公)(?:時間|时间)|(?:幾點|几点|幾時|何時|何时|多久|幾耐|流程|收費|收费|資格|资格)/iu;
const INDIRECT=/\b(?:maybe|perhaps|might)\b|可能|(?:有沒有|有冇|有無|有没有|有无).{0,16}(?:真人|人工|客服|專人|专人)|^(?:human|agent|person|representative|operator|staff|真人|人工|客服|專人)[?？.!！\s]*$/iu;
const YES=/^(?:yes(?:\s+please)?|yeah|yep|sure|okay|ok|please\s+do|好(?:的|啊|呀|呀唔該)?|可以|請轉接|请转接|係|係呀|系|是|是的|麻煩你|麻烦你)[.!！。\s]*$/iu;
const NO=/^(?:no(?:\s+thanks)?|not\s+now|cancel|不用(?:了)?|不要(?:了)?|唔使(?:喇)?|唔好|算了)[.!！。\s]*$/iu;
const norm=(text:string)=>String(text??"").normalize("NFKC").trim();
export function w1Locale(text:string, verified?:W1Locale|null):W1Locale{
 if(verified && ["en","zh-TW","zh-CN","yue-Hant"].includes(verified))return verified;
 const x=norm(text);
 if(!/[\u4e00-\u9fff]/u.test(x))return "en";
 if(/[唔冇嘅嚟搵佢咗啲喺攞]/u.test(x))return "yue-Hant";
 if(/[转们队为说刚迟边这吗员请帮]/u.test(x))return "zh-CN";
 return "zh-TW";
}

/** Only explicit visitor language choices may override the current utterance.
 * The caller obtains history from its authenticated, source-bounded ticket.
 * Merchant/KB text, staff notes and assistant proposals are not preferences. */
function w1LocaleInstruction(text:string):W1Locale|null{
 const raw=norm(text).replace(QUOTE," ");
 const tests:Array<[W1Locale,RegExp]>=[
  ["en",/(?:\b(?:reply|answer|respond|write|speak|use)\s+(?:(?:to\s+me\s+)?in\s+)?english\b|\b(?:i\s+prefer|language\s*[:=])\s*english\b|(?:請|请|麻煩|麻烦|用|以|答|回覆|回复).{0,7}(?:英文|英語|英语))/giu],
  ["yue-Hant",/(?:\b(?:reply|answer|respond|speak|use)\s+(?:in\s+)?cantonese\b|(?:請|请|用|以|講|说|說|答|回覆|回复).{0,7}(?:廣東話|广东话|粵語|粤语))/giu],
  ["zh-CN",/(?:\b(?:reply|answer|respond|use)\s+(?:in\s+)?simplified\s+chinese\b|(?:請|请|用|以|答|回覆|回复).{0,7}(?:简体中文|簡體中文|普通话|普通話))/giu],
  ["zh-TW",/(?:\b(?:reply|answer|respond|use)\s+(?:in\s+)?traditional\s+chinese\b|(?:請|请|用|以|答|回覆|回复).{0,7}(?:繁體中文|繁体中文|臺灣國語|台灣國語))/giu]
 ];
 let selected:W1Locale|null=null,at=-1;
 for(const [locale,pattern] of tests){for(const match of raw.matchAll(pattern)){
  const prior=raw.slice(Math.max(0,match.index-12),match.index);
  if(/(?:\bdon't\s*$|\bdo\s+not\s*$|唔好\s*$|不要\s*$|不用\s*$|勿\s*$)/iu.test(prior))continue;
  if(match.index>=at){selected=locale;at=match.index;}
 }}
 return selected;
}
export function w1HistoryLocale(
 current:string, history:readonly {role?:unknown;content?:unknown;is_recalled?:unknown}[]
):W1Locale|null{
 const direct=w1LocaleInstruction(current);if(direct)return direct;
 // Source-bound history is newest first; a later explicit preference wins.
 for(const row of history){if(row.role!=="visitor"||row.is_recalled!==false||typeof row.content!=="string")continue;
  const preferred=w1LocaleInstruction(row.content);if(preferred)return preferred;
 }
 return null;
}
export const w1Affirms=(s:string)=>YES.test(norm(s));
export const w1Declines=(s:string)=>NO.test(norm(s));
/** Mixed demand isolation. Negation, quotation, condition and information
 * checks apply to the actual human-request clause, not a separate business
 * question in the same message. Keep conditional antecedents attached across
 * commas: "if X, transfer me" is NOT a present R1 request. */
const W1_INDEPENDENT_BREAK=/[。.!！?？;；\n]+|[,，](?=\s*(?:另外|仲有|還有|还有|同時|同时|what\b|how\b|when\b|why\b|where\b|also\b|and\b|幾時|幾點|幾錢|多少|有冇|有沒有|有没有|請問|请问))|\b(?:and|also)\b(?=\s*(?:what|how|when|why|where|can|could|does|do|is|are|I\s+(?:want|need)\s+to\s+(?:know|ask))\b)/iu;
type W1ClauseVerdict="r1"|"confirm"|"excluded"|"none";
function w1EffectiveClauses(text:string):string[]{
 return norm(text).replace(QUOTE," ").split(W1_INDEPENDENT_BREAK).map(s=>s.trim()).filter(Boolean);
}
function w1ClauseVerdict(text:string):W1ClauseVerdict{
 const active=norm(text);
 if(!PERSON.test(active)&&!BOT_WISH.test(active))return "none";
 if(REPORTED.test(active))return "excluded";
 // Reject a human transfer negation but not "I don't want a bot, I want a human".
 const humanNegationText=active.replace(/\b(?:don't|do not)\s+(?:want|need|use)\s+(?:a\s+|an\s+)?(?:bot|robot|ai|app)(?=\s*[,，])/giu," ");
 if(NEGATED.test(humanNegationText))return "excluded";
 const courtesy=active.replace(/\bif\s+possible\b/giu," ");
 if(CONDITION.test(courtesy)||LATER.test(courtesy)||INFO.test(courtesy))return "excluded";
 if(INDIRECT.test(active)||!PERSON.test(active))return "confirm";
 return "r1";
}
export function w1HumanPossible(text:string):boolean{
 const raw=norm(text), classified=classifyHandoffIntent(raw);
 if(classified.explicit_request)return false; // Existing zero-extra-model R1.
 return w1EffectiveClauses(raw).some(clause=>{
  const decision=w1ClauseVerdict(clause);return decision==="r1"||decision==="confirm";
 });
}
export function w1Decision(
 text:string, acceptedIntent:unknown, sourceVerified:boolean, verifiedLocale?:W1Locale|null
):W1Decision{
 const raw=norm(text),locale=w1Locale(raw,verifiedLocale);
 const out=(action:W1Action,reason:string):W1Decision=>({action,locale,reason});
 if(!sourceVerified)return out("excluded","unverified_current_source");
 if(acceptedIntent!==W1_HUMAN_INTENT)return out("continue","no_accepted_human_intent");
 const clauses=w1EffectiveClauses(raw).map(w1ClauseVerdict);
 if(clauses.includes("r1"))return out("r1","source_bound_human_request_now");
 if(clauses.includes("confirm"))return out("confirm","indirect_or_unbound_human_wish");
 return clauses.includes("excluded")
  ?out("excluded","current_human_request_excluded")
  :out("continue","no_current_human_referent");
}
export function w1Confirmation(locale:W1Locale):string{
 return {en:"Would you like me to connect you with a human support agent now?","zh-TW":"需要我現在為您轉接真人客服嗎？","zh-CN":"需要我现在为您转接人工客服吗？","yue-Hant":"你想我而家幫你轉真人客服嗎？"}[locale];
}
export function w1Acknowledgement(locale:W1Locale):string{
 return {en:"Understood. This message has not transferred you to human support.","zh-TW":"收到。本次訊息沒有執行真人客服轉接。","zh-CN":"收到。本次消息没有执行人工客服转接。","yue-Hant":"收到，呢則訊息冇幫你轉真人客服。"}[locale];
}
export function w1HandoffReply(locale:W1Locale):string{
 return {en:"I've handed this conversation to a human support agent. They can reply in this chat after taking over.","zh-TW":"已將本對話轉交真人客服；客服接手後會在同一對話回覆您。","zh-CN":"已将本次对话转交人工客服；客服接手后会在同一对话回复您。","yue-Hant":"已經幫你將呢個對話轉交真人客服，客服接手後會喺同一對話覆你。"}[locale];
}
