import { deriveHandoffDecisionInput, evaluateHandoffDecision } from "./handoff-decision.ts";
import { classifyConversationClosure, buildConversationClosureReply } from "./conversation-closure.ts";
function a(v:unknown,n:string):asserts v { if(!v) throw new Error(`ASSERT_FAIL:${n}`); }
const rows=(xs:string[])=>xs.map(content=>({role:"visitor",content}));
let i=deriveHandoffDecisionInput(rows(["可以幫我轉真人客服嗎？"]),"可以幫我轉真人客服嗎？",["order_reference"],{explicit_human_request:true});
let d=evaluateHandoffDecision(i); a(d.handoff_mode==="optional_clarification_then_handoff","calm_first_optional"); a(d.missing_info_policy==="ask_once_optional","optional_once");
i=deriveHandoffDecisionInput(rows(["我要真人客服","我說了我要真人客服"]),"我說了我要真人客服",["order_reference"],{explicit_human_request:true}); d=evaluateHandoffDecision(i); a(d.handoff_mode==="immediate","repeat_immediate");
i=deriveHandoffDecisionInput(rows(["不要AI，我只要真人客服"]),"不要AI，我只要真人客服",["order_reference"],{explicit_human_request:true}); d=evaluateHandoffDecision(i); a(d.handoff_mode==="immediate"&&d.missing_info_policy==="do_not_ask","no_ai_immediate");
i=deriveHandoffDecisionInput(rows(["我很生氣，轉真人客服"]),"我很生氣，轉真人客服",["model"],{explicit_human_request:true}); d=evaluateHandoffDecision(i); a(d.handoff_mode==="immediate","anger_immediate");
i=deriveHandoffDecisionInput(rows(["VIP會員"]),"VIP會員",[],{vip_tier:"gold"}); d=evaluateHandoffDecision(i); a(d.handoff_mode==="normal_ai_continue","vip_alone_not_handoff");
i=deriveHandoffDecisionInput(rows(["真人客服幾點有人？"]),"真人客服幾點有人？",[],{explicit_human_request:false}); d=evaluateHandoffDecision(i); a(d.handoff_mode==="normal_ai_continue","support_hours_not_r1");
i=deriveHandoffDecisionInput(rows(["現在我要真人客服"]),"現在我要真人客服",["model"],{explicit_human_request:true,threat_flag:true}); d=evaluateHandoffDecision(i); a(d.handoff_priority==="emergency"&&d.handoff_mode==="immediate","threat_emergency");
a(classifyConversationClosure("沒有了").kind==="no_more_help","no_more_help");
a(classifyConversationClosure("很滿意，沒有其他問題").kind==="positive_no_more_help","positive_no_more_help");
a(classifyConversationClosure("沒有型號").kind==="none","missing_model_not_closure");
a(classifyConversationClosure("沒有收到貨").kind==="none","missing_delivery_not_closure");
a(classifyConversationClosure("謝謝").kind==="closure_candidate","thanks_candidate");
a((buildConversationClosureReply(classifyConversationClosure("謝謝"))??"").includes("還有什麼"),"anything_else_prompt");
console.log("HF1_DIRECTOR_UNIT_ASSERTIONS=PASS");
