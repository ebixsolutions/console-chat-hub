#!/usr/bin/env python3
from pathlib import Path

p = Path('supabase/functions/_shared/conversation-runtime-state.ts')
s = p.read_text()
original = s

def replace_once(old: str, new: str) -> None:
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'PATCH_EXPECTED_ONCE count={count}: {old[:120]!r}')
    s = s.replace(old, new, 1)

replace_once(
'''  jurisdiction: string | null;\n  language: RuntimeLanguage;''',
'''  jurisdiction: string | null;\n  current_item: string | null;\n  language: RuntimeLanguage;''')

replace_once(
'''function clean(v: unknown): string {\n  return typeof v === "string" ? v.replace(/\\s+/g, " ").trim().slice(0, 800) : "";\n}\nfunction detectLanguage(text: string): RuntimeLanguage {''',
'''function clean(v: unknown): string {\n  return typeof v === "string" ? v.replace(/\\s+/g, " ").trim().slice(0, 800) : "";\n}\nfunction metadataRecord(value: unknown): Record<string, unknown> | null {\n  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;\n}\nfunction hasGroundedLineage(metadata: unknown): boolean {\n  const meta = metadataRecord(metadata);\n  const lineage = metadataRecord(meta?.citation_lineage);\n  return typeof lineage?.selected_document_id === "string" &&\n    Array.isArray(lineage?.evidence_chunk_ids) &&\n    lineage.evidence_chunk_ids.some((x) => typeof x === "string" && x.length > 0);\n}\nfunction detectFocusedItem(text: string): string | null {\n  const t = clean(text);\n  const focus = t.match(/(?:只(?:說|说|講|讲)|只要|聚焦|focus(?: only)? on)\\s*([^，。,.!?！？]{1,40}?)(?:相關|相关|部分|內容|内容|\\s+only|$)/i);\n  const raw = focus?.[1]?.trim().replace(/^(?:在|關於|关于|the)\\s*/i, "") ?? "";\n  return raw && raw.length <= 40 ? raw : null;\n}\nfunction detectCorrectedItem(text: string): string | null {\n  const m = clean(text).match(/(?:問的是|問嘅係|问的是|其實係|其实是|改成)\\s*([^，。,.!?！？]{1,40})/i);\n  if (!m?.[1]) return null;\n  return m[1].replace(/(?:，|,)?\\s*(?:不是|唔係|not)\\s+.*$/i, "").trim() || null;\n}\nfunction localizedCurrentItem(item: string, lang: RuntimeLanguage): string {\n  const normalized = clean(item).toLowerCase();\n  const airConditioner = /(?:冷氣機|冷气机|空調機|空调机|air[- ]?conditioner|aircon)/i.test(normalized);\n  if (!airConditioner) return item;\n  if (lang === "en") return "air conditioner";\n  if (lang === "zh-CN") return "空调机";\n  return "冷氣機";\n}\nfunction detectLanguage(text: string): RuntimeLanguage {''')

replace_once(
'''      text: clean(row.content),\n      role: String(row.role ?? "").toLowerCase(),\n    }))''',
'''      text: clean(row.content),\n      role: String(row.role ?? "").toLowerCase(),\n      metadata: row.metadata,\n    }))''')

replace_once(
'''  const inheritedJurisdiction = customers.map((row) => detectExplicitJurisdiction(row.text)).find(Boolean) ?? null;''',
'''  const inheritedJurisdiction = customers.map((row) => detectExplicitJurisdiction(row.text)).find(Boolean) ?? null;\n  const groundedAssistantJurisdiction = assistants\n    .filter((row) => hasGroundedLineage(row.metadata))\n    .map((row) => detectExplicitJurisdiction(row.text))\n    .find(Boolean) ?? null;\n  const correctedItem = corrections.map((text) => detectCorrectedItem(text)).find(Boolean) ?? null;\n  const focusedItem = customers.map((row) => detectFocusedItem(row.text)).find(Boolean) ?? null;''')

replace_once(
'''    jurisdiction: explicitJurisdiction ?? inheritedJurisdiction,\n    language: detectLanguage(latest ?? first ?? ""),''',
'''    jurisdiction: explicitJurisdiction ?? inheritedJurisdiction ?? groundedAssistantJurisdiction,\n    current_item: correctedItem ?? focusedItem,\n    language: detectLanguage(latest ?? first ?? ""),''')

replace_once(
'''    `Prior grounded document: ${state.prior_grounded_document_id ?? "—"}`,\n    `Current topic: ${state.current_topic ?? "—"}`,\n    `Jurisdiction: ${state.jurisdiction ?? "unspecified"}`,''',
'''    `Prior grounded document: ${state.prior_grounded_document_id ?? "—"}`,\n    `Current topic: ${state.current_topic ?? "—"}`,\n    `Jurisdiction: ${state.jurisdiction ?? "unspecified"}`,\n    `Current item: ${state.current_item ?? "unspecified"}`,''')

replace_once(
'''  const currentContextRequest = /(我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\\x27s| is)?\\s+(?:the\\s+)?(?:current\\s+)?(?:region|jurisdiction).*(?:item|product))/i.test(latest);''',
'''  const currentContextPattern = /(我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\\x27s| is)?\\s+(?:the\\s+)?(?:current\\s+)?(?:region|jurisdiction).*(?:item|product))/i;\n  const previousAssistantMemory = priorRows.find((row) => {\n    const role = String(row.role ?? "").toLowerCase();\n    return ASSISTANT.has(role) && metadataRecord(row.metadata)?.response_route === "conversation_memory";\n  });\n  const previousCurrentContextQuestion = priorRows.find((row) => {\n    const role = String(row.role ?? "").toLowerCase();\n    return CUSTOMER.has(role) && currentContextPattern.test(clean(row.content));\n  });\n  const memoryLanguageContinuation = Boolean(previousAssistantMemory && previousCurrentContextQuestion) &&\n    /(?:answer|say|repeat).*(?:same|that).*(?:english|chinese|cantonese)|(?:same|that).*(?:in|into)\\s+(?:english|chinese|cantonese)|(?:回到|改用|用)\\s*(?:繁體中文|繁体中文|簡體中文|简体中文|英文|廣東話|广东话)/i.test(latest);\n  const currentContextRequest = currentContextPattern.test(latest) || memoryLanguageContinuation;''')

replace_once(
'''    const correction = state.latest_corrections[0] ?? "";\n    const itemMatch = correction.match(/(?:問的是|問嘅係|问的是|其實係|其实是|改成)\\s*([^，。,.!?！？]{1,40})/i);\n    const item = itemMatch?.[1]?.trim() ?? "";\n    if (!region || !item) return t.none;\n    if (lang === "en") return `Your current region is ${region}, and the current item is ${item}.`;\n    if (lang === "zh-CN") return `你现在问的是${region}的${item}。`;\n    return `你現在問的是${region}的${item}。`;''',
'''    const item = state.current_item ? localizedCurrentItem(state.current_item, lang) : "";\n    if (!region || !item) return t.none;\n    if (lang === "en") return `Your current region is ${region}, and the current item is ${item}.`;\n    if (lang === "zh-CN") return `你现在问的是${region}的${item}。`;\n    return `你現在問的是${region}的${item}。`;''')

if s == original:
    raise SystemExit('PATCH_NO_CHANGES')
p.write_text(s)
print('DIRECTOR_TASK2_CURRENT_CONTEXT_PATCH=PASS')
