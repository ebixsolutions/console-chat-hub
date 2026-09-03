from pathlib import Path

contract = Path('supabase/functions/_shared/conversation-semantic-contract.ts')
intel = Path('supabase/functions/_shared/conversation-intelligence.ts')
gen = Path('supabase/functions/generate-reply/index.ts')

s = contract.read_text()
if '| "CUSTOMER_CONTEXT_UPDATE"' not in s:
    s = s.replace('''  | "CONVERSATION_MEMORY"\n  | "UNDERSPECIFIED"''','''  | "CONVERSATION_MEMORY"\n  | "CUSTOMER_CONTEXT_UPDATE"\n  | "UNDERSPECIFIED"''',1)

marker = '''const QUESTIONISH = /[?？]|^(?:什麼|什么|如何|怎樣|怎样|哪|哪些|多久|幾耐|几耐|why|what|which|how|when|where)/i;'''
addition = marker + '''\nconst CUSTOMER_CONTEXT_UPDATE = /(?:^|[，,。.!！\\s])(?:我只知道|我只知|我目前只知道|我現在只知道|我现在只知道|我沒有|我没有|我冇|不知道型號|不知道型号|唔知型號|型號(?:是|係)?未知|型号(?:是)?未知|品牌(?:是|係)|大約.{0,24}(?:買|购买|購買)|大概.{0,24}(?:買|购买|購買)|現在.{0,32}(?:不冷|唔凍|不能|無法|无法)|现在.{0,32}(?:不冷|不能|无法)|i only know|i (?:do not|don't) have (?:the )?(?:model|model number|order number)|the brand is|brand is|i bought (?:it )?.{0,40}ago|it (?:powers|turns) on but)/i;\n\nexport function isCustomerContextUpdate(text: string): boolean {\n  const latest = clean(text);\n  if (!latest || QUESTIONISH.test(latest) || /[?？]/.test(latest)) return false;\n  return CUSTOMER_CONTEXT_UPDATE.test(latest);\n}'''
if 'export function isCustomerContextUpdate' not in s:
    assert marker in s
    s = s.replace(marker, addition, 1)

needle = '''  if (CORRECTION.test(latest)) {\n    return base("CORRECTION", "latest_turn_supersedes_prior_context", { needs_history: true, topic_action: "CORRECT" });\n  }'''
insert = needle + '''\n  if (isCustomerContextUpdate(latest)) {\n    return base("CUSTOMER_CONTEXT_UPDATE", "customer_supplied_context_without_factual_request", {\n      needs_history: true,\n      requires_new_kb_retrieval: false,\n      evidence_authority: "NONE",\n      topic_action: "KEEP",\n    });\n  }'''
if 'customer_supplied_context_without_factual_request' not in s:
    assert needle in s
    s = s.replace(needle, insert, 1)
contract.write_text(s)

s = intel.read_text()
if 'buildCustomerContextAcknowledgement' not in s:
    import_line = 'import { classifyCanonicalConversationTurn } from "./conversation-semantic-contract.ts";'
    assert import_line in s
    s = s.replace(import_line, 'import { classifyCanonicalConversationTurn, type SemanticLanguage } from "./conversation-semantic-contract.ts";', 1)
    anchor = '''export const NATURAL_CLARIFICATION: Record<"zh-TW" | "zh-CN" | "en", string> = {\n  "zh-TW": "可以，想確認一下你主要想處理哪一方面？例如送貨、付款、取消，還是退換貨？",\n  "zh-CN": "可以，想确认一下你主要想处理哪一方面？例如送货、付款、取消，还是退换货？",\n  en: "Sure — which part would you like help with, for example delivery, payment, cancellation, or a return/refund?",\n};'''
    helper = anchor + '''\n\nexport function buildCustomerContextAcknowledgement(language: SemanticLanguage): string {\n  if (language === "en") {\n    return "Got it. I’ll keep using the details you’ve provided and won’t guess anything that hasn’t been confirmed. If I need anything else, I’ll ask you directly.";\n  }\n  if (language === "zh-CN") {\n    return "收到。我会继续使用你已提供的资料，未确认的部分不会自行猜测；如果还需要其他资料，我会直接告诉你。";\n  }\n  return "收到。我會繼續使用你已提供的資料，未確認的部分不會自行猜測；如果還需要其他資料，我會直接告訴你。";\n}'''
    assert anchor in s
    s = s.replace(anchor, helper, 1)

    old_case = '''    case "CONVERSATION_MEMORY":\n      return { kind: "follow_up", should_clarify_before_kb: false, reason: semantic.reason };'''
    new_case = '''    case "CONVERSATION_MEMORY":\n    case "CUSTOMER_CONTEXT_UPDATE":\n      return { kind: "follow_up", should_clarify_before_kb: false, reason: semantic.reason };'''
    assert old_case in s
    s = s.replace(old_case, new_case, 1)
