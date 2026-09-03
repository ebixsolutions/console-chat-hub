from pathlib import Path

SEM = Path('supabase/functions/_shared/conversation-semantic-contract.ts')
STATE = Path('supabase/functions/_shared/conversation-runtime-state.ts')

CURRENT_CONTEXT_FRAGMENT = r'|我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\x27s| is)?\s+(?:the\s+)?(?:current\s+)?(?:region|jurisdiction).*(?:item|product)'


def patch_semantic_memory_regex(text: str) -> str:
    marker = r'|what.*still\s+missing/i;'
    if CURRENT_CONTEXT_FRAGMENT in text:
        return text
    if marker not in text:
        raise SystemExit('STOP: semantic MEMORY regex marker not found')
    return text.replace(marker, CURRENT_CONTEXT_FRAGMENT + marker, 1)


def patch_runtime_memory_regex(text: str) -> str:
    marker = r'|summari[sz]e.*(?:conversation|discussed|talked))/i;'
    if CURRENT_CONTEXT_FRAGMENT in text:
        return text
    if marker not in text:
        raise SystemExit('STOP: runtime MEMORY regex marker not found')
    return text.replace(marker, CURRENT_CONTEXT_FRAGMENT + marker, 1)


def patch_state(text: str) -> str:
    text = patch_runtime_memory_regex(text)
    if 'const currentContextRequest =' not in text:
        needle = '  const locationRequest = /(我(?:現在|现在|目前).*(?:哪裡|哪里)|我.*(?:在哪|喺邊)|where\\s+am\\s+i|my\\s+(?:current\\s+)?location|更正後.*(?:地點|地点)|更正后.*(?:地點|地点))/i.test(latest);\n'
        replacement = needle + '  const currentContextRequest = /(我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\\x27s| is)?\\s+(?:the\\s+)?(?:current\\s+)?(?:region|jurisdiction).*(?:item|product))/i.test(latest);\n'
        if needle not in text:
            raise SystemExit('STOP: locationRequest insertion point not found')
        text = text.replace(needle, replacement, 1)

    old_gate = '  if (!(firstRequest || correctionRequest || constraintRequest || summaryRequest || recommendationRequest || providedMissingRequest || generalSummaryRequest || nameRequest || locationRequest)) return null;'
    new_gate = '  if (!(firstRequest || correctionRequest || constraintRequest || summaryRequest || recommendationRequest || providedMissingRequest || generalSummaryRequest || nameRequest || locationRequest || currentContextRequest)) return null;'
    if old_gate in text:
        text = text.replace(old_gate, new_gate, 1)
    elif new_gate not in text:
        raise SystemExit('STOP: memory request gate not found')

    if 'if (currentContextRequest) {' not in text:
        needle = '  if (locationRequest) {\n'
        block = '''  if (currentContextRequest) {\n    const label: Record<string, Record<RuntimeLanguage,string>> = {\n      hong_kong:{"zh-TW":"香港","zh-CN":"香港",en:"Hong Kong"}, macau:{"zh-TW":"澳門","zh-CN":"澳门",en:"Macau"}, singapore:{"zh-TW":"新加坡","zh-CN":"新加坡",en:"Singapore"}, taiwan:{"zh-TW":"台灣","zh-CN":"台湾",en:"Taiwan"}, mainland_china:{"zh-TW":"中國大陸","zh-CN":"中国大陆",en:"Mainland China"}, mars:{"zh-TW":"火星","zh-CN":"火星",en:"Mars"}\n    };\n    const region = state.jurisdiction ? label[state.jurisdiction]?.[lang] : undefined;\n    const correction = state.latest_corrections[0] ?? "";\n    const itemMatch = correction.match(/(?:問的是|問嘅係|问的是|其實係|其实是|改成)\\s*([^，。,.!?！？]{1,40})/i);\n    const item = itemMatch?.[1]?.trim() ?? "";\n    if (!region || !item) return t.none;\n    if (lang === "en") return `Your current region is ${region}, and the current item is ${item}.`;\n    if (lang === "zh-CN") return `你现在问的是${region}的${item}。`;\n    return `你現在問的是${region}的${item}。`;\n  }\n'''
        if needle not in text:
            raise SystemExit('STOP: location response insertion point not found')
        text = text.replace(needle, block + needle, 1)
    return text


sem = SEM.read_text()
state = STATE.read_text()
new_sem = patch_semantic_memory_regex(sem)
new_state = patch_state(state)
SEM.write_text(new_sem)
STATE.write_text(new_state)

assert 'currentContextRequest' in new_state
assert 'current region' in new_state
assert CURRENT_CONTEXT_FRAGMENT in new_sem
assert CURRENT_CONTEXT_FRAGMENT in new_state
print('TASK4_1_CURRENT_CONTEXT_MEMORY_PATCH=PASS')
