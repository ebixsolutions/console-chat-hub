#!/usr/bin/env python3
from pathlib import Path

p = Path('supabase/functions/_shared/conversation-runtime-state.ts')
s = p.read_text()
old = '''  const previousAssistantMemory = priorRows.find((row) => {\n    const role = String(row.role ?? "").toLowerCase();\n    return ASSISTANT.has(role) && metadataRecord(row.metadata)?.response_route === "conversation_memory";\n  });\n  const previousCurrentContextQuestion = priorRows.find((row) => {\n    const role = String(row.role ?? "").toLowerCase();\n    return CUSTOMER.has(role) && currentContextPattern.test(clean(row.content));\n  });\n  const memoryLanguageContinuation = Boolean(previousAssistantMemory && previousCurrentContextQuestion) &&\n    /(?:answer|say|repeat).*(?:same|that).*(?:english|chinese|cantonese)|(?:same|that).*(?:in|into)\\s+(?:english|chinese|cantonese)|(?:回到|改用|用)\\s*(?:繁體中文|繁体中文|簡體中文|简体中文|英文|廣東話|广东话)/i.test(latest);\n'''
new = '''  const languageContinuationPattern = /(?:answer|say|repeat).*(?:same|that).*(?:english|chinese|cantonese)|(?:same|that).*(?:in|into)\\s+(?:english|chinese|cantonese)|(?:回到|改用|用)\\s*(?:繁體中文|繁体中文|簡體中文|简体中文|英文|廣東話|广东话)/i;\n  // A language-only continuation of the deterministic current region/item answer\n  // must not depend on assistant metadata surviving an async cross-turn boundary.\n  // Authorize it only when the two most recent PRIOR customer turns contain the\n  // current-context question itself or an immediately chained language continuation.\n  const recentPriorCustomerTurns = priorRows\n    .filter((row) => CUSTOMER.has(String(row.role ?? "").toLowerCase()))\n    .map((row) => clean(row.content))\n    .filter(Boolean)\n    .slice(0, 2);\n  const hasRecentCurrentContextQuestion = recentPriorCustomerTurns.some((text) => currentContextPattern.test(text));\n  const hasChainedLanguageContinuation = recentPriorCustomerTurns.length >= 2 &&\n    languageContinuationPattern.test(recentPriorCustomerTurns[0]) &&\n    currentContextPattern.test(recentPriorCustomerTurns[1]);\n  const memoryLanguageContinuation = languageContinuationPattern.test(latest) &&\n    (hasRecentCurrentContextQuestion || hasChainedLanguageContinuation);\n'''
count = s.count(old)
if count != 1:
    raise SystemExit(f'PATCH_EXPECTED_ONCE count={count}')
s = s.replace(old, new, 1)
p.write_text(s)
print('DIRECTOR_TASK2_MEMORY_CONTINUATION_PATCH=PASS')
