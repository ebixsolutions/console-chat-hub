from pathlib import Path

contract = Path('supabase/functions/_shared/conversation-semantic-contract.ts')
intel = Path('supabase/functions/_shared/conversation-intelligence.ts')
gen = Path('supabase/functions/generate-reply/index.ts')

s = contract.read_text()
marker = 'const CUSTOMER_CONTEXT_UPDATE = /'
assert marker in s
if 'CUSTOMER_CONTEXT_REQUIREMENTS' not in s:
    insert_at = s.index(marker)
    line_end = s.index('\n', insert_at)
    # place requirements regex immediately before passive context-update regex
    req = '''const CUSTOMER_CONTEXT_REQUIREMENTS = /(?:你|妳|您).{0,12}(?:還|还)?需要(?:我)?(?:再)?提供(?:什麼|什么|哪些|咩)(?:資料|资料|資訊|信息|details|information)|(?:還|还)需要(?:我)?提供(?:什麼|什么|哪些|咩)(?:資料|资料|資訊|信息)|what (?:information|details) do you (?:still )?need from me|what else do you need from me/i;\n'''
    s = s[:insert_at] + req + s[insert_at:]

# Direct requirements question remains the same CUSTOMER_CONTEXT_UPDATE workflow,
# but is distinguished by reason so runtime can return targeted requirements.
needle = '''  if (CORRECTION.test(latest)) {\n    return base("CORRECTION", "latest_turn_supersedes_prior_context", { needs_history: true, topic_action: "CORRECT" });\n  }'''
block = needle + '''\n  if (CUSTOMER_CONTEXT_REQUIREMENTS.test(latest)) {\n    return base("CUSTOMER_CONTEXT_UPDATE", "customer_context_requirements_request", {\n      needs_history: true,\n      requires_new_kb_retrieval: false,\n      evidence_authority: "CONVERSATION_MEMORY",\n      topic_action: "KEEP",\n    });\n  }'''
if 'customer_context_requirements_request' not in s:
    assert needle in s
    s = s.replace(needle, block, 1)
contract.write_text(s)

s = intel.read_text()
if 'buildCustomerContextRequirementsResponse' not in s:
    anchor = '''export function buildCustomerContextAcknowledgement(language: SemanticLanguage): string {'''
    pos = s.index(anchor)
    # insert helper before acknowledgement helper
    helper = '''export function buildCustomerContextRequirementsResponse(\n  language: SemanticLanguage,\n  newestFirstMessages: ConversationHistoryRow[],\n): string {\n  const customerTurns = newestFirstMessages\n    .filter((row) => CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase()))\n    .map((row) => cleanContinuityText(row.content))\n    .filter(Boolean)\n    .slice(0, 12);\n  const joined = customerTurns.join(" ");\n  const missingModel = /(?:沒有|没有|冇|不知道|唔知).{0,8}(?:型號|型号)|(?:don't|do not) have (?:the )?(?:model|model number)/i.test(joined);\n  const hasBrand = /(?:品牌(?:是|係)|brand is|\\bpanasonic\\b|\\bsamsung\\b|\\blg\\b|\\bsony\\b|\\bwhirlpool\\b)/i.test(joined);\n  const hasApplianceType = /(?:冷氣|空調|空调|洗衣機|洗衣机|雪櫃|冰箱|電視|电视|家用電器|家用电器|air conditioner|washing machine|refrigerator|fridge|television|\\btv\\b)/i.test(joined);\n\n  if (language === "en") {\n    const known = missingModel ? "You’ve already told me you don’t have the model number, so you don’t need to repeat that. " : "";\n    const asks = [];\n    if (!hasApplianceType) asks.push("what type of appliance it is");\n    if (!hasBrand) asks.push("the brand, if you know it");\n    asks.push("roughly when you bought it", "what is happening now");\n    return known + "Please tell me " + asks.join(", ") + ".";\n  }\n  const known = missingModel\n    ? (language === "zh-CN" ? "你已经说目前没有型号，不用重复提供。" : "你已經說目前沒有型號，不用重複提供。")\n    : "";\n  if (language === "zh-CN") {\n    return known + `请告诉我${hasApplianceType ? "更具体是哪一类家用电器" : "是哪一类家用电器"}${hasBrand ? "" : "、品牌（如果知道）"}、大约购买时间，以及目前出现的情况。`;\n  }\n  return known + `請告訴我${hasApplianceType ? "更具體是哪一類家用電器" : "是哪一類家用電器"}${hasBrand ? "" : "、品牌（如果知道）"}、大約購買時間，以及目前出現的情況。`;\n}\n\n'''
    s = s[:pos] + helper + s[pos:]
intel.write_text(s)

s = gen.read_text()
old_import = 'buildCustomerAdvisoryContext, buildCustomerContextAcknowledgement, classifyConversationTurn'
new_import = 'buildCustomerAdvisoryContext, buildCustomerContextAcknowledgement, buildCustomerContextRequirementsResponse, classifyConversationTurn'
if new_import not in s:
    assert old_import in s
    s = s.replace(old_import, new_import, 1)

old = '''  if (_canonicalTurn.operation === "CUSTOMER_CONTEXT_UPDATE") {\n    const acknowledgement = buildCustomerContextAcknowledgement(_canonicalTurn.language);'''
new = '''  if (_canonicalTurn.operation === "CUSTOMER_CONTEXT_UPDATE") {\n    const acknowledgement = _canonicalTurn.reason === "customer_context_requirements_request"\n      ? buildCustomerContextRequirementsResponse(_canonicalTurn.language, _pr5HistoryRows ?? [])\n      : buildCustomerContextAcknowledgement(_canonicalTurn.language);'''
if 'buildCustomerContextRequirementsResponse(_canonicalTurn.language' not in s:
    assert old in s
    s = s.replace(old, new, 1)

gen.write_text(s)
print('TASK4_1_CONTEXT_REQUIREMENTS=APPLIED')