intel.write_text(s)

s = gen.read_text()
old_import = 'import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, buildCustomerAdvisoryContext, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";'
new_import = 'import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, buildCustomerAdvisoryContext, buildCustomerContextAcknowledgement, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";'
if new_import not in s:
    assert old_import in s
    s = s.replace(old_import, new_import, 1)

semantic_import = 'import { classifyCanonicalConversationTurn } from "../_shared/conversation-semantic-contract.ts";'
if semantic_import not in s:
    anchor_import = 'import { buildCanonicalRetrievalQuery, buildCanonicalContinuityBlock, resolveConversationMemoryResponse } from "../_shared/conversation-runtime-state.ts";'
    assert anchor_import in s
    s = s.replace(anchor_import, anchor_import + '\n' + semantic_import, 1)

anchor = '''  const _visitorLang = detectVisitorLanguage(_h1LastMsg);\n  const _turnClassification = classifyConversationTurn(_h1LastMsg);'''
replacement = '''  const _visitorLang = detectVisitorLanguage(_h1LastMsg);\n  const _canonicalTurn = classifyCanonicalConversationTurn(\n    _h1LastMsg,\n    _pr5HistoryRows ?? [],\n    { explicit_handoff: isHandoffIntent(_h1LastMsg) },\n  );\n  if (_canonicalTurn.operation === "CUSTOMER_CONTEXT_UPDATE") {\n    const acknowledgement = buildCustomerContextAcknowledgement(_canonicalTurn.language);\n    const contextCommit = await commitAiReplyWithControlGate(\n      supabaseAdmin,\n      conversation_id,\n      source_message_id,\n      acknowledgement,\n      {\n        response_route: "customer_context_update",\n        escalation_action: "continue_ai",\n        handoff_required: false,\n        reason_code: _canonicalTurn.reason,\n      },\n    );\n    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);\n    if (contextCommit.ok) {\n      return new Response(JSON.stringify({\n        success: true,\n        reply: acknowledgement,\n        response_route: "customer_context_update",\n        handoff_required: false,\n      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });\n    }\n    if (["human_control", "resolved", "superseded_source"].includes(contextCommit.result)) {\n      return new Response(JSON.stringify({ success: true, skipped: contextCommit.result }), {\n        headers: { ...corsHeaders, "Content-Type": "application/json" },\n      });\n    }\n    return new Response(JSON.stringify({ success: false, error: `context_update_commit_${contextCommit.result}` }), {\n      status: 409,\n      headers: { ...corsHeaders, "Content-Type": "application/json" },\n    });\n  }\n  const _turnClassification = classifyConversationTurn(_h1LastMsg);'''
if 'response_route: "customer_context_update"' not in s:
    assert anchor in s
    s = s.replace(anchor, replacement, 1)

gen.write_text(s)
print('TASK4_1_CUSTOMER_CONTEXT_UPDATE=APPLIED')