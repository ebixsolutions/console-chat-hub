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
const NEGATED=/(?:\b(?:don't|do not|never|not)\s+(?:(?:want|need|require|ask\s+for)\s+(?:(?:to\s+)?(?:talk|speak|chat)\s+(?:to|with)\s+)?(?:a\s+|an\s+|any\s+)?(?:human|agent|person|someone|representative)\b|(?:transfer|connect|put|route|handoff|hand\s+off|get)\b.{0,26}\b(?:human|agent|person|someone|representative)\b)|\bnot\s+(?:asking|requesting|looking)(?:\s+for)?\s+(?:(?:an?|any)\s+)?(?:human|agent|person)\b|\b(?:human|agent|person|representative)\b.{0,12}\b(?:not\s+needed|not\s+required|no\s+need)\b|(?:唔好|不要|不用|不需要|唔需要|不想|唔想|唔使|未叫|冇叫|沒要求|没要求|取消|撤回|禁止)\s*(?:(?:而家|現在|现在|再)?(?:跟|同|與|与)\s*)?(?:要|請|请|幫|帮|轉|转|接|搵|找|聯絡|联系|給|给|安排)?\s*(?:真人|人工(?:客服)?|客服(?:人員|人员)?|專人|专人|職員|职员|個人|个人)|(?:真人|人工|專人|专人).{0,8}(?:唔使|不需要|不要|不用))/iu;
const CONDITION=/\b(?:if|unless|in case|hypothetically|suppose|imagine|assuming)\b|如果|若果|假如|假設|假设|萬一|万一|除非|答唔到|答不到|查唔到|查不到/iu;
const LATER=/\b(?:later|afterwards|eventually|in the future|tomorrow|next\s+(?:week|month|day|time|year))\b|之後|之后|遲啲|迟点|稍後|稍后|聽日|听日|明天|下次|日後|日后/iu;
const INFO=/\b(?:what\s+(?:are|is|time)|when|how\s+(?:long|much)|opening\s+hours|support\s+hours|service\s+hours|process|workflow|eligibility)\b|(?:服務|服务|營業|营业|辦公|办公)(?:時間|时间)|(?:幾點|几点|幾時|何時|何时|多久|幾耐|流程|收費|收费|資格|资格)/iu;
const INDIRECT=/\b(?:maybe|perhaps|might)\b|可能|(?:有沒有|有冇|有無|有没有|有无).{0,16}(?:真人|人工|客服|專人|专人)|^(?:human|agent|person|representative|operator|staff|真人|人工|客服|專人)[?？.!！\s]*$/iu;
const norm=(text:string)=>String(text??"").normalize("NFKC").trim();
const W1_CONFIRM_YES=new Set(["yes","y","yup","yeah","yep","sure","ok","okay","please","please do","of course","go ahead","好","好的","好呀","好啊","好唔該","可以","需要","需要呀","要","要呀","想","想呀","對","对","嗯","嗯嗯","係","係呀","系","是","是的","請轉接","请转接","麻煩你","麻烦你","麻煩你了","麻烦你了","唔該","唔该"]);
const W1_CONFIRM_NO=new Set(["no","nope","nah","not now","cancel","不用","不用了","不用啦","不需要","不需要了","不要","不要了","唔使","唔使喇","唔好","算了","暫時唔使","暂时不用"]);
function w1ConfirmationToken(text:string):string{
 let clean=norm(text).toLowerCase().replace(/[，,。.!！?？、]+/gu," ").replace(/\s+/gu," ").trim();
 for(let n=0;n<3;n++){
  const next=clean.replace(/(?:\s+|^)(?:please|pls|thank you|thanks|thx|謝謝|谢谢|多謝|多谢|唔該|唔该)$/iu,"").trim();
  if(!next||next===clean)break;
  clean=next;
 }
 // Chinese courtesy also occurs without a comma or space.
 if(/(?:謝謝|谢谢|多謝|多谢)$/u.test(clean)&&clean.length>2)
   clean=clean.replace(/(?:謝謝|谢谢|多謝|多谢)$/u,"").trim();
 return clean;
}

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
export const w1Affirms=(s:string)=>W1_CONFIRM_YES.has(w1ConfirmationToken(s));
export const w1Declines=(s:string)=>W1_CONFIRM_NO.has(w1ConfirmationToken(s));
/** Only representational differences of the *existing* free-text intent.
 * A missing/wrong intent never authorizes R1 from a model boolean alone. */
export const w1HumanIntentAccepted=(value:unknown):boolean=>
 typeof value==="string" && norm(value).toLowerCase().replace(/[\s-]+/gu,"_")===W1_HUMAN_INTENT;
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
 if(CONDITION.test(courtesy)||LATER.test(courtesy))return "excluded";
 const directHumanAction=/(?:\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:(?:an?|the)\s+)?(?:real\s+)?(?:human|person|agent|representative|someone)\b|\b(?:transfer|connect|get|put)\s+(?:me\s+(?:to\s+)?)?(?:(?:an?|the)\s+)?(?:human|person|agent|representative|someone)\b|(?:請|请|麻煩|麻烦|要|想|搵|找|轉|转|叫|幫|帮|給|给).{0,15}(?:真人|人工|專人|专人|個人|个人|客服))/iu.test(active);
 if(INFO.test(courtesy) && !directHumanAction)return "excluded";
 if(INFO.test(courtesy) && /^(?:when\b|幾時|几时|何時|何时)/iu.test(courtesy))return "confirm";
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
/** The unlabelled W1 safety net is NOT a second handoff classifier.
 * It is allowed only after the original, complete service planner has failed
 * to find an answerable business path, on a trusted current-source turn.
 * Model-only or a person-word alone never grants transfer/confirmation. */
export function w1NoLabelFallbackEligible(input:{
 sourceVerified:boolean; humanPossible:boolean; acceptedModelIntent:boolean;
 pendingConfirmation:boolean; semanticOperation:string|null;
 semanticDemandCount:number; requestedFactCount:number; hasBusinessRequest:boolean;
 plan:{action:string; handoff_context?:string|null; knowledge_state?:string|null;
   kb_query?:string|null; clarification_target?:string|null};
}):boolean{
 if(!input.sourceVerified||!input.humanPossible||input.acceptedModelIntent||
    input.pendingConfirmation||input.hasBusinessRequest||
    input.semanticDemandCount>0||input.requestedFactCount>0||
    input.plan.knowledge_state==="lookup_required"||!!input.plan.kb_query) return false;
 if(!["ASK_FACT","NO_STATE_CHANGE"].includes(String(input.semanticOperation)))return false;
 // Existing canonical mention-only control route, not a merchant answer.
 if(input.plan.action==="handoff_context_acknowledgement")
   return input.plan.handoff_context==="mention_only";
 // Unrecognised non-canonical human wording (e.g. 個人) may otherwise
 // dead-end in a generic product/goal question. No commercial demand allowed.
 return input.semanticOperation==="NO_STATE_CHANGE" &&
   input.plan.action==="targeted_clarification" &&
   ["customer_goal","specific_product_or_item","specific_item_or_time"].includes(String(input.plan.clarification_target));
}
export function w1Decision(
 text:string, acceptedIntent:unknown, sourceVerified:boolean, verifiedLocale?:W1Locale|null
):W1Decision{
 const raw=norm(text),locale=w1Locale(raw,verifiedLocale);
 const out=(action:W1Action,reason:string):W1Decision=>({action,locale,reason});
 if(!sourceVerified)return out("excluded","unverified_current_source");
 if(!w1HumanIntentAccepted(acceptedIntent))return out("continue","no_accepted_human_intent");
 const clauses=w1EffectiveClauses(raw).map(w1ClauseVerdict);
 if(clauses.includes("r1"))return out("r1","source_bound_human_request_now");
 if(clauses.includes("confirm"))return out("confirm","indirect_or_unbound_human_wish");
 if(clauses.includes("excluded"))return out("excluded","current_human_request_excluded");
 // A validated understanding proposal without a recognized person referent
 // must receive one neutral question; it never grants R1 itself.
 return out("confirm","model_proposal_without_current_human_referent");
}
/** A pending server-owned confirmation + current canonical model proposal may
 * transfer only for a present, non-excluded short answer. No new standalone
 * positive handoff classifier and no model-only grant. */
export function w1PendingIntentEligible(text:string):boolean{
 const raw=norm(text);
 if(!raw||raw.length>90||w1Declines(raw))return false;
 if(REPORTED.test(raw)||raw.replace(QUOTE,"").trim()!==raw)return false;
 if(CONDITION.test(raw)||LATER.test(raw)||NEGATED.test(raw)||INDIRECT.test(raw)||INFO.test(raw))return false;
 const clauses=w1EffectiveClauses(raw).map(w1ClauseVerdict);
 if(clauses.includes("excluded"))return false;
 if(clauses.includes("r1"))return true;
 // An ordinary separate business question is not an answer to the pending R1.
 if(/(?:\b(?:price|order|stock|booking|refund|delivery|shipping|policy)\b|價錢|价格|價格|訂單|订单|有貨|有货|庫存|库存|退款|送貨|送货|運費|运费)/iu.test(raw))return false;
 return !/[?？]/u.test(raw);
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
